// Self-running check for the FFT band-split — no framework. Verifies the radix-2
// FFT peaks a pure tone at the right bin; that computeBands ROUTES a tone to the
// correct band (the whole point — clean bass/mid/treble separation, vs the old
// one-pole bleed); that separation is clean; and that it's deterministic.
// Run: `bun src/pipeline/fft.test.ts` (exits non-zero on failure).

import assert from "node:assert/strict";

import { computeBands } from "./analyze-audio";
import { fftInPlace } from "./fft";

const SR = 22050;

const sine = (freq: number, seconds: number): Float32Array => {
  const n = Math.round(SR * seconds);
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    s[i] = Math.sin((2 * Math.PI * freq * i) / SR);
  }
  return s;
};

// 1. A pure tone peaks at its FFT bin.
{
  const N = 2048;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    re[i] = Math.sin((2 * Math.PI * 1000 * i) / SR);
  }
  fftInPlace(re, im);
  let peak = 0;
  let peakBin = 0;
  for (let k = 1; k <= N / 2; k++) {
    const m = re[k] * re[k] + im[k] * im[k];
    if (m > peak) {
      peak = m;
      peakBin = k;
    }
  }
  const expected = Math.round(1000 / (SR / N)); // ~93
  assert.ok(
    Math.abs(peakBin - expected) <= 1,
    `1kHz should peak near bin ${expected}, got ${peakBin}`,
  );
}

// 2. computeBands routes a tone to the correct band.
const sum = (a: Float32Array): number => a.reduce((acc, v) => acc + v, 0);
const dominantBand = (freq: number): string => {
  const b = computeBands({ sampleRate: SR, samples: sine(freq, 1) });
  const B = sum(b.bass);
  const M = sum(b.mid);
  const H = sum(b.high);
  if (B >= M && B >= H) {
    return "bass";
  }
  return M >= H ? "mid" : "high";
};
assert.equal(dominantBand(60), "bass", "60Hz → bass");
assert.equal(dominantBand(1000), "mid", "1kHz → mid");
assert.equal(dominantBand(6000), "high", "6kHz → treble");

// 3. Clean separation: a 60Hz tone leaves mid/treble near-silent vs bass (the
// old one-pole bleed is gone).
{
  const b = computeBands({ sampleRate: SR, samples: sine(60, 1) });
  const B = sum(b.bass);
  const M = sum(b.mid);
  const H = sum(b.high);
  assert.ok(
    B > 5 * Math.max(M, H),
    `a bass tone should dwarf the other bands (bass ${B.toFixed(1)} vs mid ${M.toFixed(1)} / high ${H.toFixed(1)})`,
  );
}

// 4. Determinism.
const s = sine(440, 0.5);
const a1 = computeBands({ sampleRate: SR, samples: s });
const a2 = computeBands({ sampleRate: SR, samples: s });
assert.deepEqual(Array.from(a1.bass), Array.from(a2.bass), "bands must be deterministic");

console.log(
  "✓ fft band-split: tone peaks at its bin, routes to the right band, clean + deterministic",
);
