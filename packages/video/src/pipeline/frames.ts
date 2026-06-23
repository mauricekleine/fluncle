// Shared frame extraction + the structural-delta signal the motion metrics agree
// on. Factored out of detect-beat-pull.ts so the beat-pull gate (snap-back) and
// the new aliveness metrics (analyze-motion.ts: coupling, dead-zone, intent) all
// read "the picture changed" the SAME way — there is one definition of structural
// change, and the calibrated beat-pull score sits on top of it unchanged.
//
// Three extractors, all one ffmpeg invocation each:
//   - extractGrayFrames : area-downscale gray, raw luma 0..255 (NOT normalised).
//                         The 48×86 grid is the gate grid (global structural
//                         change, micro-texture averaged out by flags=area).
//   - extractRgbFrames  : rgb24, for flash-safety (true BT.709 relative luminance
//                         + the red-flash channels). Brightness change is the
//                         signal, so it is NOT normalised and NOT temporally fenced.
//   - probeFps / probeDurationSec : ffprobe reads for timeline alignment.

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
  /** Interleaved RGB, 3 bytes/pixel, raw 0..255 (length = width*height*3). */
  frames: Float32Array[];
};

const BEAT_PULL_W = 48;
const BEAT_PULL_H = 86;

/**
 * ffprobe the real frame rate. ffmpeg reports `r_frame_rate` as an `a/b` ratio
 * (e.g. "30000/1001"); evaluate it. Falls back to 30 if the probe fails or the
 * value is unparseable — the kit renders 30, so the fallback is the common case.
 */
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

/**
 * ffprobe the duration in seconds (mirrors ship.ts's poster-frame probe). Falls
 * back to 0 when unavailable; callers prefer frames/fps when they need a length.
 */
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

/**
 * Pull area-downscaled gray frames from a video as raw luma 0..255 (NOT
 * normalised — every consumer decides its own normalisation). `flags=area`
 * box-averages the source pixels so fine grain is partly removed spatially
 * before anything else runs. When `probeFps` is true the returned `fps` is the
 * real rate (timeline-aligned metrics need it); otherwise it is pinned to 30
 * (the beat-pull gate's earned calibration).
 */
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

/**
 * Pull area-downscaled rgb24 frames as raw interleaved channels 0..255 (3
 * bytes/pixel). Used by flash-safety, which needs the true sRGB channels to
 * compute BT.709 relative luminance and the red-flash chromaticity — gray would
 * pre-collapse the channels. NOT normalised, NOT fenced: brightness change is
 * the very signal flash safety measures.
 */
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

const meanAbsDiff = (a: Float32Array, b: Float32Array): number => {
  let d = 0;
  for (let p = 0; p < a.length; p++) {
    d += Math.abs(a[p] - b[p]);
  }
  return d / a.length;
};

/**
 * The shared structural-change pipeline: mean-subtract each frame (so an allowed
 * uniform glow/exposure pulse leaves no structural signal behind), apply a
 * ±smoothFrames temporal box low-pass (the grain fence — film grain reseeds at
 * ~24Hz, the beat is ~3Hz, so the box pass removes per-frame grain flicker and
 * keeps structural motion), and return the fenced frames. Both `scoreBeatPull`'s
 * reversal math and `structuralDelta` consume this, so they agree byte-for-byte
 * on what "structural" means. Exported so analyze-motion can reuse the exact
 * representation the calibrated gate trusts.
 */
export function fenceFrames(rawFrames: Float32Array[], smoothFrames: number): Float32Array[] {
  const n = rawFrames.length;
  if (n === 0) {
    return [];
  }

  // Brightness-normalise: subtract each frame's mean so a uniform glow/exposure
  // pulse leaves no motion behind — only structural movement does.
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

  // Temporal box low-pass over ±smoothFrames (the grain fence).
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

/**
 * The per-frame structural-change series: consecutive `meanAbsDiff` over the
 * fenced (mean-subtracted + temporally smoothed) frames. This is the `step[]`
 * the beat-pull scorer computes internally; coupling, dead-zone, and the intent
 * checker all consume it so they measure the same "the picture changed" signal.
 * Length is `frames.length - 1`.
 */
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
