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

{
  const len = 50;
  const bass = new Float32Array(len);
  const mid = new Float32Array(len);
  const treble = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    bass[i] = 0.8;
    mid[i] = 0.4;
    treble[i] = 0.2;
  }

  normalizeBandsShared([bass, mid, treble]);

  for (const b of [bass, mid, treble]) {
    for (let i = 0; i < b.length; i++) {
      assert.ok(b[i] <= 1.0 + 1e-6, `no band may exceed 1.0 (got ${b[i]})`);
    }
  }

  const ratio = bass[0] / treble[0];
  const expected = Math.pow(4, 0.7);
  assert.ok(
    Math.abs(ratio - expected) < 0.05,
    `bass/treble ratio must survive the shared lift (~${expected.toFixed(3)}, got ${ratio.toFixed(3)})`,
  );

  const b2 = new Float32Array(len);
  const m2 = new Float32Array(len);
  const t2 = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    b2[i] = 0.5;
    m2[i] = 0.5;
    t2[i] = 0.5;
  }
  b2[0] = 5.0;
  normalizeBandsShared([b2, m2, t2]);

  assert.ok(
    b2[10] > 0.9,
    `a lone 10× outlier must not crush the steady section (got ${b2[10].toFixed(3)})`,
  );
}

{
  assert.equal(percentile(new Float32Array(0), 0.5), 0, "empty → 0");
  const vals = new Float32Array([0.1, 0.2, 0.3, 0.4, 100]);
  assert.ok(percentile(vals, 0.5) <= 0.3 + 1e-6, "P50 ignores a lone high outlier");
}

{
  const swellBeatWeight = 0;
  const swellBassWeight = 0.6;
  const swellEnergyWeight = 0.4;
  const swell = clamp01(1.0 * swellBeatWeight + 1.0 * swellBassWeight + 1.0 * swellEnergyWeight);
  assert.equal(swell, 1.0, "swell must reach 1.0 when bass and energy both peak (0.6 + 0.4)");
}

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
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
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

  const gridPeriod = (grid[grid.length - 1] - grid[0]) / (grid.length - 1);
  assert.ok(
    Math.abs(gridPeriod - trueBeatMs) <= 20,
    `grid beat period must match the true beat within ~one hop (true ${trueBeatMs.toFixed(1)}ms, got ${gridPeriod.toFixed(1)}ms)`,
  );

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
