// Pure DSP helper tests — the bin-math + band rescaling shared by the slow (4096)
// and low-latency (1024) analysers, and the CALIBRATION-CRITICAL 40-bin log-mel
// frame the bridge fingerprint-matcher consumes. The class `Dsp` itself needs Web
// Audio (browser-only); these cover the extracted pure math that owns correctness.

import { describe, expect, test } from "bun:test";

import { bandEnergies, binHz, buildMelFilters, computeMelFrame } from "./dsp";

const SR = 48000;
const SLOW = 4096;
const FAST = 1024;

/** A dB spectrum (getFloatFrequencyData shape) with a Gaussian bump at `centerHz`. */
function bumpSpectrum(fftSize: number, centerHz: number, widthHz = 60): Float32Array {
  const n = fftSize / 2;
  const bins = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const hz = binHz(i, SR, fftSize);
    bins[i] = -120 + 100 * Math.exp(-((hz - centerHz) ** 2) / (2 * widthHz * widthHz));
  }
  return bins;
}

describe("binHz — bin width rescales with fftSize", () => {
  test("bin 0 is DC for any size", () => {
    expect(binHz(0, SR, SLOW)).toBe(0);
    expect(binHz(0, SR, FAST)).toBe(0);
  });

  test("the 1024 analyser has ~4x the bin width of the 4096 analyser", () => {
    expect(binHz(1, SR, SLOW)).toBeCloseTo(11.71875, 5); // 48000/4096
    expect(binHz(1, SR, FAST)).toBeCloseTo(46.875, 5); // 48000/1024
    expect(binHz(1, SR, FAST) / binHz(1, SR, SLOW)).toBeCloseTo(4, 6);
  });
});

describe("bandEnergies — correct bucketing at both resolutions", () => {
  test("a sub-bass bump lands in the bass band (4096)", () => {
    const b = bandEnergies(bumpSpectrum(SLOW, 60), SR, SLOW);
    expect(b.bass).toBeGreaterThan(b.mid);
    expect(b.bass).toBeGreaterThan(b.treble);
  });

  test("a sub-bass bump lands in the bass band (1024 — coarse bins still bucket right)", () => {
    const b = bandEnergies(bumpSpectrum(FAST, 60), SR, FAST);
    expect(b.bass).toBeGreaterThan(b.mid);
    expect(b.bass).toBeGreaterThan(b.treble);
  });

  test("a 1kHz bump lands in the mid band, an 8kHz bump in the treble band", () => {
    const mid = bandEnergies(bumpSpectrum(SLOW, 1000, 200), SR, SLOW);
    expect(mid.mid).toBeGreaterThan(mid.bass);
    expect(mid.mid).toBeGreaterThan(mid.treble);
    const treble = bandEnergies(bumpSpectrum(SLOW, 8000, 400), SR, SLOW);
    expect(treble.treble).toBeGreaterThan(treble.bass);
    expect(treble.treble).toBeGreaterThan(treble.mid);
  });

  test("bin 0 (DC) is excluded from every band", () => {
    const bins = new Float32Array(SLOW / 2).fill(-120);
    bins[0] = 0; // a huge DC term must not leak into bass
    const b = bandEnergies(bins, SR, SLOW);
    expect(b.bass).toBeLessThan(1e-3);
  });
});

describe("computeMelFrame — the fingerprint frame (calibration-locked)", () => {
  const filters = buildMelFilters();

  test("emits exactly MEL_BINS (40) bins", () => {
    expect(filters.length).toBe(40);
    expect(computeMelFrame(bumpSpectrum(SLOW, 120), SR, SLOW, filters).length).toBe(40);
  });

  test("is deterministic (same spectrum → identical frame)", () => {
    const s = bumpSpectrum(SLOW, 120);
    expect(computeMelFrame(s, SR, SLOW, filters)).toEqual(computeMelFrame(s, SR, SLOW, filters));
  });

  test("is frequency-discriminative: a low bump peaks in low bins, high in high bins", () => {
    const argmax = (v: number[]): number => v.reduce((best, x, i) => (x > v[best] ? i : best), 0);
    expect(argmax(computeMelFrame(bumpSpectrum(SLOW, 120), SR, SLOW, filters))).toBeLessThan(
      argmax(computeMelFrame(bumpSpectrum(SLOW, 6000, 400), SR, SLOW, filters)),
    );
  });

  // GOLDEN REGRESSION — the bridge matcher's thresholds are calibrated on this exact
  // computation over the 4096 path. Any drift in the mel math breaks these numbers;
  // that is the point. Re-run the matcher accuracy harness before touching them.
  test("matches the golden frame for a fixed 120Hz bump", () => {
    const mel = computeMelFrame(bumpSpectrum(SLOW, 120), SR, SLOW, filters);
    const golden = [0.005016, 0.156478, 0.190092, 0.008568, 0.000039, 0.000006, 0.000006];
    for (let i = 0; i < golden.length; i++) {
      expect(mel[i]).toBeCloseTo(golden[i], 6);
    }
    // and the energy concentrates in the low mel bins (argmax at bin 2)
    const argmax = mel.reduce((best, x, i) => (x > mel[best] ? i : best), 0);
    expect(argmax).toBe(2);
  });

  test("reads ONLY the buffer it is given (independent of any fast-path state)", () => {
    // The mel frame comes from the 4096 buffer alone; a separate (fast) buffer with
    // wildly different content must not affect it — the isolation the matcher relies on.
    const slowBins = bumpSpectrum(SLOW, 120);
    const before = computeMelFrame(slowBins, SR, SLOW, filters);
    const fastBins = bumpSpectrum(FAST, 6000, 400); // unrelated content
    void bandEnergies(fastBins, SR, FAST);
    const after = computeMelFrame(slowBins, SR, SLOW, filters);
    expect(after).toEqual(before);
  });
});
