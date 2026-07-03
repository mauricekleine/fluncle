// Server-side fingerprinting: decode a preview (or, in the accuracy harness, a
// whole set) to mono PCM at MEL_SAMPLE_RATE via ffmpeg, then compute its log-mel
// frames (`mel.ts`). The decode mirrors packages/video/src/pipeline/analyze-set.ts:
// a STREAMING s16le pipe converted chunk-by-chunk into one pre-sized Float32Array,
// so a multi-GB byte buffer is never materialized. Previews are tiny (30s); the
// stream path matters only for the offline set replay.
//
// At show start the bridge fingerprints each planned finding's official 30s
// preview — the SAME source the de-risk spike used
// (https://www.fluncle.com/api/preview/<logId>, open CORS). The result is the
// tiny (~17-candidate) search space the matcher scores the live feed against.

import { spawn } from "node:child_process";

import { type Fingerprint } from "./matcher";
import { MEL_SAMPLE_RATE, melFrames } from "./mel";

// ffmpeg on PATH by default (mirrors download-preview.ts's FLUNCLE_FFMPEG).
const FFMPEG = process.env.FLUNCLE_FFMPEG ?? "ffmpeg";

/**
 * Decode audio to mono Float32 PCM at MEL_SAMPLE_RATE, streaming ffmpeg's raw
 * s16le stdout. `input` is either a file path / URL (passed to `-i`) or raw
 * container bytes piped to stdin. Pre-sizes when possible, grows if needed.
 */
async function decodeMono(input: string | Uint8Array): Promise<Float32Array> {
  const fromStdin = typeof input !== "string";
  const args = [
    "-v",
    "error",
    "-i",
    fromStdin ? "pipe:0" : input,
    "-ac",
    "1",
    "-ar",
    String(MEL_SAMPLE_RATE),
    "-f",
    "s16le",
    "-acodec",
    "pcm_s16le",
    "pipe:1",
  ];

  return await new Promise<Float32Array>((resolve, reject) => {
    const child = spawn(FFMPEG, args, {
      stdio: [fromStdin ? "pipe" : "ignore", "pipe", "pipe"],
    });

    let samples = new Float32Array(MEL_SAMPLE_RATE * 40); // ~40s seed; grows as needed
    let count = 0;
    let leftover = -1; // a low byte carried across a chunk boundary, or -1
    let stderr = "";

    const push = (v: number): void => {
      if (count >= samples.length) {
        const grown = new Float32Array(Math.ceil(samples.length * 1.5) + MEL_SAMPLE_RATE);
        grown.set(samples);
        samples = grown;
      }
      samples[count++] = v;
    };

    if (!child.stdout) {
      reject(new Error(`${FFMPEG} produced no stdout stream`));
      return;
    }
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    child.stdout.on("data", (chunk: Buffer) => {
      let i = 0;
      const end = chunk.length;
      if (leftover >= 0 && end > 0) {
        const raw = leftover | (chunk[0] << 8);
        push((raw >= 0x8000 ? raw - 0x10000 : raw) / 32768);
        leftover = -1;
        i = 1;
      }
      for (; i + 1 < end; i += 2) {
        push(chunk.readInt16LE(i) / 32768);
      }
      if (i < end) {
        leftover = chunk[i];
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(count === samples.length ? samples : samples.subarray(0, count));
      } else {
        reject(new Error(`${FFMPEG} exited with ${code}\n${stderr.slice(-2000)}`));
      }
    });

    if (fromStdin && child.stdin) {
      child.stdin.write(Buffer.from(input));
      child.stdin.end();
    }
  });
}

/** Decode a local audio file to mono Float32 PCM at MEL_SAMPLE_RATE (accuracy harness). */
export async function decodeMonoFile(path: string): Promise<Float32Array> {
  return await decodeMono(path);
}

/** Fingerprint a local audio file (used by the offline accuracy harness). */
export async function fingerprintFile(logId: string, path: string): Promise<Fingerprint> {
  return { frames: melFrames(await decodeMono(path)), logId };
}

/** Fingerprint raw container bytes (a fetched preview held in memory). */
export async function fingerprintBytes(logId: string, bytes: Uint8Array): Promise<Fingerprint> {
  return { frames: melFrames(await decodeMono(bytes)), logId };
}

/**
 * Fetch a finding's official 30s preview and fingerprint it. Returns a
 * null-`frames` fingerprint (matcher skips it) when the finding has no preview or
 * the fetch fails — the show goes on; the operator nudges past an unmatched track.
 */
export async function fingerprintPreview(
  logId: string,
  baseUrl = "https://www.fluncle.com",
): Promise<Fingerprint> {
  try {
    const res = await fetch(`${baseUrl}/api/preview/${logId}`);
    if (!res.ok) {
      return { frames: null, logId };
    }
    return await fingerprintBytes(logId, new Uint8Array(await res.arrayBuffer()));
  } catch {
    return { frames: null, logId };
  }
}

/**
 * Fingerprint a whole plan's previews concurrently (bounded) at show start. The
 * bridge holds the result for the entire show — the matcher never touches the
 * network again (the never-crash rail).
 */
export async function fingerprintPlan(
  logIds: string[],
  baseUrl?: string,
  concurrency = 4,
): Promise<Fingerprint[]> {
  const out: Fingerprint[] = Array.from({ length: logIds.length });
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= logIds.length) {
        return;
      }
      out[i] = await fingerprintPreview(logIds[i], baseUrl);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, logIds.length) }, worker));
  return out;
}
