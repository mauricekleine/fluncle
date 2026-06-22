#!/usr/bin/env bun
// backfill-sweep.ts — the bun orchestrator behind the `--no-agent` catalogue-backfill
// cron (`fluncle-backfill`).
//
// PREPARED. Version-controlled source; the repo is canonical and the box is a
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
// inside both the Worker request budget and the vendor rate budget. The Worker
// clamps each request to a 3-finding server pass; the CLI loops the cursor up to
// this `--limit` of HANDLED findings, so 6 ≈ two server passes (~70s worst case
// for Discogs: ~10 paced ~1.1s lookups per unresolved finding). The 30-minute
// cadence (see backfill-sweep.sh) lets the per-minute vendor budget fully recover
// between ticks; the reliability cooldown keeps a drained catalogue quiet.
// ---------------------------------------------------------------------------

const BATCH_LIMIT = Number(process.env.FLUNCLE_BACKFILL_LIMIT ?? "6");

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";

const log = (message: string) => console.error(`[backfill-sweep] ${message}`);

// ---------------------------------------------------------------------------
// Types — only the fields we consume from each backfill summary.
// ---------------------------------------------------------------------------

type DiscogsSummary = {
  ok?: boolean;
  resolvedCount?: number;
  skippedCount?: number;
  unresolvedCount?: number;
};

type LastfmSummary = {
  failedCount?: number;
  lovedCount?: number;
  ok?: boolean;
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
    discogs: { error: null as string | null, resolved: 0, skipped: 0, unresolved: 0 },
    lastfm: { error: null as string | null, failed: 0, loved: 0, skipped: 0 },
    ok: true,
  };

  const limit = ["--limit", String(BATCH_LIMIT)];

  try {
    const discogs = fluncleJson<DiscogsSummary>(["admin", "backfills", "discogs", ...limit]);
    summary.discogs.resolved = discogs.resolvedCount ?? 0;
    summary.discogs.unresolved = discogs.unresolvedCount ?? 0;
    summary.discogs.skipped = discogs.skippedCount ?? 0;
  } catch (error) {
    summary.discogs.error = error instanceof Error ? error.message : String(error);
    log(`discogs backfill failed: ${summary.discogs.error}`);
  }

  try {
    const lastfm = fluncleJson<LastfmSummary>(["admin", "backfills", "lastfm", ...limit]);
    summary.lastfm.loved = lastfm.lovedCount ?? 0;
    summary.lastfm.failed = lastfm.failedCount ?? 0;
    summary.lastfm.skipped = lastfm.skippedCount ?? 0;
  } catch (error) {
    summary.lastfm.error = error instanceof Error ? error.message : String(error);
    log(`lastfm backfill failed: ${summary.lastfm.error}`);
  }

  console.log(JSON.stringify(summary));
}

main();
