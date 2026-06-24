// Download a preview mp3, loudness-normalize to -14 LUFS, transcode to an AAC
// .m4a in public/ (staticFile-servable), and emit a mono 22050Hz PCM wav in a
// tmp dir for offline analysis.

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// The ffmpeg binary: PATH by default (Homebrew on macOS, /usr/bin on Linux), with
// an explicit override for hosts where it lives elsewhere. Mirrors FLUNCLE_BIN.
const FFMPEG = process.env.FLUNCLE_FFMPEG ?? "ffmpeg";

const PUBLIC_DIR = path.resolve(import.meta.dirname, "../../public");

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
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${bin} exited with ${code}\n${stderr.slice(-2000)}`));
      }
    });
  });
}

/**
 * Download `url`, normalize loudness, and produce both the deliverable m4a and
 * an analysis wav. The m4a lands at public/<trackId>.m4a.
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

  // Loudness-normalize to -14 LUFS and encode AAC at 44.1kHz for delivery.
  await run(FFMPEG, [
    "-y",
    "-i",
    srcPath,
    "-af",
    "loudnorm=I=-14:TP=-1.5:LRA=11",
    "-ar",
    "44100",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    m4aPath,
  ]);

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
