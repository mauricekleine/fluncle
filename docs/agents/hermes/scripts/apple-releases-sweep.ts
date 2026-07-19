#!/usr/bin/env bun
// apple-releases-sweep.ts — the bun orchestrator behind the `--no-agent` MusicKit freshness tap
// cron (`fluncle-apple-releases`), D8.
//
// Version-controlled source; the repo is canonical and the box is a deploy target
// (fluncle-hermes-operator skill). Invoked by the bash wrapper (apple-releases-sweep.sh) the host
// timer execs on a schedule — see that file's header for the wire-up and ../cron/README.md.
//
// THE FRESHNESS FEED. The catalogue crawler walks MusicBrainz's graph, but MusicBrainz lags a
// release by ~2 weeks. Apple Music has it on day one. So this taps Apple's latest releases for
// every ENABLED seed label and mints the day-one catalogue rows the crawl has not reached yet —
// closing the lag cliff on /fresh. It certifies nothing, publishes nothing, and never widens the
// graph (no new labels, no artist hops): catalogue METADATA only.
//
// THE WORKER-PACED MODEL (the `fluncle-cover-masters` shape, verbatim). The Worker resolves each
// label's Apple id (exact-fold only), taps its latest releases, and mints the deduped rows; this
// driver just PACES it, ONE bounded probe per tick. The `fluncle` CLI loops passes internally until
// every enabled label is fresh this window (or the shared 18/min Apple budget is spent). The Worker
// carries the durable per-label reliability state + the cross-cutting breaker. Zero LLM tokens.
//
// stdout: one JSON summary line (the cron run output). Diagnostics → stderr.

import { spawnSync } from "node:child_process";

// Enabled seed labels probed per PASS. The CLI loops passes internally, so this is just the
// per-pass cap (kept small so one pass stays well inside the shared Apple call budget). Env-tunable
// on the box for a one-off wider sweep.
const LABELS_PER_PASS = Number(process.env.FLUNCLE_APPLE_RELEASES_LABELS ?? "5");

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";

const log = (message: string) => console.error(`[apple-releases-sweep] ${message}`);

type AppleReleasesSummary = {
  breakerTripped?: boolean;
  configured?: boolean;
  labelsProbed?: number;
  newRows?: number;
  ok?: boolean;
  rateLimited?: boolean;
  resolvedLabels?: string[];
  skippedKnown?: number;
  unresolvedLabels?: string[];
};

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

function isCliErrorPayload(value: unknown): value is { code: string; message: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { ok?: unknown }).ok === false &&
    typeof (value as { code?: unknown }).code === "string" &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

function probe(): AppleReleasesSummary {
  return fluncleJson<AppleReleasesSummary>([
    "admin",
    "backfills",
    "apple-releases",
    "--limit",
    String(LABELS_PER_PASS),
  ]);
}

// ONE bounded probe per tick (the CLI loops passes internally). Deliberately not a loop over ticks:
// the enabled seed labels ARE the worklist and the daily timer is the loop. A tick that finds every
// label already fresh this window is a cheap no-op. An UNCONFIGURED Worker (no MusicKit secrets)
// reports `configured:false` and this stays a clean success — the tap ships DARK.
export function main(): void {
  const summary = {
    error: null as string | null,
    labelsProbed: 0,
    newRows: 0,
    ok: true,
    resolvedLabels: 0,
    skippedKnown: 0,
    unresolvedLabels: 0,
  };

  try {
    const pass = probe();
    summary.labelsProbed = pass.labelsProbed ?? 0;
    summary.newRows = pass.newRows ?? 0;
    summary.skippedKnown = pass.skippedKnown ?? 0;
    summary.resolvedLabels = pass.resolvedLabels?.length ?? 0;
    summary.unresolvedLabels = pass.unresolvedLabels?.length ?? 0;

    if (pass.configured === false) {
      log("Worker MusicKit secrets are unset — the freshness tap is a no-op (shipping dark).");
    }
  } catch (error) {
    summary.ok = false;
    summary.error = error instanceof Error ? error.message : String(error);
    log(`apple-releases probe failed: ${summary.error}`);
  }

  console.log(JSON.stringify(summary));

  if (!summary.ok) {
    process.exit(1);
  }
}

// The cron runs this file directly; the guard keeps importing `fluncleJson` for the tests
// (apple-releases-sweep.test.ts) side-effect free.
if (import.meta.main) {
  main();
}
