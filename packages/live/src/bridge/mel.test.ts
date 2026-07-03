// Pure log-mel feature tests — the filterbank shape, per-frame L2-normalization,
// and framing. No ffmpeg (synthetic PCM); the real-audio path is exercised by the
// fixture accuracy run (accuracy.ts, excluded from `bun test`).

import { describe, expect, test } from "bun:test";

import { MEL_BINS } from "../contract";
import { l2Normalize, MEL_FFT_SIZE, MEL_HOP, MEL_SAMPLE_RATE, melFrameAt, melFrames } from "./mel";

/** A pure sine tone of `freqHz` at the mel sample rate. */
function tone(freqHz: number, samples: number): Float32Array {
  const s = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    s[i] = Math.sin((2 * Math.PI * freqHz * i) / MEL_SAMPLE_RATE);
  }
  return s;
}

describe("l2Normalize", () => {
  test("produces a unit-norm vector", () => {
    const v = l2Normalize(Float32Array.from([3, 4, 0]));
    const norm = Math.hypot(v[0], v[1], v[2]);
    expect(norm).toBeCloseTo(1, 6);
  });

  test("a zero vector stays finite (no divide-by-zero)", () => {
    const v = l2Normalize(new Float32Array(MEL_BINS));
    expect(v.every((x) => Number.isFinite(x))).toBe(true);
  });
});

describe("melFrames framing", () => {
  test("emits the expected frame count for a signal length", () => {
    const sig = tone(440, MEL_FFT_SIZE + MEL_HOP * 9); // exactly 10 frames
    expect(melFrames(sig).length).toBe(10);
  });

  test("each frame has MEL_BINS bins and is L2-normalized", () => {
    const frames = melFrames(tone(440, MEL_FFT_SIZE + MEL_HOP * 4));
    for (const f of frames) {
      expect(f.length).toBe(MEL_BINS);
      let n = 0;
      for (let i = 0; i < f.length; i++) {
        n += f[i] * f[i];
      }
      expect(Math.sqrt(n)).toBeCloseTo(1, 4);
    }
  });

  test("a short signal yields zero frames", () => {
    expect(melFrames(new Float32Array(MEL_FFT_SIZE - 1)).length).toBe(0);
  });
});

describe("mel is frequency-discriminative", () => {
  test("a low tone concentrates energy in low bins; a high tone in high bins", () => {
    const low = melFrameAt(tone(200, MEL_FFT_SIZE), 0);
    const high = melFrameAt(tone(6000, MEL_FFT_SIZE), 0);
    // argmax bin of each
    const argmax = (v: Float32Array): number => {
      let best = 0;
      for (let i = 1; i < v.length; i++) {
        if (v[i] > v[best]) {
          best = i;
        }
      }
      return best;
    };
    expect(argmax(low)).toBeLessThan(argmax(high));
  });

  test("the same tone gives a self-cosine of ~1 across frames", () => {
    const frames = melFrames(tone(1000, MEL_FFT_SIZE + MEL_HOP * 3));
    let dot = 0;
    for (let i = 0; i < MEL_BINS; i++) {
      dot += frames[0][i] * frames[1][i];
    }
    expect(dot).toBeGreaterThan(0.99);
  });
});
