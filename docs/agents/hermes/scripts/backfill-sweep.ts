#!/usr/bin/env bun
// backfill-sweep.ts — the bun orchestrator behind the `--no-agent` catalogue-backfill
// cron (`fluncle-backfill`).
//
// LIVE. Version-controlled source; the repo is canonical and the box is a
// deploy target (fluncle-hermes-operator skill). Invoked by the bash wrapper
// (backfill-sweep.sh) the cron runner execs on a schedule — see that file's header
// for the `hermes cron create` wire-up and ../cron/README.md for the cron model.
//
// THE WORKER-PACED MODEL. The box holds NO Discogs/Last.fm vendor keys (those live
// in the Worker). So the backfill API calls happen IN THE WORKER; this box driver
// just PACES it — one small, bounded batch per tick via the `fluncle` CLI. The
// Worker carries the reliability state (per-finding cooldown/done columns) and the
// Retry-After backoff, so this driver stays dumb: drive a bounded `--limit` of each
// source, ship the summary, and let the next tick resume from the durable state.
// Pure HTTP driving, zero LLM tokens.
//
// The loop, idempotent by construction (the Worker skips already-done + cooling-down
// findings server-side), fast no-op once the catalogue is drained:
//
//   1. `fluncle admin backfills discogs --limit <N> --json`  → one paced batch.
//   2. `fluncle admin backfills lastfm  --limit <N> --json`  → one paced batch.
//
// stdout: one JSON summary line (the cron run output). Diagnostics → stderr.

import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Config — a small bounded batch per source per tick so one tick stays well
// inside both the Worker request budget and the cron's 120s timeout. The Worker
// clamps each request to a 3-finding server pass AND stops the run (signalling the
// CLI to stop looping the cursor) the moment the vendor rate-limit circuit breaker
// trips — so a throttled tick bails after one short pass instead of grinding the
// cursor back into the same 429 wall for 300s+ (the timeout that errored this cron
// every tick). With that bail in place, 3 = exactly one server pass per source
// (~36s worst case for Discogs: ~10 paced ~1.1s lookups per unresolved finding),
// leaving wide headroom under the 120s timeout. The 30-minute cadence (see
// backfill-sweep.sh) lets the per-minute vendor budget recover between ticks; the
// reliability cooldown keeps a drained catalogue quiet.
// ---------------------------------------------------------------------------

const BATCH_LIMIT = Number(process.env.FLUNCLE_BACKFILL_LIMIT ?? "3");

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";

const log = (message: string) => console.error(`[backfill-sweep] ${message}`);

// ---------------------------------------------------------------------------
// Types — only the fields we consume from each backfill summary.
// ---------------------------------------------------------------------------

type DiscogsSummary = {
  ok?: boolean;
  // True when the sweep bailed early because Discogs is actively rate-limiting (the
  // circuit breaker) — a throttled tick, not a drained catalogue. Surfaced so the
  // cron output reads honestly instead of looking like a silent "0 resolved" no-op.
  rateLimited?: boolean;
  resolvedCount?: number;
  skippedCount?: number;
  unresolvedCount?: number;
};

type LastfmSummary = {
  failedCount?: number;
  lovedCount?: number;
  ok?: boolean;
  rateLimited?: boolean;
  skippedCount?: number;
};

// ---------------------------------------------------------------------------
// Shell helper — synchronous, fail-loud where it matters.
// ---------------------------------------------------------------------------

function fluncleJson<T>(args: string[]): T {
  const result = spawnSync(FLUNCLE_BIN, [...args, "--json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error) {
    throw new Error(`failed to spawn ${FLUNCLE_BIN}: ${result.error.message}`);
  }

  const code = result.status ?? 1;
  const stdout = result.stdout ?? "";

  if (code !== 0) {
    throw new Error(`fluncle ${args.join(" ")} exited ${code}: ${(result.stderr ?? "").trim()}`);
  }

  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error(`fluncle ${args.join(" ")} did not return JSON: ${stdout.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Main — drive one bounded batch of each source. A failure of one source must
// not abort the other; each is independently best-effort.
// ---------------------------------------------------------------------------

function main(): void {
  const summary = {
    discogs: {
      error: null as string | null,
      resolved: 0,
      skipped: 0,
      throttled: false,
      unresolved: 0,
    },
    lastfm: { error: null as string | null, failed: 0, loved: 0, skipped: 0, throttled: false },
    ok: true,
  };

  const limit = ["--limit", String(BATCH_LIMIT)];

  try {
    const discogs = fluncleJson<DiscogsSummary>(["admin", "backfills", "discogs", ...limit]);
    summary.discogs.resolved = discogs.resolvedCount ?? 0;
    summary.discogs.unresolved = discogs.unresolvedCount ?? 0;
    summary.discogs.skipped = discogs.skippedCount ?? 0;
    summary.discogs.throttled = discogs.rateLimited ?? false;
  } catch (error) {
    summary.discogs.error = error instanceof Error ? error.message : String(error);
    log(`discogs backfill failed: ${summary.discogs.error}`);
  }

  try {
    const lastfm = fluncleJson<LastfmSummary>(["admin", "backfills", "lastfm", ...limit]);
    summary.lastfm.loved = lastfm.lovedCount ?? 0;
    summary.lastfm.failed = lastfm.failedCount ?? 0;
    summary.lastfm.skipped = lastfm.skippedCount ?? 0;
    summary.lastfm.throttled = lastfm.rateLimited ?? false;
  } catch (error) {
    summary.lastfm.error = error instanceof Error ? error.message : String(error);
    log(`lastfm backfill failed: ${summary.lastfm.error}`);
  }

  console.log(JSON.stringify(summary));
}

main();
