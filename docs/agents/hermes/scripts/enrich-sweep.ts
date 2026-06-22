#!/usr/bin/env bun
// enrich-sweep.ts — the bun orchestrator behind the `--no-agent` enrichment cron.
//
// LIVE. Version-controlled source; the repo is canonical and the box is a deploy
// target (fluncle-hermes-operator skill). Invoked by the bash wrapper
// (enrich-sweep.sh) the cron runner execs every ~5m — see that file's header for
// the `hermes cron create` wire-up and ../cron/README.md for the full cron model.
//
// This is the on-box enrichment path: it does the analysis ON the box (ffmpeg +
// bun), so there is no Worker-side enrichment trigger. Pure compute, zero LLM
// tokens.
//
// The loop, idempotent by construction (the queue is `status=queue`: pending ∪
// failed ∪ stale processing, so a `done` finding is already out of it; re-running
// never double-writes), fast no-op when the queue is empty:
//
//   1. `fluncle admin tracks enrich --queue --json`  → the worklist.
//   2. per finding (bounded batch):
//      a. `fluncle track get <id> --json`           → artists, title, isrc, trackId.
//      b. `bun .../analyze-track.ts --artist <a> --title <t> [--isrc <i>]`
//                                                    → { bpm, key|null, features }.
//      c. `fluncle admin tracks update <trackId> --bpm <bpm> [--key "<key>"]
//             --features '<json>' --status done`     — `--key` only when non-null;
//         no preview (analyze exit 2) → `--status failed`.
//
// stdout: one JSON summary line (the cron run output). Diagnostics → stderr.

import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Config — bounded batch so a tick stays cheap and a transient failure can't
// stampede the whole queue. The queue itself is the durable worklist; anything
// not reached this tick is picked up on the next (~5m later).
// ---------------------------------------------------------------------------

const BATCH_CAP = 4; // findings analyzed per tick (sane small cap, 3–5 band)
const QUEUE_LIMIT = 50; // hard ceiling on the queue read (we only act on BATCH_CAP)

// On the box: /opt/data/skills (the host-mounted ~/.hermes/skills). Overridable so
// a local dry-run can point at a repo checkout of the skill.
const ANALYZE_SCRIPT =
  process.env.FLUNCLE_ANALYZE_SCRIPT ??
  "/opt/data/skills/fluncle-track-enrichment/scripts/analyze-track.ts";

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";
const BUN_BIN = process.env.BUN_BIN ?? "bun";

const log = (message: string) => console.error(`[enrich-sweep] ${message}`);

// ---------------------------------------------------------------------------
// Types — only the fields we consume from each surface.
// ---------------------------------------------------------------------------

type QueueFinding = {
  artists?: string[];
  isrc?: string;
  logId?: string;
  title?: string;
  trackId?: string;
};

type AnalyzeOutput = {
  bpm: number | null;
  features: Record<string, unknown>;
  key: string | null;
};

type Outcome = "done" | "failed" | "skipped";

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
// Per-finding: get → analyze → write back.
// ---------------------------------------------------------------------------

function enrichOne(finding: QueueFinding): Outcome {
  const id = finding.trackId ?? finding.logId;

  if (!id) {
    log("queue item without a trackId/logId — skipping");

    return "skipped";
  }

  // (a) Re-read the finding to get the canonical artist/title/isrc/trackId. The
  // queue payload already carries them, but a fresh `track get` is the source of
  // truth and tolerates the queue surface changing shape under us. NOTE: the
  // public lookup is the SINGULAR `track get` (only the admin group is plural).
  const finder = fluncleJson<QueueFinding>(["track", "get", id]);
  const trackId = finder.trackId ?? finding.trackId;
  const artist = finder.artists?.[0] ?? finding.artists?.[0];
  const title = finder.title ?? finding.title;
  const isrc = finder.isrc ?? finding.isrc;

  if (!trackId || !artist || !title) {
    log(`${id}: missing trackId/artist/title — skipping`);

    return "skipped";
  }

  // (b) Analyze. The skill resolves the preview itself (Deezer/iTunes), so no URL
  // is passed. Exit 2 = no preview / nothing decoded → mark the finding `failed`.
  const analyzeArgs = [ANALYZE_SCRIPT, "--artist", artist, "--title", title];

  if (isrc) {
    analyzeArgs.push("--isrc", isrc);
  }

  const analysis = run(BUN_BIN, analyzeArgs);

  if (analysis.code === 2) {
    log(`${trackId}: no preview available → status=failed`);
    fluncleJson(["admin", "tracks", "update", trackId, "--status", "failed"]);

    return "failed";
  }

  if (analysis.code !== 0) {
    // A genuine analyzer error (not the no-preview signal). Leave the finding in
    // the queue so the next tick retries; don't write a misleading status.
    log(`${trackId}: analyze-track exited ${analysis.code}: ${analysis.stderr.trim().slice(-200)}`);

    return "skipped";
  }

  let parsed: AnalyzeOutput;

  try {
    parsed = JSON.parse(analysis.stdout) as AnalyzeOutput;
  } catch {
    log(`${trackId}: analyze-track did not return JSON — leaving queued`);

    return "skipped";
  }

  // (c) Write back. `--key` only when non-null (respect the skill's confidence
  // gate); features always; status=done.
  const updateArgs = ["admin", "tracks", "update", trackId];

  if (parsed.bpm !== null && parsed.bpm !== undefined) {
    updateArgs.push("--bpm", String(parsed.bpm));
  }

  if (parsed.key !== null && parsed.key !== undefined) {
    updateArgs.push("--key", parsed.key);
  }

  updateArgs.push("--features", JSON.stringify(parsed.features ?? {}));
  updateArgs.push("--status", "done");

  fluncleJson(updateArgs);
  log(`${trackId}: done (bpm ${parsed.bpm ?? "null"}, key ${parsed.key ?? "null"})`);

  return "done";
}

// ---------------------------------------------------------------------------
// Main — drain a bounded batch off the queue.
// ---------------------------------------------------------------------------

function main(): void {
  // `enrich --queue --json` returns `{ ok: true, tracks: [...] }`, not a bare array.
  const response = fluncleJson<{ tracks?: QueueFinding[] }>([
    "admin",
    "tracks",
    "enrich",
    "--queue",
    "--limit",
    String(QUEUE_LIMIT),
  ]);
  const queue = response.tracks ?? [];

  const summary = { batch: 0, done: 0, failed: 0, queued: queue.length, skipped: 0 };

  if (queue.length === 0) {
    console.log(JSON.stringify({ ok: true, ...summary }));

    return; // fast no-op
  }

  for (const finding of queue.slice(0, BATCH_CAP)) {
    summary.batch += 1;

    try {
      const outcome = enrichOne(finding);
      summary[outcome] += 1;
    } catch (error) {
      // One finding's failure must not abort the sweep — log it and move on; it
      // stays in the queue for the next tick.
      summary.skipped += 1;
      log(
        `error on ${finding.trackId ?? finding.logId ?? "?"}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  console.log(JSON.stringify({ ok: true, ...summary }));
}

main();
