import { spawnSync } from "node:child_process";

const DEFAULT_FPS = 30;

export type GrayFrames = {
  fps: number;
  width: number;
  height: number;
  frames: Float32Array[];
};

export type RgbFrames = {
  fps: number;
  width: number;
  height: number;

  frames: Float32Array[];
};

const BEAT_PULL_W = 48;
const BEAT_PULL_H = 86;

export function probeFps(videoPath: string): number {
  const result = spawnSync("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=r_frame_rate",
    "-of",
    "csv=p=0",
    videoPath,
  ]);
  if (result.status !== 0 || !result.stdout) {
    return DEFAULT_FPS;
  }
  const raw = result.stdout.toString().trim();
  const slash = raw.indexOf("/");
  if (slash < 0) {
    const direct = Number.parseFloat(raw);
    return Number.isFinite(direct) && direct > 0 ? direct : DEFAULT_FPS;
  }
  const num = Number.parseFloat(raw.slice(0, slash));
  const den = Number.parseFloat(raw.slice(slash + 1));
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0 || num <= 0) {
    return DEFAULT_FPS;
  }
  return num / den;
}

export function probeDurationSec(videoPath: string): number {
  const result = spawnSync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    videoPath,
  ]);
  if (result.status !== 0 || !result.stdout) {
    return 0;
  }
  const dur = Number.parseFloat(result.stdout.toString().trim());
  return Number.isFinite(dur) && dur > 0 ? dur : 0;
}

export function extractGrayFrames(
  videoPath: string,
  opts: { width?: number; height?: number; probeFps?: boolean } = {},
): GrayFrames {
  const width = opts.width ?? BEAT_PULL_W;
  const height = opts.height ?? BEAT_PULL_H;

  const result = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      videoPath,
      "-an",
      "-vf",
      `scale=${width}:${height}:flags=area,format=gray`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "-",
    ],
    { maxBuffer: 512 * 1024 * 1024 },
  );

  if (result.status !== 0 || !result.stdout) {
    throw new Error(
      `ffmpeg gray frame extraction failed for ${videoPath}: ${result.stderr?.toString() ?? "no output"}`,
    );
  }

  const buf = result.stdout;
  const frameSize = width * height;
  const count = Math.floor(buf.length / frameSize);
  const frames: Float32Array[] = [];

  for (let f = 0; f < count; f++) {
    const base = f * frameSize;
    const frame = new Float32Array(frameSize);
    for (let p = 0; p < frameSize; p++) {
      frame[p] = buf[base + p];
    }
    frames.push(frame);
  }

  const fps = opts.probeFps ? probeFps(videoPath) : DEFAULT_FPS;
  return { fps, frames, height, width };
}

export function extractRgbFrames(
  videoPath: string,
  opts: { width?: number; height?: number; probeFps?: boolean } = {},
): RgbFrames {
  const width = opts.width ?? BEAT_PULL_W;
  const height = opts.height ?? BEAT_PULL_H;

  const result = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      videoPath,
      "-an",
      "-vf",
      `scale=${width}:${height}:flags=area,format=rgb24`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ],
    { maxBuffer: 512 * 1024 * 1024 },
  );

  if (result.status !== 0 || !result.stdout) {
    throw new Error(
      `ffmpeg rgb frame extraction failed for ${videoPath}: ${result.stderr?.toString() ?? "no output"}`,
    );
  }

  const buf = result.stdout;
  const frameSize = width * height * 3;
  const count = Math.floor(buf.length / frameSize);
  const frames: Float32Array[] = [];

  for (let f = 0; f < count; f++) {
    const base = f * frameSize;
    const frame = new Float32Array(frameSize);
    for (let p = 0; p < frameSize; p++) {
      frame[p] = buf[base + p];
    }
    frames.push(frame);
  }

  const fps = opts.probeFps ? probeFps(videoPath) : DEFAULT_FPS;
  return { fps, frames, height, width };
}

export type RgbImage = {
  width: number;
  height: number;

  data: Float32Array;
};

export function decodeImageRgb(
  imagePath: string,
  opts: { width: number; height: number },
): RgbImage {
  const { width, height } = opts;
  const result = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      imagePath,
      "-vf",
      `scale=${width}:${height}:flags=area,format=rgb24`,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ],
    { maxBuffer: 128 * 1024 * 1024 },
  );
  if (result.status !== 0 || !result.stdout) {
    throw new Error(
      `ffmpeg image decode failed for ${imagePath}: ${result.stderr?.toString() ?? "no output"}`,
    );
  }
  const buf = result.stdout;
  const expected = width * height * 3;
  if (buf.length < expected) {
    throw new Error(
      `ffmpeg image decode for ${imagePath} produced ${buf.length} bytes, expected ${expected}`,
    );
  }
  const data = new Float32Array(expected);
  for (let p = 0; p < expected; p++) {
    data[p] = buf[p];
  }
  return { data, height, width };
}

const meanAbsDiff = (a: Float32Array, b: Float32Array): number => {
  let d = 0;
  for (let p = 0; p < a.length; p++) {
    d += Math.abs(a[p] - b[p]);
  }
  return d / a.length;
};

export function fenceFrames(rawFrames: Float32Array[], smoothFrames: number): Float32Array[] {
  const n = rawFrames.length;
  if (n === 0) {
    return [];
  }

  const normalised = rawFrames.map((f) => {
    let sum = 0;
    for (let p = 0; p < f.length; p++) {
      sum += f[p];
    }
    const mean = sum / f.length;
    const out = new Float32Array(f.length);
    for (let p = 0; p < f.length; p++) {
      out[p] = f[p] - mean;
    }
    return out;
  });

  if (smoothFrames <= 0) {
    return normalised;
  }

  return normalised.map((_, i) => {
    const out = new Float32Array(normalised[0].length);
    const lo = Math.max(0, i - smoothFrames);
    const hi = Math.min(n - 1, i + smoothFrames);
    for (let j = lo; j <= hi; j++) {
      for (let p = 0; p < out.length; p++) {
        out[p] += normalised[j][p];
      }
    }
    const w = hi - lo + 1;
    for (let p = 0; p < out.length; p++) {
      out[p] /= w;
    }
    return out;
  });
}

export function structuralDelta(
  rawFrames: Float32Array[],
  opts: { smoothFrames?: number } = {},
): number[] {
  const smoothFrames = opts.smoothFrames ?? 1;
  const fenced = fenceFrames(rawFrames, smoothFrames);
  const n = fenced.length;
  const delta: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    delta.push(meanAbsDiff(fenced[i], fenced[i + 1]));
  }
  return delta;
}
