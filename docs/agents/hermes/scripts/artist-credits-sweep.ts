#!/usr/bin/env bun
// artist-credits-sweep.ts — the bun orchestrator behind the `--no-agent` MB-credit-sweep cron
// (`fluncle-artist-credits`), RFC artist-primary-capture slice 1b.
//
// Version-controlled source; the repo is canonical and the box is a deploy target
// (fluncle-hermes-operator skill). Invoked by the bash wrapper (artist-credits-sweep.sh) the host
// timer execs on a schedule — see that file's header for the wire-up and ../cron/README.md for the
// cron model.
//
// THE MB CREDIT SWEEP. Slice 0 (`fluncle-artist-edges`) folded each edge-less track's `artists_json`
// NAMES onto EXISTING `artists` rows, and left a ZERO-MATCHED residual — a track it stamped but wrote
// no edge, because no credited name folded to an existing identity. This sweep completes it: for each
// zero-matched track carrying a MusicBrainz recording identity, ONE paced `inc=artist-credits` lookup
// names its credited artists WITH their MB artist ids, which it matches-or-MINTS by `mbid` (a real
// MBID is identity — the licence slice 0 lacked), then writes the `track_artists` edges.
//
// THE WORKER-PACED MODEL (the `fluncle-recording-mbids` shape, verbatim). The fill happens IN THE
// WORKER (`backfill_artist_credits`, agent tier) — this driver just PACES it, one bounded batch per
// tick via the `fluncle` CLI. The Worker carries the durable per-row reliability state (the
// `tracks.artist_credits_backfilled_at` stamp — every visited row is stamped, edged or skipped, so
// the worklist drains) and the vendor protections (1 req/s, throttle circuit breaker, a 60s response
// budget); it clamps a pass to MAX_BATCH (40, because each row is one ~1.1s MB call). The driver
// stays dumb: run one bounded batch, ship the summary, let the next tick resume from the durable
// state. It writes catalogue-graph identity only — it certifies nothing and publishes nothing (agent
// tier, the `backfill_recording_mbids` precedent). Zero LLM tokens. Pure HTTP driving.
//
// stdout: one JSON summary line (the cron run output). Diagnostics → stderr.

import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Config — the per-tick cap. Pinned to the Worker's MAX_BATCH (40) so the CLI's internal cursor loop
// meets the cap on a full first page and fires one request per tick. 40 ≤ the CLI's shared limit
// validator ceiling (100), so it never fails client-side. Each row is one paced ~1.1s MB call, so a
// full batch is ~under a minute; a drained worklist is a cheap no-op.
// ---------------------------------------------------------------------------

const BATCH_LIMIT = Number(process.env.FLUNCLE_ARTIST_CREDITS_LIMIT ?? "40");

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";

const log = (message: string) => console.error(`[artist-credits-sweep] ${message}`);

// ---------------------------------------------------------------------------
// Types — only the fields we consume from the credit-sweep summary.
// ---------------------------------------------------------------------------

type ArtistCreditsSummary = {
  // `track_artists` edges written this pass.
  edgesWritten?: number;
  // Credited artists matched to an existing artists row by MB id.
  matchedArtists?: number;
  // NEW artists rows minted by MB artist id this pass.
  mintedArtists?: number;
  ok?: boolean;
  // True when the pass STOPPED on the MusicBrainz rate-limit circuit breaker.
  rateLimited?: boolean;
  // Worklist rows VISITED this pass (edged + skipped).
  scanned?: number;
  // Zero-matched rows carrying NO MB recording identity — terminally skipped.
  skippedNoIdentity?: number;
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
// timer is the loop. A tick that finds the residual drained is a cheap no-op.
// ---------------------------------------------------------------------------

export function main(): void {
  const summary = {
    edgesWritten: 0,
    error: null as string | null,
    matchedArtists: 0,
    mintedArtists: 0,
    ok: true,
    rateLimited: false,
    scanned: 0,
    skippedNoIdentity: 0,
  };

  try {
    const pass = fluncleJson<ArtistCreditsSummary>([
      "admin",
      "backfills",
      "artist-credits",
      "--limit",
      String(BATCH_LIMIT),
    ]);

    summary.scanned = pass.scanned ?? 0;
    summary.mintedArtists = pass.mintedArtists ?? 0;
    summary.matchedArtists = pass.matchedArtists ?? 0;
    summary.edgesWritten = pass.edgesWritten ?? 0;
    summary.skippedNoIdentity = pass.skippedNoIdentity ?? 0;
    summary.rateLimited = pass.rateLimited ?? false;
  } catch (error) {
    summary.ok = false;
    summary.error = error instanceof Error ? error.message : String(error);
    log(`MB credit-sweep pass failed: ${summary.error}`);
  }

  console.log(JSON.stringify(summary));

  if (!summary.ok) {
    process.exit(1);
  }
}

// The cron runs this file directly; the guard keeps importing `fluncleJson` for the tests
// (artist-credits-sweep.test.ts) side-effect free.
if (import.meta.main) {
  main();
}
