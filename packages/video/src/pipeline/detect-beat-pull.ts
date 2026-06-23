// The beat-pull gate. A rendered clip "beat-pulls" when the kick yanks its MOTION:
// the picture jumps on the beat and SNAPS BACK between beats — it jitters back and
// forth (Motion law, doctrine 7). The kit forbids it (motion rides smoothed
// envelopes, never the raw per-beat transient), but a composition can break the
// law, and the artifact is INVISIBLE in stills — it only exists across frames. The
// still-critique loop can't catch it, so the hands-off render automation ships it.
// This is the objective check that closes that hole.
//
// What it measures — and what it must NOT punish. The defining feature of the
// artifact is REVERSAL: the picture moves, then undoes that move (snaps back). That
// is different from a clip that simply moves a lot, or hits hard ON the beat — a
// crisp musical surge that advances and flows on is exactly what doctrine 9 WANTS,
// and it must pass. So the signal is the mean SHORT-LAG REVERSAL of a brightness-
// normalised frame sequence:
//   - reversal at lag L = how much frame[t+L] returns toward frame[t-L] relative to
//     the path the picture actually travelled in between. ~0 = directed motion
//     (drift, a forward surge); →1 = it came back where it started (oscillation).
//   - brightness-normalised (each frame's mean luma removed first) so an ALLOWED
//     beat-locked glow/exposure pulse doesn't read as motion.
//   - temporally pre-smoothed (a short box low-pass) so FILM GRAIN doesn't read as
//     motion. Grain reseeds at ~24Hz; over a low-motion clip that per-frame flicker
//     would otherwise dominate the reversal ratio (a real clip measured ~40% of its
//     raw score as grain). The beat is ~3Hz, well below the smoother's cutoff, so
//     the structural motion survives and the grain is removed. This matters: without
//     it, slowing the grain clock alone "passes" the gate while a real motion pull
//     remains — a false fix.
// A beat-locked SURGE modulates motion strongly but reverses little; a beat-PULL
// reverses on every kick. Mean reversal separates them — measured directly, not via
// the beat grid (the symptom is the jitter itself, whatever drives it), so the gate
// needs only the video.

import path from "node:path";

import { extractGrayFrames, fenceFrames, structuralDelta } from "./frames";

// Downscaled gray frame the motion is computed on. Small on purpose: we want the
// GLOBAL motion of the picture, not micro-texture churn, and it keeps the raw pipe
// to a few MB.
const SAMPLE_W = 48;
const SAMPLE_H = 86; // ~9:16 of SAMPLE_W, forced even.
const DEFAULT_FPS = 30;

export type BeatPullOptions = {
  /** Frames per second of the clip. The kit renders 30. */
  fps?: number;
  /** Lag (ms) over which a return counts as a snap-back. ~70ms = fast jitter. */
  lagMs?: number;
  /** Mean-reversal at/above which the motion reads as jittering back and forth. */
  threshold?: number;
  /** Minimum frames required to judge; fewer → inconclusive (passes). */
  minFrames?: number;
  /**
   * Temporal smoothing half-window (frames) applied BEFORE measuring reversal.
   * This is the grain fence: film grain reseeds at ~24Hz, the beat is ~3Hz, so a
   * short box low-pass removes the per-frame grain flicker that would otherwise be
   * scored as snap-back, leaving structural MOTION. 0 disables it.
   */
  smoothFrames?: number;
};

export type BeatPullResult = {
  /** Mean short-lag reversal, 0..1. Higher = more snap-back / back-and-forth. */
  score: number;
  /** True when reversal is at/above threshold — the picture jitters. */
  beatLocked: boolean;
  /** Frames analysed. */
  samples: number;
  /** The lag (frames) reversal was measured over. */
  lagFrames: number;
  /** Set when the clip can't be judged (too few frames / no motion). */
  inconclusive?: string;
};

const DEFAULTS = {
  fps: DEFAULT_FPS,
  lagMs: 67, // ~2 frames at 30fps — the fast-jitter band where snap-back lives
  minFrames: 30,
  smoothFrames: 1, // ±1 → 3-frame box low-pass; kills ~24Hz grain, keeps ~3Hz beat motion
  // Calibrated against rendered clips on the GRAIN-HARDENED signal (3-frame
  // pre-smooth — see detect-beat-pull.test.ts). Without it the metric is dominated
  // by film-grain flicker on low-motion clips (a clip's raw 0.42 was ~40% grain).
  // Hardened, clean clips cluster at ~0.10 and operator-confirmed motion pulls sit
  // at 0.24+.
  //
  // PROVISIONAL re-calibration (2026-06-23, n=3 beat-having tracks, advisory): the
  // global-vs-internal motion law (out/overnight/INSIGHTS.md) showed beat-pull is
  // the right detector for the whole-vehicle JUMP, but 0.17 under-caught by ~0.01 —
  // operator-labelled jumpers ("DJ scratch" / uncapped-swell drift surge) sat at
  // 0.164 while the alive exemplar sat at 0.157. 0.16 splits that gap: it catches
  // the jumpers and passes the alive clip. Re-validate as more labelled clips land.
  threshold: 0.16,
};

const meanAbsDiff = (a: Float32Array, b: Float32Array): number => {
  let d = 0;
  for (let p = 0; p < a.length; p++) {
    d += Math.abs(a[p] - b[p]);
  }
  return d / a.length;
};

/**
 * Pull the downscaled gray frames from a video as raw luma (NOT yet normalised —
 * the scorer removes per-frame brightness). Thin wrapper over the shared
 * `extractGrayFrames` (frames.ts) pinned to the gate's 48×86 grid and fps=30: the
 * 0.17 threshold was earned at 30fps, so the gate asserts the rate rather than
 * probing it. Timeline-aligned metrics (coupling/intent) probe the real fps
 * separately.
 */
export function extractFrames(videoPath: string): { fps: number; frames: Float32Array[] } {
  const { frames } = extractGrayFrames(videoPath, {
    height: SAMPLE_H,
    probeFps: false,
    width: SAMPLE_W,
  });
  return { fps: DEFAULT_FPS, frames };
}

/**
 * Score a frame sequence for beat-pull. Pure and deterministic. Removes each
 * frame's mean luma (so a uniform brightness pulse isn't read as motion), then
 * measures the mean short-lag reversal: how often the picture undoes its own
 * motion. Returns the reversal score and the pass/fail.
 */
export function scoreBeatPull(
  rawFrames: Float32Array[],
  options: BeatPullOptions = {},
): BeatPullResult {
  const fps = options.fps ?? DEFAULTS.fps;
  const lagMs = options.lagMs ?? DEFAULTS.lagMs;
  const threshold = options.threshold ?? DEFAULTS.threshold;
  const minFrames = options.minFrames ?? DEFAULTS.minFrames;
  const smoothFrames = options.smoothFrames ?? DEFAULTS.smoothFrames;

  const lag = Math.max(1, Math.round((lagMs / 1000) * fps));
  const n = rawFrames.length;

  const base: Omit<BeatPullResult, "inconclusive"> = {
    beatLocked: false,
    lagFrames: lag,
    samples: n,
    score: 0,
  };

  if (n < Math.max(minFrames, lag * 4)) {
    return { ...base, inconclusive: "too few frames to judge" };
  }

  // Mean-subtract + the grain fence, then the consecutive-frame motion — the ONE
  // shared structural pipeline (frames.ts). `fenceFrames` brightness-normalises
  // each frame (so a uniform glow/exposure pulse leaves no motion behind) and
  // applies the ±smoothFrames temporal box low-pass (film grain reseeds ~24Hz,
  // the beat is ~3Hz, so the box pass removes grain flicker and keeps structural
  // motion). `structuralDelta` is the per-step `meanAbsDiff` over those fenced
  // frames — the same `step[]` coupling/dead-zone/intent consume, so the gate and
  // the aliveness metrics agree byte-for-byte on what "structural change" means.
  const frames = fenceFrames(rawFrames, smoothFrames);
  const step = structuralDelta(rawFrames, { smoothFrames });
  if (step.every((s) => s === step[0])) {
    return { ...base, inconclusive: "no motion variation" };
  }

  // Reversal at lag L: 1 − (net change over 2L) / (path travelled over 2L). High
  // when the picture returned toward where it was — the snap-back.
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

  return { ...base, beatLocked: score >= threshold, score };
}

function resolveVideo(target: string): string {
  if (target.endsWith(".mp4")) {
    return target;
  }
  const outDir = path.resolve(import.meta.dirname, "..", "..", "out");
  return path.join(outDir, `${target}.mp4`);
}

// CLI: `bun src/pipeline/detect-beat-pull.ts <trackId|video.mp4> [--json]`
// Exits 1 when the picture jitters/snaps back, so it gates the render before ship.
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
