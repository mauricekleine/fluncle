#!/usr/bin/env bun
// embed-sweep.ts — the bun orchestrator behind the `--no-agent` audio-embedding cron.
//
// LIVE. Version-controlled source; the repo is canonical and the box is a deploy
// target (fluncle-hermes-operator skill). Invoked by the bash wrapper
// (embed-sweep.sh) the cron runner execs every ~5m — see that file's header for the
// `hermes cron create` wire-up and ../cron/README.md for the full cron model.
//
// This is the on-box embedding path: it embeds ON the box (torch + MuQ, via
// embed-track.py), so there is no Worker-side trigger. Pure compute, zero LLM tokens.
// It writes the vector back through the agent-tier `update_track` path (the box's
// admin token), exactly like enrich-sweep writes bpm/key/features.
//
// The loop, idempotent by construction (the queue is `embedding_json IS NULL`, so an
// embedded finding is already out of it; re-running never double-writes), fast no-op
// when the queue is empty:
//
//   1. `fluncle admin tracks embed --queue --json`   → the worklist.
//   2. download each finding's preview (the batch), build a manifest.
//   3. ONE `python3 embed-track.py` call over the batch → {results, errors}
//      (the MuQ model load is amortized across the batch).
//   4. per result: `fluncle admin tracks update <trackId> --embedding-file <tmp>`.
//
// stdout: one JSON summary line (the cron run output). Diagnostics → stderr.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Config — a small batch: MuQ is ~16s/track (2 cores) / ~8s (the CPX32's 4), so a
// cap of 3 keeps a tick well under the 300s cron `script_timeout_seconds`. The queue
// is the durable worklist; anything not reached this tick is picked up ~5m later.
// ---------------------------------------------------------------------------

const BATCH_CAP = 3; // findings embedded per tick
const QUEUE_LIMIT = 50; // hard ceiling on the queue read (we only act on BATCH_CAP)

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";
const PYTHON_BIN = process.env.PYTHON_BIN ?? "python3";
// The MuQ inference script — deployed beside this orchestrator (~/.hermes/scripts/).
const EMBED_SCRIPT =
  process.env.FLUNCLE_EMBED_SCRIPT ?? new URL("embed-track.py", import.meta.url).pathname;
// The API base the CLI uses — the preview is fetched from its self-refreshing relay.
const API_BASE = (process.env.FLUNCLE_API_BASE_URL ?? "https://www.fluncle.com").replace(
  /\/+$/,
  "",
);

const log = (message: string) => console.error(`[embed-sweep] ${message}`);

// The preview URL the box downloads: the Worker's `/api/preview/<id>` relay, which
// refreshes a dead Deezer token by ISRC and falls back to iTunes — the freshest
// playable preview, self-healing where the stored `preview_url` may be stale.
function previewUrlFor(trackId: string): string {
  return `${API_BASE}/api/preview/${encodeURIComponent(trackId)}`;
}

// ---------------------------------------------------------------------------
// Types — only the fields we consume from each surface.
// ---------------------------------------------------------------------------

type QueueFinding = {
  logId?: string;
  trackId?: string;
};

type EmbedResult = { embedding: number[]; id: string };
type EmbedError = { error: string; id: string };
type EmbedOutput = { errors?: EmbedError[]; results?: EmbedResult[] };

// ---------------------------------------------------------------------------
// Shell helpers — synchronous, fail-loud where it matters.
// ---------------------------------------------------------------------------

function run(
  bin: string,
  args: string[],
  input?: string,
): { code: number; stderr: string; stdout: string } {
  const result = spawnSync(bin, args, {
    encoding: "utf8",
    input,
    maxBuffer: 64 * 1024 * 1024,
  });

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
// Preview download — the audio MuQ embeds. A finding with no resolvable preview is
// left queued (logged), not failed: there is no embed status column, and a preview
// can appear later (the enrich sweep refreshes Deezer/iTunes).
// ---------------------------------------------------------------------------

async function downloadPreview(url: string, destination: string): Promise<boolean> {
  try {
    const response = await fetch(url);

    if (!response.ok) {
      log(`preview fetch ${response.status} for ${url}`);
      return false;
    }

    writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
    return true;
  } catch (error) {
    log(
      `preview fetch failed for ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main — drain a bounded batch off the queue.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // `embed --queue --json` returns `{ ok: true, tracks: [...] }`, not a bare array.
  const response = fluncleJson<{ tracks?: QueueFinding[] }>([
    "admin",
    "tracks",
    "embed",
    "--queue",
    "--limit",
    String(QUEUE_LIMIT),
  ]);
  const queue = response.tracks ?? [];

  const summary = { done: 0, failed: 0, noPreview: 0, queued: queue.length, skipped: 0 };

  if (queue.length === 0) {
    console.log(JSON.stringify({ ok: true, ...summary }));

    return; // fast no-op
  }

  const workdir = mkdtempSync(join(tmpdir(), "fluncle-embed-"));

  try {
    // (1) Resolve + download each finding's preview; build the MuQ manifest.
    const manifest: { id: string; path: string }[] = [];

    for (const finding of queue.slice(0, BATCH_CAP)) {
      // The queue payload (a public TrackListItem) already carries the canonical
      // trackId, so no re-read is needed; the preview comes from the self-refreshing
      // relay keyed by that id.
      const trackId = finding.trackId;

      if (!trackId) {
        summary.skipped += 1;
        continue;
      }

      const audioPath = join(workdir, `${trackId}.mp3`);

      if (await downloadPreview(previewUrlFor(trackId), audioPath)) {
        manifest.push({ id: trackId, path: audioPath });
      } else {
        // No playable preview (dead token + no iTunes fallback) — leave it queued;
        // a preview can appear later (the enrich sweep refreshes Deezer/iTunes).
        summary.noPreview += 1;
        log(`${trackId}: no preview — leaving queued`);
      }
    }

    if (manifest.length === 0) {
      console.log(JSON.stringify({ ok: true, ...summary }));
      return;
    }

    // (2) ONE python call over the whole batch — the MuQ model load is amortized.
    const embed = run(PYTHON_BIN, [EMBED_SCRIPT], JSON.stringify(manifest));

    if (embed.code !== 0) {
      // A batch-level failure (torch import / model load): leave everything queued.
      log(`embed-track exited ${embed.code}: ${embed.stderr.trim().slice(-400)}`);
      summary.skipped += manifest.length;
      console.log(JSON.stringify({ ok: false, reason: "embed_failed", ...summary }));
      process.exitCode = 1;
      return;
    }

    let parsed: EmbedOutput;

    try {
      parsed = JSON.parse(embed.stdout) as EmbedOutput;
    } catch {
      log(`embed-track did not return JSON: ${embed.stdout.slice(0, 200)}`);
      summary.skipped += manifest.length;
      console.log(JSON.stringify({ ok: false, reason: "embed_bad_output", ...summary }));
      process.exitCode = 1;
      return;
    }

    // (3) Write each vector back via the agent-tier update path (a file arg — a
    // 1024-float array is large for an inline flag).
    for (const result of parsed.results ?? []) {
      try {
        const vectorPath = join(workdir, `${result.id}.json`);
        writeFileSync(vectorPath, JSON.stringify(result.embedding));
        fluncleJson(["admin", "tracks", "update", result.id, "--embedding-file", vectorPath]);
        summary.done += 1;
        log(`${result.id}: embedded + written`);
      } catch (error) {
        summary.skipped += 1;
        log(
          `${result.id}: write-back failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    for (const failure of parsed.errors ?? []) {
      summary.failed += 1;
      log(`${failure.id}: embed error — ${failure.error}`);
    }

    console.log(JSON.stringify({ ok: true, ...summary }));
  } finally {
    rmSync(workdir, { force: true, recursive: true });
  }
}

main().catch((error) => {
  console.error(`[embed-sweep] fatal: ${error instanceof Error ? error.message : String(error)}`);
  console.log(JSON.stringify({ ok: false, reason: "fatal" }));
  process.exitCode = 1;
});
