#!/usr/bin/env bun
// artist-follow-sweep.ts — the bun orchestrator behind the `--no-agent` artist
// auto-follow cron (`fluncle-artist-follow`), the championing motion's automated half
// (Epic B, Unit 5 of the artist-relationship RFC).
//
// LIVE. Version-controlled source; the repo is canonical and the box is a deploy target
// (fluncle-hermes-operator skill). Invoked by the bash wrapper (artist-follow-sweep.sh)
// the cron runner execs on a schedule — see that file's header for the wire-up and
// ../cron/README.md for the cron model.
//
// THE WORKER-PACED MODEL. The box holds NO YouTube token (the Worker does). So the actual
// follow — YouTube `subscriptions.insert`, then the `followed_at` stamp — happens IN THE
// WORKER; this box driver just TRIGGERS it, one bounded batch per tick via the `fluncle
// admin artists follow` CLI. Pure trigger, zero LLM tokens on the box. The CLI itself loops
// the batch until the queue's `remaining` is 0 (bounded by `--limit`), so a single spawn
// per tick drains the backlog safely.
//
// YOUTUBE-ONLY. Spotify is excluded from the auto-follow sweep — its artist-follow endpoint
// is dev-mode-gated for our app (a permanent 403; see ../../../planning/ROADMAP.md), so Spotify
// championing runs through the manual /admin/artists queue. Idempotent by construction
// (`followed_at IS NULL`), acting only on `status IN (auto, confirmed)`. The queue is small
// most ticks (a no-op when nothing is pending), so the cron is cheap. Mixcloud is CUT to
// link-only.
//
// stdout: one JSON summary line (the cron run output). Diagnostics → stderr.

import { spawnSync } from "node:child_process";

// The per-tick cap handed to the CLI (which drains up to this many, looping internally).
// Small enough to stay well inside YouTube's quota per run: a YouTube
// `subscriptions.insert` costs 50 units against a 200/day quota (~4 subscribes/day), and
// this cron runs every 6h — but cadence×cap is only the first line of defense. The real
// ceiling is the server-side per-day guard in followPendingArtists (YOUTUBE_DAILY_FOLLOW_CAP),
// which stops calling the API past the quota no matter how the sweep was triggered.
const BATCH_CAP = 20;

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";

const log = (message: string) => console.error(`[artist-follow-sweep] ${message}`);

type FollowResult = {
  failedCount?: number;
  followedCount?: number;
  ok?: boolean;
  remaining?: number;
};

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

function main(): void {
  const result = fluncleJson<FollowResult>([
    "admin",
    "artists",
    "follow",
    "--limit",
    String(BATCH_CAP),
  ]);

  const followedCount = result.followedCount ?? 0;
  const failedCount = result.failedCount ?? 0;
  const remaining = result.remaining ?? 0;

  if (followedCount > 0) {
    log(`followed ${followedCount}; ${failedCount} failed; ${remaining} remaining`);
  }

  console.log(JSON.stringify({ failedCount, followedCount, ok: true, remaining }));
}

main();
