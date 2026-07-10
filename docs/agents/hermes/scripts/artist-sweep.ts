#!/usr/bin/env bun
// artist-sweep.ts — the bun orchestrator behind the `--no-agent` artist-resolution
// cron (`fluncle-artist-sweep`).
//
// LIVE. Version-controlled source; the repo is canonical and the box is a
// deploy target (fluncle-hermes-operator skill). Invoked by the bash wrapper
// (artist-sweep.sh) the cron runner execs on a schedule.
//
// THE WORKER-PACED MODEL. The box holds NO Firecrawl key, no YouTube OAuth,
// and no MusicBrainz credentials (the Worker does them all). So the actual work —
// the MB url-rel walk, Firecrawl /v2/extract gap-fill, YouTube channel resolution,
// and the `artist_socials` write — happens IN THE WORKER; this box driver just
// TRIGGERS it, one small bounded batch per tick via the `fluncle` CLI. Pure trigger,
// zero LLM tokens on the box.
//
// The loop, idempotent by construction (the queue is `resolved_at IS NULL`,
// oldest-first, and the Worker is idempotent per artist — re-resolving an already-
// resolved artist is a no-op that updates timestamps):
//
//   1. `fluncle admin artists resolve --queue --json` → the worklist
//      (artists with resolved_at IS NULL, oldest-first, up to QUEUE_LIMIT).
//   2. per artist (bounded batch): `fluncle admin artists resolve <id> --json`
//      → triggers the Worker (MB walk + Firecrawl gap-fill + persist).
//      Record pass/fail per artist; one failure never aborts the sweep.
//   3. `fluncle admin backfills artist-images --limit N --json` → one bounded page
//      of the artist-avatar backfill (fills `artists.image_url` from Spotify for
//      artists minted before the column). Runs every tick regardless of the resolve
//      queue, and is best-effort: a pinned box CLI predating the subcommand — or any
//      failure — is logged and skipped, never aborting the sweep (it self-heals on
//      the next tick / after the CLI re-bake).
//
// stdout: one JSON summary line (the cron run output). Diagnostics → stderr.

import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BATCH_CAP = 5; // artists resolved per tick (MB is 1 req/s; 5 artists ≈ ~30s)
const QUEUE_LIMIT = 50;
const IMAGE_BACKFILL_LIMIT = 50; // one Spotify /v1/artists batch per tick

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";

const log = (message: string) => console.error(`[artist-sweep] ${message}`);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type QueueArtist = {
  artistId?: string;
  id?: string;
  name?: string;
};

type ResolveResult = {
  artistId?: string;
  mbid?: string | null;
  ok?: boolean;
  rateLimited?: boolean;
  socialsCount?: number;
};

type Outcome = "resolved" | "noop" | "failed" | "rateLimited";

// ---------------------------------------------------------------------------
// Shell helper
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
// Per-artist: trigger the Worker's resolution.
// ---------------------------------------------------------------------------

function resolveOne(artist: QueueArtist): Outcome {
  const id = artist.artistId ?? artist.id;

  if (!id) {
    log("queue item without an id — skipping");
    return "failed";
  }

  const label = artist.name ? `${artist.name} (${id})` : id;

  const result = fluncleJson<ResolveResult>(["admin", "artists", "resolve", id]);

  if (result.rateLimited) {
    log(`${label}: MB rate-limited — stopping batch, will retry next tick`);
    return "rateLimited";
  }

  if (!result.ok) {
    log(`${label}: Worker returned not-ok`);
    return "failed";
  }

  const count = result.socialsCount ?? 0;
  const mbid = result.mbid ?? "(no mbid)";
  log(`${label}: resolved — mbid=${mbid}, ${count} social(s)`);

  return count > 0 ? "resolved" : "noop";
}

// ---------------------------------------------------------------------------
// Artist-avatar backfill drain (best-effort; never aborts the sweep).
// ---------------------------------------------------------------------------

function drainArtistImages(): number {
  try {
    const result = fluncleJson<{ filledCount?: number; skippedCount?: number }>([
      "admin",
      "backfills",
      "artist-images",
      "--limit",
      String(IMAGE_BACKFILL_LIMIT),
    ]);

    const filled = result.filledCount ?? 0;
    log(`artist-images: filled ${filled}, ${result.skippedCount ?? 0} without an image`);

    return filled;
  } catch (error) {
    // A pinned box CLI predating the subcommand — or any transient failure — must
    // never fail the sweep; the backfill self-heals next tick / after the re-bake.
    log(`artist-images drain skipped: ${error instanceof Error ? error.message : String(error)}`);

    return 0;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const response = fluncleJson<{ artists?: QueueArtist[] }>([
    "admin",
    "artists",
    "resolve",
    "--queue",
    "--limit",
    String(QUEUE_LIMIT),
  ]);
  const queue = response.artists ?? [];

  const summary = {
    batch: 0,
    failed: 0,
    imagesFilled: 0,
    noop: 0,
    queueRemaining: queue.length,
    resolved: 0,
  };

  if (queue.length === 0) {
    summary.imagesFilled = drainArtistImages();
    console.log(JSON.stringify({ ok: true, processed: 0, ...summary }));
    return;
  }

  for (const artist of queue.slice(0, BATCH_CAP)) {
    summary.batch += 1;

    try {
      const outcome = resolveOne(artist);

      if (outcome === "resolved") {
        summary.resolved += 1;
      } else if (outcome === "noop") {
        summary.noop += 1;
      } else if (outcome === "rateLimited") {
        summary.failed += 1;
        break; // MB is throttling — stop hammering, let remaining artists stay queued
      } else {
        summary.failed += 1;
      }
    } catch (error) {
      summary.failed += 1;
      log(
        `error on ${artist.id ?? "?"}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  summary.queueRemaining = Math.max(0, queue.length - summary.resolved - summary.noop);
  summary.imagesFilled = drainArtistImages();
  const processed = summary.resolved + summary.noop;

  console.log(JSON.stringify({ ok: true, processed, ...summary }));
}

main();
