#!/usr/bin/env bun
// label-images-sweep.ts — the bun orchestrator behind the `--no-agent` label-image resolve
// cron (`fluncle-label-images`).
//
// Version-controlled source; the repo is canonical and the box is a deploy target
// (fluncle-hermes-operator skill). Invoked by the bash wrapper (label-images-sweep.sh) the host
// timer execs on a schedule — see that file's header for the wire-up and ../cron/README.md for
// the cron model.
//
// THE DURABLE OTHER HALF OF THE LABEL ENTITY. The catalogue crawl (`fluncle-crawl`) MINTS new
// labels every few minutes, each landing at `image_state='pending'`. Nothing resolved them until
// this sweep: it gives every pending label its OWN logo instead of a borrowed album cover. The
// one-shot `fluncle admin backfills label-images` operator run seeded the existing archive; this
// cron keeps the freshly-minted ones from sitting pending forever. Same op, now on a schedule.
//
// THE WORKER-PACED MODEL (the `fluncle-backfill`/`fluncle-crawl` shape, verbatim). The box holds
// NO Discogs vendor key and no MusicBrainz budget; the Worker does. So the resolve walk
// (MusicBrainz label search → its curated Discogs/Wikidata url-rels → download the logo once into
// R2) happens IN THE WORKER — this driver just PACES it, one small bounded batch per tick via the
// `fluncle` CLI. The Worker carries the durable per-label reliability state (`image_state` /
// `image_attempted_at` / `image_failures`), the ~1 req/s MusicBrainz gate, the authed Discogs gate,
// and the rate-limit circuit breaker; the driver stays dumb: run one bounded batch, ship the
// summary, let the next tick resume from the durable state.
//
// A small `--limit` per tick is deliberate: Discogs is rate-limited 1 req/s and the CLI's
// circuit breaker STOPS the pass the moment a vendor throttles, so a tight batch keeps every tick
// well inside the cron timeout and never marches the next label into the same 429 wall. The crawl
// mints only tens of labels/day, so an hourly cadence (see label-images-sweep.sh) drains the
// worklist with room to spare; a tick that finds it drained is a cheap no-op. It resolves only a
// label's METADATA logo — it certifies nothing and publishes nothing (agent tier, the
// `backfill_discogs` precedent). Zero LLM tokens. Pure HTTP driving.
//
// stdout: one JSON summary line (the cron run output). Diagnostics → stderr.

import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Config — a small bounded batch per tick. The CLI loops the slug cursor internally up to this
// cap (or until the worklist drains, or a vendor throttles), and each label costs a few
// serialized ~1.1s rate-limited Worker calls, so 6 ≈ under a minute — comfortably inside the
// cron's timeout. The Worker itself clamps a single pass to `MAX_BATCH` (4) labels regardless.
// ---------------------------------------------------------------------------

// 4 = the server op's MAX_BATCH, so one tick is EXACTLY ONE HTTP request. The CLI's cursor
// loop fires a SECOND request when the server clamps below the asked limit, and a second
// request on the CLI's kept-alive connection after a LONG first response hangs to the 5-minute
// fetch timeout (the 2026-07-19/20 label-images outage; same matrix as the lineage saga —
// fresh connections resolved in seconds while the box tick died). Single-request ticks
// sidestep connection reuse entirely; the hourly cadence still clears ~96 labels/day.
const BATCH_LIMIT = Number(process.env.FLUNCLE_LABEL_IMAGES_LIMIT ?? "4");

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";

const log = (message: string) => console.error(`[label-images-sweep] ${message}`);

// ---------------------------------------------------------------------------
// Types — only the fields we consume from the label-image resolve summary.
// ---------------------------------------------------------------------------

type LabelImagesSummary = {
  failedCount?: number;
  // Labels floored to `none` — no own image on Discogs or Wikidata, so the surfaces keep the
  // freshest finding's cover. A clean outcome, not a failure.
  noneCount?: number;
  ok?: boolean;
  // True when the pass STOPPED on a vendor rate-limit circuit breaker (MusicBrainz/Discogs) — a
  // throttled tick, not a drained worklist. Surfaced so the cron output reads honestly instead of
  // looking like a silent "0 resolved" no-op.
  rateLimited?: boolean;
  resolvedCount?: number;
};

// ---------------------------------------------------------------------------
// Shell helper — synchronous, fail-loud where it matters. (Same contract as
// crawl-sweep's/backfill-sweep's: a partial batch exits 1 but still prints its JSON summary, and
// that summary must be RECORDED, not discarded as a crash.)
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

// The CLI's own failure payload (`{ code, message, ok: false }` — validation, auth, or network
// errors). Distinguishable from a resolve summary, which carries no `code`/`message` pair and
// keeps its counts alongside `ok`.
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
// Main — ONE bounded batch. Deliberately not a loop: the `labels` worklist is the worklist and
// the timer is the loop. A tick that finds every label already resolved/none is a cheap no-op.
// ---------------------------------------------------------------------------

export function main(): void {
  const summary = {
    error: null as string | null,
    failed: 0,
    // Labels floored to the cover (no own logo anywhere) — a clean outcome, terminal.
    none: 0,
    ok: true,
    resolved: 0,
    throttled: false,
  };

  try {
    const pass = fluncleJson<LabelImagesSummary>([
      "admin",
      "backfills",
      "label-images",
      "--limit",
      String(BATCH_LIMIT),
    ]);

    summary.resolved = pass.resolvedCount ?? 0;
    summary.none = pass.noneCount ?? 0;
    summary.failed = pass.failedCount ?? 0;
    summary.throttled = pass.rateLimited ?? false;

    if (summary.throttled) {
      log("a vendor throttled the pass — stopped clean; the next tick resumes.");
    }
  } catch (error) {
    summary.ok = false;
    summary.error = error instanceof Error ? error.message : String(error);
    log(`label-image resolve pass failed: ${summary.error}`);
  }

  console.log(JSON.stringify(summary));

  if (!summary.ok) {
    process.exit(1);
  }
}

// The cron runs this file directly; the guard keeps importing `fluncleJson` for the tests
// (label-images-sweep.test.ts) side-effect free.
if (import.meta.main) {
  main();
}
