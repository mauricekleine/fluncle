#!/usr/bin/env bun
// artist-edges-sweep.ts — the bun orchestrator behind the `--no-agent` track_artists graph-backfill
// cron (`fluncle-artist-edges`), RFC artist-primary-capture slice 0.
//
// Version-controlled source; the repo is canonical and the box is a deploy target
// (fluncle-hermes-operator skill). Invoked by the bash wrapper (artist-edges-sweep.sh) the host
// timer execs on a schedule — see that file's header for the wire-up and ../cron/README.md for the
// cron model.
//
// THE GRAPH BACKFILL. The `track_artists` graph is crawl-era-only: history carries artist NAMES in
// `tracks.artists_json` but no identity edge. This sweep folds those names onto EXISTING `artists`
// rows (exact case-insensitive fold, then `artist_aliases`) and writes the edges — the graph slice 1's
// identity-keyed capture authorization reads. It MINTS NOTHING (a bare name is not enough identity)
// and makes NO vendor call — pure DB matching in the Worker.
//
// THE WORKER-PACED MODEL (the `fluncle-recording-mbids` shape, verbatim). The fill happens IN THE
// WORKER (`backfill_artist_edges`, agent tier) — this driver just PACES it, one bounded batch per
// tick via the `fluncle` CLI. The Worker carries the durable per-row reliability state (the
// `tracks.artist_edges_backfilled_at` stamp — every visited track is stamped, matched or not, so the
// worklist drains and a re-run is a no-op) and clamps a pass to MAX_BATCH (200); the driver stays
// dumb: run one bounded batch, ship the summary, let the next tick resume from the durable state.
//
// A generous `--limit` per tick is fine (no vendor call, no rate limit): the CLI loops the track-id
// cursor internally up to this cap or until the worklist drains, and the default EQUALS the Worker's
// MAX_BATCH (200) so a full first page meets the cap and the loop fires ONE HTTP request per tick.
// The ~25k-row history drains in a handful of ticks; after that a tick is a cheap no-op. It writes
// catalogue-graph identity only — it certifies nothing and publishes nothing (agent tier, the
// `backfill_recording_mbids` precedent). Zero LLM tokens. Pure HTTP driving.
//
// stdout: one JSON summary line (the cron run output). Diagnostics → stderr.

import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Config — the per-tick cap. Pinned to the Worker's MAX_BATCH (200) so the CLI's internal cursor
// loop meets the cap on a full first page and fires exactly one request per tick. Pure DB matching,
// so a full batch is well under the cron timeout; a drained worklist is a cheap no-op.
// ---------------------------------------------------------------------------

// 100, not the op's MAX_BATCH of 200: the CLI's shared limit validator caps every list/backfill
// limit at 100, so 200 fails client-side before any request ("Limit must be an integer between 1
// and 100", found live 2026-07-20). 100 ≤ the server clamp keeps the one-request-per-tick property
// (a full page meets the CLI cap in one call); the drain just takes twice the ticks.
const BATCH_LIMIT = Number(process.env.FLUNCLE_ARTIST_EDGES_LIMIT ?? "100");

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";

const log = (message: string) => console.error(`[artist-edges-sweep] ${message}`);

// ---------------------------------------------------------------------------
// Types — only the fields we consume from the graph-backfill summary.
// ---------------------------------------------------------------------------

type ArtistEdgesSummary = {
  // `track_artists` edges written this pass.
  edgesWritten?: number;
  // Tracks where every credited name matched an identity.
  fullyMatchedCount?: number;
  ok?: boolean;
  // Tracks where some names matched and some did not.
  partiallyMatchedCount?: number;
  // Tracks VISITED this pass (fully + partially + zero).
  scanned?: number;
  // Credited names that matched NO identity — the residual a future MB credit-sweep would mint from.
  unmatchedNames?: number;
  // Tracks where no credited name matched an identity.
  zeroMatchedCount?: number;
};

// ---------------------------------------------------------------------------
// Shell helper — synchronous, fail-loud where it matters. (Same contract as the other sweeps: a
// partial batch still prints its JSON summary, and that summary must be RECORDED, not discarded.)
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
// errors). Distinguishable from a fill summary, which carries no `code`/`message` pair and keeps
// its counts alongside `ok`.
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
// Main — ONE bounded batch. Deliberately not a loop: the `tracks` worklist is the worklist and the
// timer is the loop. A tick that finds every track already backfilled is a cheap no-op.
// ---------------------------------------------------------------------------

export function main(): void {
  const summary = {
    edgesWritten: 0,
    error: null as string | null,
    fullyMatched: 0,
    ok: true,
    partiallyMatched: 0,
    scanned: 0,
    unmatchedNames: 0,
    zeroMatched: 0,
  };

  try {
    const pass = fluncleJson<ArtistEdgesSummary>([
      "admin",
      "backfills",
      "artist-edges",
      "--limit",
      String(BATCH_LIMIT),
    ]);

    summary.scanned = pass.scanned ?? 0;
    summary.edgesWritten = pass.edgesWritten ?? 0;
    summary.fullyMatched = pass.fullyMatchedCount ?? 0;
    summary.partiallyMatched = pass.partiallyMatchedCount ?? 0;
    summary.zeroMatched = pass.zeroMatchedCount ?? 0;
    summary.unmatchedNames = pass.unmatchedNames ?? 0;
  } catch (error) {
    summary.ok = false;
    summary.error = error instanceof Error ? error.message : String(error);
    log(`track_artists graph-backfill pass failed: ${summary.error}`);
  }

  console.log(JSON.stringify(summary));

  if (!summary.ok) {
    process.exit(1);
  }
}

// The cron runs this file directly; the guard keeps importing `fluncleJson` for the tests
// (artist-edges-sweep.test.ts) side-effect free.
if (import.meta.main) {
  main();
}
