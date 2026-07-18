#!/usr/bin/env bun
// recording-mbids-sweep.ts — the bun orchestrator behind the `--no-agent` recording-MBID fill cron
// (`fluncle-recording-mbids`), the MusicBrainz identity layer.
//
// Version-controlled source; the repo is canonical and the box is a deploy target
// (fluncle-hermes-operator skill). Invoked by the bash wrapper (recording-mbids-sweep.sh) the host
// timer execs on a schedule — see that file's header for the wire-up and ../cron/README.md for the
// cron model.
//
// THE CANONICAL KG JOIN KEY. Every track earns its MusicBrainz recording MBID — the one identifier
// that reconciles it to the wider open music graph (MusicBrainz, Wikidata), and the anchor the
// `/log` MusicRecording emits as a `sameAs` + a KG `identifier`. Two fill paths: a FREE SQL strip
// of crawler-born rows' PK (`mb_<recording-mbid>` → the column), then an ISRC→recording resolve of
// the findings/Spotify-born tail through the shared MusicBrainz client. New crawler rows already
// carry the MBID at mint time, so this cron catches history up and drains the ISRC tail.
//
// THE WORKER-PACED MODEL (the `fluncle-backfill`/`fluncle-crawl` shape, verbatim). The box holds no
// MusicBrainz budget; the Worker does. So the fill happens IN THE WORKER — this driver just PACES
// it, one small bounded batch per tick via the `fluncle` CLI. The Worker carries the durable
// per-row reliability state (`mb_recording_id_attempted_at` — a miss is stamped so an ISRC
// MusicBrainz cannot resolve is not re-queried forever), the ~1 req/s MusicBrainz gate, and the
// rate-limit circuit breaker; the driver stays dumb: run one bounded batch, ship the summary, let
// the next tick resume from the durable state.
//
// A small `--limit` per tick is deliberate: the ISRC resolve is 1 req/s and the CLI's circuit
// breaker STOPS the pass the moment MusicBrainz throttles, so a tight batch keeps every tick well
// inside the cron timeout. The ISRC tail is the findings/Spotify-born slice (catalogue rows fill
// from their PK), which is small, so an hourly cadence drains it with room to spare; a tick that
// finds it drained is a cheap no-op. It fills only a track's METADATA identity — it certifies
// nothing and publishes nothing (agent tier, the `backfill_label_images` precedent). Zero LLM
// tokens. Pure HTTP driving.
//
// stdout: one JSON summary line (the cron run output). Diagnostics → stderr.

import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Config — a small bounded batch per tick. The CLI loops the track-id cursor internally up to this
// cap (or until the worklist drains, or MusicBrainz throttles), and each ISRC lookup is a
// serialized ~1.1s call, so 25 ≈ under 30s — comfortably inside the cron's timeout. The Worker
// itself clamps a single pass to MAX_API_BATCH (25) regardless.
// ---------------------------------------------------------------------------

const BATCH_LIMIT = Number(process.env.FLUNCLE_RECORDING_MBIDS_LIMIT ?? "25");

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";

const log = (message: string) => console.error(`[recording-mbids-sweep] ${message}`);

// ---------------------------------------------------------------------------
// Types — only the fields we consume from the recording-MBID fill summary.
// ---------------------------------------------------------------------------

type RecordingMbidsSummary = {
  failedCount?: number;
  // Track ids whose ISRC MusicBrainz has no recording for — attempt-stamped so they drain. A clean
  // outcome, not a failure.
  missedCount?: number;
  ok?: boolean;
  // Crawler-history rows filled from their PK this pass (the free no-vendor strip).
  prefixStripped?: number;
  // True when the pass STOPPED on the MusicBrainz rate-limit circuit breaker — a throttled tick,
  // not a drained worklist. Surfaced so the cron output reads honestly.
  rateLimited?: boolean;
  resolvedCount?: number;
};

// ---------------------------------------------------------------------------
// Shell helper — synchronous, fail-loud where it matters. (Same contract as the other sweeps: a
// partial batch exits 1 but still prints its JSON summary, and that summary must be RECORDED, not
// discarded as a crash.)
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
// timer is the loop. A tick that finds every track already filled/attempted is a cheap no-op.
// ---------------------------------------------------------------------------

export function main(): void {
  const summary = {
    error: null as string | null,
    failed: 0,
    // ISRCs MusicBrainz has no recording for — attempt-stamped, a clean terminal outcome.
    missed: 0,
    ok: true,
    // Crawler-history rows filled from their PK (the free strip).
    prefixStripped: 0,
    resolved: 0,
    throttled: false,
  };

  try {
    const pass = fluncleJson<RecordingMbidsSummary>([
      "admin",
      "backfills",
      "recording-mbids",
      "--limit",
      String(BATCH_LIMIT),
    ]);

    summary.prefixStripped = pass.prefixStripped ?? 0;
    summary.resolved = pass.resolvedCount ?? 0;
    summary.missed = pass.missedCount ?? 0;
    summary.failed = pass.failedCount ?? 0;
    summary.throttled = pass.rateLimited ?? false;

    if (summary.throttled) {
      log("MusicBrainz throttled the pass — stopped clean; the next tick resumes.");
    }
  } catch (error) {
    summary.ok = false;
    summary.error = error instanceof Error ? error.message : String(error);
    log(`recording-MBID fill pass failed: ${summary.error}`);
  }

  console.log(JSON.stringify(summary));

  if (!summary.ok) {
    process.exit(1);
  }
}

// The cron runs this file directly; the guard keeps importing `fluncleJson` for the tests
// (recording-mbids-sweep.test.ts) side-effect free.
if (import.meta.main) {
  main();
}
