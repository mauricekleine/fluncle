#!/usr/bin/env bun
// clip-sweep.ts — the bun orchestrator behind the `--no-agent` Fluncle Studio clip-cut
// cron (`fluncle-studio-clip`).
//
// Version-controlled source; the repo is canonical and the box is a deploy target
// (fluncle-hermes-operator skill). Invoked by the bash wrapper (clip-sweep.sh) the cron
// runner execs every ~15m — see that file's header for the `hermes cron create` wire-up
// and docs/fluncle-studio.md for the full cut design.
//
// PURE-TRIGGER (the enrich-sweep shape): the cut is a deterministic ffmpeg job, zero LLM
// tokens. The loop, idempotent by construction (the queue is `status=pending`; a `done`
// clip is already out of it, and re-cutting re-ships the same key + the finalize purges),
// fast no-op when the queue is empty:
//
//   1. `fluncle admin clips list --status pending --json`  → the cut worklist.
//   2. per clip (bounded batch): `fluncle admin clips cut <clipId> --json`
//      → resolve the mixtape's staged set rendition, ffmpeg (trim + 9:16 crop + brand
//        frame), single-PUT upload to R2, finalize (mark done + edge purge). All behind
//        the box's agent token; the box holds no R2/Cloudflare creds.
//
// SINGLE-FLIGHT is not needed (unlike the GPU render conductor): the cut is short and
// the queue read + done-marker (`status` flips to `done` on finalize) make overlapping
// ticks safe — a clip already cut is out of the next tick's `pending` read. A clip whose
// set video is not staged yet is skipped (it stays `pending`) until `distribute
// --set-video` runs, so it never blocks the batch.
//
// stdout: one JSON summary line (the cron run output). Diagnostics → stderr.

import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Config — a SMALL bounded batch so a tick stays well under the Hermes `--no-agent`
// 120s kill (a 60s 1080p re-encode + a <100MB upload is a handful of seconds, but the
// set-rendition range fetch can add a few). The queue is the durable worklist; anything
// not reached this tick is picked up on the next (~15m later). Raise CLIP_BATCH_CAP only
// once a HEALTHY run measures comfortably under 120s per clip.
// ---------------------------------------------------------------------------

const BATCH_CAP = Number(process.env.CLIP_BATCH_CAP ?? "1") || 1;
const QUEUE_LIMIT = 50; // hard ceiling on the queue read (we only act on BATCH_CAP)

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";

const log = (message: string) => console.error(`[clip-sweep] ${message}`);

// ---------------------------------------------------------------------------
// Types — only the fields we consume.
// ---------------------------------------------------------------------------

type PendingClip = {
  id?: string;
  mixtapeId?: string;
};

type Outcome = "cut" | "skipped";

// ---------------------------------------------------------------------------
// Shell helpers — synchronous, fail-loud where it matters.
// ---------------------------------------------------------------------------

function run(bin: string, args: string[]): { code: number; stderr: string; stdout: string } {
  const result = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

  if (result.error) {
    throw new Error(`failed to spawn ${bin}: ${result.error.message}`);
  }

  return {
    code: result.status ?? 1,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}

function fluncleJson<T>(args: string[]): T {
  const { code, stderr, stdout } = run(FLUNCLE_BIN, [...args, "--json"]);

  if (code !== 0) {
    throw new Error(`fluncle ${args.join(" ")} exited ${code}: ${stderr.trim()}`);
  }

  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error(`fluncle ${args.join(" ")} did not return JSON: ${stdout.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Cut one clip via the CLI (which does the ffmpeg + presign + upload + finalize). A
// `set_not_staged` failure (the mixtape's set video isn't on R2 yet) is a SKIP — the
// clip stays pending for a future tick, after `distribute --set-video` runs. Any other
// failure is also a skip (logged); the clip stays queued.
// ---------------------------------------------------------------------------

function cutOne(clip: PendingClip): Outcome {
  const id = clip.id;

  if (!id) {
    log("queue item without a clip id — skipping");

    return "skipped";
  }

  const { code, stderr, stdout } = run(FLUNCLE_BIN, ["admin", "clips", "cut", id, "--json"]);

  if (code !== 0) {
    const detail = `${stdout}\n${stderr}`.toLowerCase();

    if (detail.includes("set_not_staged")) {
      log(
        `${id}: set video not staged yet — skipping (stays pending until distribute --set-video)`,
      );
    } else {
      log(`${id}: cut exited ${code}: ${stderr.trim().slice(-200)}`);
    }

    return "skipped";
  }

  log(`${id}: cut`);

  return "cut";
}

// ---------------------------------------------------------------------------
// Main — drain a bounded batch off the pending-clip queue.
// ---------------------------------------------------------------------------

function main(): void {
  const response = fluncleJson<{ clips?: PendingClip[] }>([
    "admin",
    "clips",
    "list",
    "--status",
    "pending",
  ]);
  const queue = (response.clips ?? []).slice(0, QUEUE_LIMIT);

  const summary = { batch: 0, cut: 0, pending: queue.length, skipped: 0 };

  if (queue.length === 0) {
    console.log(JSON.stringify({ ok: true, ...summary }));

    return; // fast no-op
  }

  for (const clip of queue.slice(0, BATCH_CAP)) {
    summary.batch += 1;

    try {
      const outcome = cutOne(clip);
      summary[outcome] += 1;
    } catch (error) {
      // One clip's failure must not abort the sweep — log it and move on; it stays
      // pending for the next tick.
      summary.skipped += 1;
      log(`error on ${clip.id ?? "?"}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(JSON.stringify({ ok: true, ...summary }));
}

main();
