#!/usr/bin/env bun
// crawl-sweep.ts — the bun orchestrator behind the `--no-agent` catalogue-crawl cron
// (`fluncle-crawl`).
//
// Version-controlled source; the repo is canonical and the box is a deploy target
// (fluncle-hermes-operator skill). Invoked by the bash wrapper (crawl-sweep.sh) the host
// timer execs on a schedule — see that file's header for the wire-up and
// ../cron/README.md for the cron model.
//
// THE WORKER-PACED MODEL (the `fluncle-backfill` shape, verbatim). The box holds no
// vendor identity and no MusicBrainz budget; the Worker does. So the crawl's HTTP work
// happens IN THE WORKER — this driver just PACES it, one bounded pass per tick via the
// `fluncle` CLI. The Worker carries the durable frontier (the `crawl_frontier` table),
// the ~1 req/s MusicBrainz gate, the Retry-After backoff, and the circuit breaker; the
// driver stays dumb: run one pass, ship the summary, let the next tick resume.
//
// WHY THAT MATTERS HERE MORE THAN ANYWHERE ELSE. A catalogue crawl is a MARATHON — the
// neighbourhood of one seed label is hundreds of releases at one request per second. It
// is not something a process finishes; it is something a schedule finishes. Every scrap
// of state is in the database, so "run again" and "resume" are the same command, and a
// box reboot mid-label costs one node, not one crawl.
//
// It certifies nothing: a crawled track is a `tracks` row with no `findings` row, so it
// has no Log ID, no note, no video, no galaxy, no place on any public surface. And it
// captures no audio. See docs/catalogue-crawler.md.
//
// Zero LLM tokens. Pure HTTP driving.
//
// stdout: one JSON summary line (the cron run output). Diagnostics → stderr.

import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Config. One tick expands NODES frontier nodes, each ~1 paced MusicBrainz request, so
// 10 ≈ a 12s tick — well inside the cron's timeout with room for a retried 503. The
// cadence (crawl-sweep.sh's timer) is what actually sizes the crawl; the batch just has
// to be small enough that a tick always finishes cleanly.
// ---------------------------------------------------------------------------

const NODES = Number(process.env.FLUNCLE_CRAWL_NODES ?? "10");

// The ratified boundary gate: hop 0 = a release on an enabled seed label, hop 1 = an
// artist on it, hop 2 = a release that artist also appears on, then STOP.
const MAX_HOP = Number(process.env.FLUNCLE_CRAWL_MAX_HOP ?? "2");

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";

const log = (message: string) => console.error(`[crawl-sweep] ${message}`);

// ---------------------------------------------------------------------------
// Types — only the fields we consume from the crawl summary.
// ---------------------------------------------------------------------------

type CrawlSummary = {
  anchorsFilled?: number;
  expanded?: number;
  failed?: number;
  frontierPending?: number;
  labelsDiscovered?: string[];
  ok?: boolean;
  // True when MusicBrainz is actively throttling us and the pass stopped on the circuit
  // breaker — a throttled tick, not a drained frontier. Surfaced so the cron output reads
  // honestly instead of looking like a silent "0 expanded" no-op.
  rateLimited?: boolean;
  seeded?: number;
  tracksFound?: number;
  tracksSkipped?: number;
  tracksWritten?: number;
};

// ---------------------------------------------------------------------------
// Shell helper — synchronous, fail-loud where it matters. (Same contract as
// backfill-sweep's: a partial batch exits 1 but still prints its JSON summary, and that
// summary must be RECORDED, not discarded as a crash.)
// ---------------------------------------------------------------------------

export function fluncleJson<T>(args: string[]): T {
  const result = spawnSync(FLUNCLE_BIN, [...args, "--json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error) {
    throw new Error(`failed to spawn ${FLUNCLE_BIN}: ${result.error.message}`);
  }

  const code = result.status ?? 1;
  const stdout = result.stdout ?? "";

  let parsed: unknown;

  try {
    parsed = JSON.parse(stdout);
  } catch {
    if (code !== 0) {
      throw new Error(`fluncle ${args.join(" ")} exited ${code}: ${(result.stderr ?? "").trim()}`);
    }

    throw new Error(`fluncle ${args.join(" ")} did not return JSON: ${stdout.slice(0, 200)}`);
  }

  if (code !== 0 && isCliErrorPayload(parsed)) {
    throw new Error(`fluncle ${args.join(" ")} failed (${parsed.code}): ${parsed.message}`);
  }

  return parsed as T;
}

// The CLI's own failure payload (`{ code, message, ok: false }` — validation, auth, or
// network errors). Distinguishable from a crawl summary, which carries no `code`/`message`
// pair and keeps its counts alongside `ok`.
function isCliErrorPayload(value: unknown): value is { code: string; message: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { ok?: unknown }).ok === false &&
    typeof (value as { code?: unknown }).code === "string" &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

// ---------------------------------------------------------------------------
// Main — ONE bounded pass. Deliberately not a loop: the frontier is the worklist and the
// timer is the loop. A tick that finds a drained frontier is a cheap no-op.
// ---------------------------------------------------------------------------

export function main(): void {
  const summary = {
    anchorsFilled: 0,
    error: null as string | null,
    expanded: 0,
    failed: 0,
    // Labels the walk DISCOVERED and minted as `undecided`. They are NOT crawled — they
    // land in the operator's attention queue for him to rule on. The crawler proposes.
    labelsDiscovered: [] as string[],
    ok: true,
    pending: 0,
    throttled: false,
    tracksFound: 0,
    tracksSkipped: 0,
    tracksWritten: 0,
  };

  try {
    const pass = fluncleJson<CrawlSummary>([
      "admin",
      "catalogue",
      "crawl",
      "--limit",
      String(NODES),
      "--max-hop",
      String(MAX_HOP),
    ]);

    summary.anchorsFilled = pass.anchorsFilled ?? 0;
    summary.expanded = pass.expanded ?? 0;
    summary.failed = pass.failed ?? 0;
    summary.labelsDiscovered = pass.labelsDiscovered ?? [];
    summary.pending = pass.frontierPending ?? 0;
    summary.throttled = pass.rateLimited ?? false;
    summary.tracksFound = pass.tracksFound ?? 0;
    summary.tracksWritten = pass.tracksWritten ?? 0;
    summary.tracksSkipped = pass.tracksSkipped ?? 0;

    if (summary.throttled) {
      log("MusicBrainz throttled the pass — stopped clean; the next tick resumes.");
    }

    if (summary.labelsDiscovered.length > 0) {
      log(`new labels to rule on: ${summary.labelsDiscovered.join(", ")}`);
    }
  } catch (error) {
    summary.ok = false;
    summary.error = error instanceof Error ? error.message : String(error);
    log(`crawl pass failed: ${summary.error}`);
  }

  console.log(JSON.stringify(summary));

  if (!summary.ok) {
    process.exit(1);
  }
}

// The cron runs this file directly; the guard keeps importing `fluncleJson` for the
// tests (crawl-sweep.test.ts) side-effect free.
if (import.meta.main) {
  main();
}
