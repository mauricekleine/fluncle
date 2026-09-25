import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const FFMPEG = process.env.FLUNCLE_FFMPEG ?? "ffmpeg";

const PUBLIC_DIR = path.resolve(import.meta.dirname, "../../public");

const LOUDNORM_TARGET = "I=-14:TP=-1.5:LRA=11";

export type DownloadedPreview = {
  m4aPath: string;

  file: string;

  wavPath: string;

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

export async function downloadPreview(
  url: string,
  trackId: string,
  headers?: Record<string, string>,
): Promise<DownloadedPreview> {
  const tmpDir = await mkdtemp(path.join(tmpdir(), `fluncle-preview-${trackId}-`));
  const srcPath = path.join(tmpDir, "source.mp3");

  const res = await fetch(url, headers ? { headers } : {});
  if (!res.ok) {
    await rm(tmpDir, { force: true, recursive: true });
    throw new Error(`downloadPreview: GET preview failed with ${res.status} ${res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(srcPath, buf);

  const m4aPath = path.join(PUBLIC_DIR, `${trackId}.m4a`);
  const wavPath = path.join(tmpDir, "analysis.wav");

  await normalizeAndEncode(srcPath, m4aPath);

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

export async function deletePreviewAudio(trackId: string, dir = PUBLIC_DIR): Promise<boolean> {
  const m4aPath = path.join(dir, `${trackId}.m4a`);
  try {
    await unlink(m4aPath);
    return true;
  } catch {
    return false;
  }
}

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
    } catch {}
  }
  return deleted;
}
