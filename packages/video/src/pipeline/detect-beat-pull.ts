import path from "node:path";

import { extractGrayFrames, fenceFrames, structuralDelta } from "./frames";

const SAMPLE_W = 48;
const SAMPLE_H = 86;
const DEFAULT_FPS = 30;

export type BeatPullOptions = {
  fps?: number;

  lagMs?: number;

  threshold?: number;

  minFrames?: number;

  smoothFrames?: number;

  lowMotionFloor?: number;
};

export type BeatPullResult = {
  score: number;

  beatLocked: boolean;

  samples: number;

  lagFrames: number;

  pictureActivity: number;

  inconclusive?: string;
};

const DEFAULTS = {
  fps: DEFAULT_FPS,
  lagMs: 67,

  lowMotionFloor: 1.5,
  minFrames: 30,
  smoothFrames: 1,

  threshold: 0.16,
};

const meanArray = (xs: number[]): number => {
  if (xs.length === 0) {
    return 0;
  }
  let s = 0;
  for (const x of xs) {
    s += x;
  }
  return s / xs.length;
};

const meanAbsDiff = (a: Float32Array, b: Float32Array): number => {
  let d = 0;
  for (let p = 0; p < a.length; p++) {
    d += Math.abs(a[p] - b[p]);
  }
  return d / a.length;
};

export function extractFrames(videoPath: string): { fps: number; frames: Float32Array[] } {
  const { frames } = extractGrayFrames(videoPath, {
    height: SAMPLE_H,
    probeFps: false,
    width: SAMPLE_W,
  });
  return { fps: DEFAULT_FPS, frames };
}

export function scoreBeatPull(
  rawFrames: Float32Array[],
  options: BeatPullOptions = {},
): BeatPullResult {
  const fps = options.fps ?? DEFAULTS.fps;
  const lagMs = options.lagMs ?? DEFAULTS.lagMs;
  const threshold = options.threshold ?? DEFAULTS.threshold;
  const minFrames = options.minFrames ?? DEFAULTS.minFrames;
  const smoothFrames = options.smoothFrames ?? DEFAULTS.smoothFrames;
  const lowMotionFloor = options.lowMotionFloor ?? DEFAULTS.lowMotionFloor;

  const lag = Math.max(1, Math.round((lagMs / 1000) * fps));
  const n = rawFrames.length;

  const base: Omit<BeatPullResult, "inconclusive"> = {
    beatLocked: false,
    lagFrames: lag,
    pictureActivity: 0,
    samples: n,
    score: 0,
  };

  if (n < Math.max(minFrames, lag * 4)) {
    return { ...base, inconclusive: "too few frames to judge" };
  }

  const frames = fenceFrames(rawFrames, smoothFrames);
  const step = structuralDelta(rawFrames, { smoothFrames });
  if (step.every((s) => s === step[0])) {
    return { ...base, inconclusive: "no motion variation" };
  }

  const pictureActivity = meanArray(step);

  let sum = 0;
  let count = 0;
  for (let i = lag; i < n - lag; i++) {
    let pathLen = 0;
    for (let k = i - lag; k < i + lag; k++) {
      pathLen += step[k];
    }
    if (pathLen <= 1e-6) {
      continue;
    }
    const net = meanAbsDiff(frames[i - lag], frames[i + lag]);
    sum += Math.max(0, 1 - net / pathLen);
    count += 1;
  }

  const score = count > 0 ? sum / count : 0;

  if (score >= threshold && lowMotionFloor > 0 && pictureActivity < lowMotionFloor) {
    return {
      ...base,
      inconclusive: "lowMotion",
      pictureActivity,
      score,
    };
  }

  return { ...base, beatLocked: score >= threshold, pictureActivity, score };
}

function resolveVideo(target: string): string {
  if (target.endsWith(".mp4")) {
    return target;
  }
  const outDir = path.resolve(import.meta.dirname, "..", "..", "out");
  return path.join(outDir, `${target}.mp4`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith("--"));
  const asJson = args.includes("--json");

  if (!target) {
    console.error("usage: detect-beat-pull <trackId|video.mp4> [--json]");
    process.exit(2);
  }

  const { frames } = extractFrames(resolveVideo(target));
  const result = scoreBeatPull(frames);

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.inconclusive) {
    console.log(`~ beat-pull: inconclusive (${result.inconclusive})`);
  } else if (result.beatLocked) {
    console.error(
      `✗ BEAT-PULL DETECTED — the picture snaps back on the beat (reversal ${result.score.toFixed(2)}, threshold ${DEFAULTS.threshold}).\n` +
        `  Motion is being yanked by the kick and jittering back and forth. Move that reactivity off position/travel into material (brightness/width/scale) — Motion law, doctrine 7 — and re-render.`,
    );
  } else {
    console.log(`✓ motion flows — no snap-back (reversal ${result.score.toFixed(2)}).`);
  }

  process.exit(result.beatLocked ? 1 : 0);
}
