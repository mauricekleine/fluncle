import { spawn } from "node:child_process";

import { type Fingerprint } from "./matcher";
import { MEL_SAMPLE_RATE, melFrames } from "./mel";
import { type AdminAuth } from "./plan";

export type S16leSink = {
  finish: () => Float32Array;

  push: (chunk: Uint8Array) => void;
};

export function createS16leSink(seed = MEL_SAMPLE_RATE * 40): S16leSink {
  let samples = new Float32Array(seed);
  let count = 0;
  let leftover = -1;

  const push = (v: number): void => {
    if (count >= samples.length) {
      const grown = new Float32Array(Math.ceil(samples.length * 1.5) + MEL_SAMPLE_RATE);
      grown.set(samples);
      samples = grown;
    }
    samples[count++] = v;
  };

  const pushSample = (lo: number, hi: number): void => {
    const raw = lo | (hi << 8);
    push((raw >= 0x8000 ? raw - 0x10000 : raw) / 32768);
  };

  return {
    finish: () => (count === samples.length ? samples : samples.subarray(0, count)),
    push: (chunk) => {
      let i = 0;
      const end = chunk.length;
      if (leftover >= 0 && end > 0) {
        pushSample(leftover, chunk[0]);
        leftover = -1;
        i = 1;
      }
      for (; i + 1 < end; i += 2) {
        pushSample(chunk[i], chunk[i + 1]);
      }
      if (i < end) {
        leftover = chunk[i];
      }
    },
  };
}

async function decodeMono(input: string | Uint8Array): Promise<Float32Array> {
  const ffmpeg = process.env.FLUNCLE_FFMPEG ?? "ffmpeg";
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
    const child = spawn(ffmpeg, args, {
      stdio: [fromStdin ? "pipe" : "ignore", "pipe", "pipe"],
    });

    const sink = createS16leSink(MEL_SAMPLE_RATE * 40);
    let stderr = "";

    if (!child.stdout) {
      reject(new Error(`${ffmpeg} produced no stdout stream`));
      return;
    }
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    child.stdout.on("data", (chunk: Buffer) => {
      sink.push(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(sink.finish());
      } else {
        reject(new Error(`${ffmpeg} exited with ${code}\n${stderr.slice(-2000)}`));
      }
    });

    if (fromStdin && child.stdin) {
      child.stdin.write(Buffer.from(input));
      child.stdin.end();
    }
  });
}

export async function decodeMonoFile(path: string): Promise<Float32Array> {
  return await decodeMono(path);
}

export async function fingerprintFile(logId: string, path: string): Promise<Fingerprint> {
  return { frames: melFrames(await decodeMono(path)), logId };
}

async function fingerprintBytes(logId: string, bytes: Uint8Array): Promise<Fingerprint> {
  return { frames: melFrames(await decodeMono(bytes)), logId };
}

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

export async function fingerprintSourceAudio(logId: string, auth: AdminAuth): Promise<Fingerprint> {
  try {
    const res = await fetch(`${auth.base}/api/v1/admin/tracks/${logId}/source-audio`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    });
    if (!res.ok) {
      return { frames: null, logId };
    }
    return await fingerprintBytes(logId, new Uint8Array(await res.arrayBuffer()));
  } catch {
    return { frames: null, logId };
  }
}

export async function fingerprintPlanFullSong(
  logIds: string[],
  auth: AdminAuth,
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
      out[i] = await fingerprintSourceAudio(logIds[i], auth);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, logIds.length) }, worker));
  return out;
}
