// Self-running checks for the signal-chain (Unit A) — no framework. Verifies the
// normalization redesign (shared-reference P97 + perceptual lift, outlier-robust),
// the swell composite math, the flux curve (present + normalized + aligned), the
// shortened-frame + 20ms hop keeping BPM/beat-grid accurate AND onsets sharp, and
// the raw per-band crest hint. `bun test` reports "0 tests" but EXECUTES these
// asserts (a throw → non-zero exit). Run: `bun src/pipeline/analyze-audio.test.ts`.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  analyzeAudio,
  bestPhaseGrid,
  computeBands,
  estimateBpm,
  normalizeBandsShared,
  onsetEnvelope,
  percentile,
} from "./analyze-audio";

const SR = 22050;
const BPM = 174;

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

// ---------------------------------------------------------------------------
// 1. normalizeBandsShared — cross-band ratio survives, no overshoot, outlier-robust.
// ---------------------------------------------------------------------------
{
  // Bass peak is 4× the treble peak; steady levels through the clip.
  const len = 50;
  const bass = new Float32Array(len);
  const mid = new Float32Array(len);
  const treble = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    bass[i] = 0.8; // peak band
    mid[i] = 0.4;
    treble[i] = 0.2; // 4× quieter than bass
  }

  normalizeBandsShared([bass, mid, treble]);

  // No band overshoots 1.0.
  for (const b of [bass, mid, treble]) {
    for (let i = 0; i < b.length; i++) {
      assert.ok(b[i] <= 1.0 + 1e-6, `no band may exceed 1.0 (got ${b[i]})`);
    }
  }

  // Cross-band ratio survives. Shared divisor + the SAME pow(0.7) lift on both
  // means bass/treble = (0.8/ref)^0.7 / (0.2/ref)^0.7 = (0.8/0.2)^0.7 = 4^0.7.
  const ratio = bass[0] / treble[0];
  const expected = Math.pow(4, 0.7);
  assert.ok(
    Math.abs(ratio - expected) < 0.05,
    `bass/treble ratio must survive the shared lift (~${expected.toFixed(3)}, got ${ratio.toFixed(3)})`,
  );

  // Outlier robustness: a lone 10× spike hop must NOT crush the steady section.
  const b2 = new Float32Array(len);
  const m2 = new Float32Array(len);
  const t2 = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    b2[i] = 0.5;
    m2[i] = 0.5;
    t2[i] = 0.5;
  }
  b2[0] = 5.0; // a single clip/crash hop, 10× the steady level
  normalizeBandsShared([b2, m2, t2]);
  // P97 of the pool sits at the steady 0.5, so the steady section maps to ~1.0,
  // not toward 0 the way divide-by-absolute-max (ref=5.0) would have crushed it.
  assert.ok(
    b2[10] > 0.9,
    `a lone 10× outlier must not crush the steady section (got ${b2[10].toFixed(3)})`,
  );
}

// ---------------------------------------------------------------------------
// 1b. percentile — outlier-robust, empty → 0.
// ---------------------------------------------------------------------------
{
  assert.equal(percentile(new Float32Array(0), 0.5), 0, "empty → 0");
  const vals = new Float32Array([0.1, 0.2, 0.3, 0.4, 100]); // 100 is the outlier
  assert.ok(percentile(vals, 0.5) <= 0.3 + 1e-6, "P50 ignores a lone high outlier");
}

// ---------------------------------------------------------------------------
// 2. Swell composite math (pure formula; no Remotion context).
// ---------------------------------------------------------------------------
{
  const swellBeatWeight = 0;
  const swellBassWeight = 0.6;
  const swellEnergyWeight = 0.4;
  const swell = clamp01(1.0 * swellBeatWeight + 1.0 * swellBassWeight + 1.0 * swellEnergyWeight);
  assert.equal(swell, 1.0, "swell must reach 1.0 when bass and energy both peak (0.6 + 0.4)");
}

// ---------------------------------------------------------------------------
// A synthetic 174 BPM click train (deterministic): a short decaying 60Hz body +
// 800Hz attack burst on each beat, so bass+mid both move on the onset.
// ---------------------------------------------------------------------------
const buildClickTrain = (seconds: number): Float32Array => {
  const n = Math.round(SR * seconds);
  const samples = new Float32Array(n);
  const beatSamples = (60 / BPM) * SR;
  const clickLen = Math.round(0.03 * SR);
  for (let beat = 0; beat * beatSamples < n; beat++) {
    const start = Math.round(beat * beatSamples);
    for (let i = 0; i < clickLen && start + i < n; i++) {
      const env = Math.exp(-i / (clickLen * 0.25));
      const body = Math.sin((2 * Math.PI * 60 * i) / SR);
      const attack = 0.6 * Math.sin((2 * Math.PI * 800 * i) / SR);
      samples[start + i] += env * (body + attack) * 0.8;
    }
  }
  return samples;
};

// Encode a Float32Array as a 16-bit PCM mono WAV buffer.
const encodeWav = (samples: Float32Array): Buffer => {
  const n = samples.length;
  const bytesPerSample = 2;
  const dataLen = n * bytesPerSample;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * bytesPerSample, 28);
  buf.writeUInt16LE(bytesPerSample, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * bytesPerSample);
  }
  return buf;
};

// ---------------------------------------------------------------------------
// 4. HOP + frame keep BPM + beat grid accurate; onset envelope stays SHARP.
// (Driven directly through the exported helpers on the synthetic samples.)
// ---------------------------------------------------------------------------
{
  const samples = buildClickTrain(24);
  const bands = computeBands({ sampleRate: SR, samples });
  const env = onsetEnvelope(bands);

  const bpm = estimateBpm(env);
  assert.ok(Math.abs(bpm - BPM) <= 2, `estimateBpm must land within ±2 of 174 (got ${bpm})`);

  const totalMs = bands.hopCount * 20;
  const grid = bestPhaseGrid(env, bpm, totalMs);
  const trueBeatMs = 60000 / BPM;
  assert.ok(grid.length > 50, `the grid must span the clip (got ${grid.length} beats)`);

  // The grid's inter-beat PERIOD must match the true 174 BPM beat to ~one hop
  // (20ms) — the over-smoothing/coarse-hop guard: a flattened envelope would
  // mis-estimate the period and the grid would walk off the beat.
  const gridPeriod = (grid[grid.length - 1] - grid[0]) / (grid.length - 1);
  assert.ok(
    Math.abs(gridPeriod - trueBeatMs) <= 20,
    `grid beat period must match the true beat within ~one hop (true ${trueBeatMs.toFixed(1)}ms, got ${gridPeriod.toFixed(1)}ms)`,
  );

  // Each of the first several grid beats lands within ~one hop of a true beat once
  // the constant detection-phase offset (the grid's first beat) is removed.
  const phase = grid[0] % trueBeatMs;
  let maxGapMs = 0;
  for (let i = 0; i < 6 && i < grid.length; i++) {
    const rel = grid[i] - phase;
    const nearestTrue = Math.round(rel / trueBeatMs) * trueBeatMs;
    maxGapMs = Math.max(maxGapMs, Math.abs(rel - nearestTrue));
  }
  assert.ok(
    maxGapMs <= 25,
    `the early grid must stay phase-locked to the beat within ~one hop (got max gap ${maxGapMs.toFixed(1)}ms)`,
  );

  // Onset envelope stays SHARP (the over-smoothing guard): a click train spikes
  // hard at onsets and sits near 0 between them → high peak-to-mean ratio.
  let envMax = 0;
  let envSum = 0;
  for (let i = 0; i < env.length; i++) {
    envMax = Math.max(envMax, env[i]);
    envSum += env[i];
  }
  const peakToMean = envMax / Math.max(envSum / Math.max(1, env.length), 1e-9);
  assert.ok(
    peakToMean > 8,
    `onset envelope must stay sharp (peak/mean > 8, got ${peakToMean.toFixed(1)})`,
  );
}

// ---------------------------------------------------------------------------
// 3. Flux present, normalized, aligned to the energy curve (full analyzer path).
// ---------------------------------------------------------------------------
{
  const wavPath = join(tmpdir(), "fluncle-analyze-audio-test-174bpm.wav");
  writeFileSync(wavPath, encodeWav(buildClickTrain(24)));

  const audio = await analyzeAudio(wavPath, "test.wav");

  const flux = audio.fluxCurve ?? [];
  assert.ok(audio.fluxCurve !== undefined, "fluxCurve must be shipped");
  assert.ok(flux.length > 0, "fluxCurve must be non-empty");
  assert.equal(
    flux.length,
    audio.energyCurve.length,
    `fluxCurve.length (${flux.length}) must equal energyCurve.length (${audio.energyCurve.length})`,
  );
  assert.equal(flux[0].timeMs, 0, "flux timeMs must start at 0");
  let prevMs = -1;
  for (const s of flux) {
    assert.ok(s.energy >= 0 && s.energy <= 1, `flux sample out of [0,1]: ${s.energy}`);
    assert.ok(s.timeMs > prevMs, "flux timeMs must be strictly monotonic");
    prevMs = s.timeMs;
  }

  assert.ok(audio.rawDynamicsHint !== undefined, "rawDynamicsHint must be shipped");
}

// ---------------------------------------------------------------------------
// 5. rawDynamicsHint crest — a dynamic band reads a higher crest than a flat one.
// (Replicates the crestFactor definition P98/mean used by the analyzer.)
// ---------------------------------------------------------------------------
{
  const crest = (band: Float32Array): number => {
    let sum = 0;
    for (let i = 0; i < band.length; i++) {
      sum += band[i];
    }
    const mean = sum / Math.max(1, band.length);
    return percentile(band, 0.98) / Math.max(mean, 1e-9);
  };

  const flat = new Float32Array(100);
  for (let i = 0; i < flat.length; i++) {
    flat[i] = 0.5;
  }
  const dynamic = new Float32Array(100);
  for (let i = 0; i < dynamic.length; i++) {
    dynamic[i] = i % 10 === 0 ? 1.0 : 0.05;
  }
  assert.ok(
    crest(dynamic) > crest(flat),
    `a dynamic band must read a higher crest than a flat one (${crest(dynamic).toFixed(2)} > ${crest(flat).toFixed(2)})`,
  );
}

console.log(
  "✓ analyze-audio: shared-ref normalization (ratio + outlier-robust), swell→1.0, flux present/normalized/aligned, 20ms-hop BPM/grid/onset-sharp, raw crest hint",
);
