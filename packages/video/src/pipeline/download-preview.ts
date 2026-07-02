// Download a preview mp3, loudness-normalize to -14 LUFS (two-pass, so the same
// input always produces the same output level — see normalizeAndEncode below),
// transcode to an AAC .m4a in public/ (staticFile-servable), and emit a mono
// 22050Hz PCM wav in a tmp dir for offline analysis. Also owns the bounded
// preview-audio cache in public/: a per-track delete after a successful ship,
// plus an opportunistic keep-the-N-most-recent sweep.

import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// The ffmpeg binary: PATH by default (Homebrew on macOS, /usr/bin on Linux), with
// an explicit override for hosts where it lives elsewhere. Mirrors FLUNCLE_BIN.
const FFMPEG = process.env.FLUNCLE_FFMPEG ?? "ffmpeg";

const PUBLIC_DIR = path.resolve(import.meta.dirname, "../../public");

// The two-pass loudnorm target — matches the single-pass value this replaced.
const LOUDNORM_TARGET = "I=-14:TP=-1.5:LRA=11";

export type DownloadedPreview = {
  /** Absolute path to the AAC .m4a inside public/. */
  m4aPath: string;
  /** Filename only, for staticFile() inside the composition. */
  file: string;
  /** Absolute path to the mono 22050Hz PCM wav (in a tmp dir). */
  wavPath: string;
  /** The tmp dir holding the wav; caller may clean it up. */
  tmpDir: string;
};

function run(bin: string, args: string[]): Promise<void> {
  return runCapture(bin, args).then(() => undefined);
}

function runCapture(bin: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stderr, stdout });
      } else {
        reject(new Error(`${bin} exited with ${code}\n${stderr.slice(-2000)}`));
      }
    });
  });
}

type LoudnormMeasurement = {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
};

/**
 * Pass 1 of the two-pass loudnorm: a measure-only run (`print_format=json`,
 * output discarded via `-f null -`) that reports the source's actual loudness
 * stats. ffmpeg prints the JSON block as the tail of stderr.
 */
async function measureLoudness(srcPath: string): Promise<LoudnormMeasurement> {
  const { stderr } = await runCapture(FFMPEG, [
    "-i",
    srcPath,
    "-af",
    `loudnorm=${LOUDNORM_TARGET}:print_format=json`,
    "-f",
    "null",
    "-",
  ]);
  const match = /\{[\s\S]*\}/.exec(stderr);
  if (!match) {
    throw new Error(
      `downloadPreview: loudnorm measurement pass produced no JSON in stderr:\n${stderr.slice(-1000)}`,
    );
  }
  return JSON.parse(match[0]) as LoudnormMeasurement;
}

/**
 * Two-pass loudnorm: measure the source (pass 1), then re-encode with the
 * measured stats fed back in via `measured_*` + `linear=true` (pass 2). Single-
 * pass dynamic loudnorm re-measures a short internal window on the fly and can
 * pump/adjust gain mid-clip; the two-pass linear form applies one fixed gain
 * derived from the whole file, so the same input always produces the same
 * output level. Exported standalone (not just via downloadPreview) so it can be
 * exercised directly against a local file in tests, without a network fetch.
 */
export async function normalizeAndEncode(srcPath: string, m4aPath: string): Promise<void> {
  const measured = await measureLoudness(srcPath);
  await run(FFMPEG, [
    "-y",
    "-i",
    srcPath,
    "-af",
    `loudnorm=${LOUDNORM_TARGET}:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true`,
    "-ar",
    "44100",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    m4aPath,
  ]);
}

/**
 * Download `url`, normalize loudness (two-pass), and produce both the
 * deliverable m4a and an analysis wav. The m4a lands at public/<trackId>.m4a.
 */
export async function downloadPreview(url: string, trackId: string): Promise<DownloadedPreview> {
  const tmpDir = await mkdtemp(path.join(tmpdir(), `fluncle-preview-${trackId}-`));
  const srcPath = path.join(tmpDir, "source.mp3");

  const res = await fetch(url);
  if (!res.ok) {
    await rm(tmpDir, { force: true, recursive: true });
    throw new Error(`downloadPreview: GET preview failed with ${res.status} ${res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(srcPath, buf);

  const m4aPath = path.join(PUBLIC_DIR, `${trackId}.m4a`);
  const wavPath = path.join(tmpDir, "analysis.wav");

  await normalizeAndEncode(srcPath, m4aPath);

  // Mono 22050Hz signed-16 PCM wav for analysis (small, deterministic to read).
  await run(FFMPEG, [
    "-y",
    "-i",
    srcPath,
    "-ac",
    "1",
    "-ar",
    "22050",
    "-c:a",
    "pcm_s16le",
    wavPath,
  ]);

  return { file: `${trackId}.m4a`, m4aPath, tmpDir, wavPath };
}

/**
 * Delete the shipped track's cached preview audio (public/<trackId>.m4a), if
 * present. Called after a successful ship — the analysis pass that needed it
 * is done, and R2 now holds the durable copy inside the video bundle. Never
 * throws: a missing file, or a delete failure, is not a ship blocker. `dir`
 * defaults to the real public/ dir; overridable for tests.
 */
export async function deletePreviewAudio(trackId: string, dir = PUBLIC_DIR): Promise<boolean> {
  const m4aPath = path.join(dir, `${trackId}.m4a`);
  try {
    await unlink(m4aPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Opportunistic bounded cache: keep only the `keep` most-recently-modified
 * `*.m4a` files directly under public/ (the preview cache downloadPreview
 * writes to), deleting the rest. Only ever touches `*.m4a` files in the public/
 * ROOT — never fonts/ or any other tracked asset. Best-effort: any per-file
 * stat/unlink failure is swallowed so a sweep never breaks the calling script.
 * Returns the filenames it deleted. `dir` defaults to the real public/ dir;
 * overridable for tests.
 */
export async function sweepPreviewAudioCache(keep = 8, dir = PUBLIC_DIR): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const m4aFiles = entries.filter((name) => name.endsWith(".m4a"));
  const withMtime = await Promise.all(
    m4aFiles.map(async (name) => {
      try {
        const info = await stat(path.join(dir, name));
        return { mtimeMs: info.mtimeMs, name };
      } catch {
        return null;
      }
    }),
  );

  const sorted = withMtime
    .filter((entry): entry is { mtimeMs: number; name: string } => entry !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const toDelete = sorted.slice(keep);
  const deleted: string[] = [];
  for (const entry of toDelete) {
    try {
      await unlink(path.join(dir, entry.name));
      deleted.push(entry.name);
    } catch {
      // best-effort — a stale/locked file doesn't block the caller.
    }
  }
  return deleted;
}
