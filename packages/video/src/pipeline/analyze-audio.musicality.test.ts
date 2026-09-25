import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import {
  analyzeAudio,
  computeBands,
  estimateBpm,
  estimateBpmDetailed,
  onsetEnvelope,
  pickClipDrops,
  pickDownbeats,
  pickOnsets,
} from "./analyze-audio";
import { HOP_MS } from "./audio-curves";

const SR = 22050;

const writeClick = (samples: Float32Array, start: number, amp: number): void => {
  const clickLen = Math.round(0.03 * SR);
  for (let i = 0; i < clickLen && start + i < samples.length; i++) {
    const env = Math.exp(-i / (clickLen * 0.25));
    const body = Math.sin((2 * Math.PI * 60 * i) / SR);
    const attack = 0.6 * Math.sin((2 * Math.PI * 800 * i) / SR);
    samples[start + i] += env * (body + attack) * amp;
  }
};

const buildTrain = (
  seconds: number,
  bpm: number,
  ampAt: (beat: number) => number,
): Float32Array => {
  const n = Math.round(SR * seconds);
  const samples = new Float32Array(n);
  const beatSamples = (60 / bpm) * SR;
  for (let beat = 0; beat * beatSamples < n; beat++) {
    writeClick(samples, Math.round(beat * beatSamples), ampAt(beat));
  }
  return samples;
};

const envelopeOf = (samples: Float32Array): Float32Array =>
  onsetEnvelope(computeBands({ sampleRate: SR, samples }));

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

test("bpm: uniform 174 click train stays ~174 with high confidence", () => {
  const env = envelopeOf(buildTrain(24, 174, () => 0.8));
  const { bpm, confidence } = estimateBpmDetailed(env);
  expect(Math.abs(bpm - 174)).toBeLessThanOrEqual(2);
  expect(confidence).toBeGreaterThan(0.3);
  expect(confidence).toBeLessThanOrEqual(1);
});

test("bpm fold: half-time pattern (87 fundamental, comb-consistent) reports ~174", () => {
  const env = envelopeOf(buildTrain(24, 174, (beat) => (beat % 2 === 0 ? 0.9 : 0.35)));
  const { bpm } = estimateBpmDetailed(env);
  expect(Math.abs(bpm - 174)).toBeLessThanOrEqual(3);
});

test("bpm no-fold: a 128 signal reports ~128 — NEVER pinned to 160/185", () => {
  const env = envelopeOf(buildTrain(24, 128, () => 0.8));
  const { bpm } = estimateBpmDetailed(env);
  expect(Math.abs(bpm - 128)).toBeLessThanOrEqual(3);

  expect(Math.abs(bpm - 160)).toBeGreaterThan(1);
  expect(Math.abs(bpm - 185)).toBeGreaterThan(1);
  expect(estimateBpm(env)).toBeCloseTo(bpm, 5);
});

test("bpm dotted-rhythm: a strong 1.5-beat pulse over a 174 grid still reads ~174", () => {
  const seconds = 24;
  const n = Math.round(SR * seconds);
  const samples = new Float32Array(n);
  const beatSamples = (60 / 174) * SR;
  for (let beat = 0; beat * beatSamples < n; beat++) {
    writeClick(samples, Math.round(beat * beatSamples), 0.5);
  }
  for (let k = 0; k * 1.5 * beatSamples < n; k++) {
    writeClick(samples, Math.round(k * 1.5 * beatSamples), 0.9);
  }
  const { bpm } = estimateBpmDetailed(envelopeOf(samples));
  expect(Math.abs(bpm - 174)).toBeLessThanOrEqual(3);
});

test("bpm honesty: a TRUE 87 kick pattern (nothing at the half period) stays ~87", () => {
  const env = envelopeOf(buildTrain(24, 87, () => 0.8));
  const { bpm } = estimateBpmDetailed(env);
  expect(Math.abs(bpm - 87)).toBeLessThanOrEqual(2);
});

test("bpm: silent envelope reads confidence 0", () => {
  const { confidence } = estimateBpmDetailed(new Float32Array(1200));
  expect(confidence).toBe(0);
});

test("pickOnsets: local-median threshold keeps quiet-intro transients under a loud drop", () => {
  const env = new Float32Array(1200);
  const quietHops = [10, 60, 110, 160];
  for (const h of quietHops) {
    env[h] = 0.08;
  }
  for (let h = 500; h < 1000; h++) {
    env[h] = 0.25;
    if ((h - 500) % 25 === 0) {
      env[h] = 1.0;
    }
  }

  const onsets = pickOnsets(env);
  const quietFound = quietHops.filter((h) =>
    onsets.some((o) => Math.abs(o - h * HOP_MS) <= HOP_MS),
  );
  assert.equal(
    quietFound.length,
    quietHops.length,
    `all quiet-intro onsets must survive (found ${quietFound.length}/${quietHops.length})`,
  );

  const loudOnsets = onsets.filter((o) => o >= 500 * HOP_MS && o < 1000 * HOP_MS);
  expect(loudOnsets.length).toBeGreaterThanOrEqual(15);
  expect(loudOnsets.length).toBeLessThanOrEqual(25);
});

test("pickDownbeats: chooses the accented phase and emits every 4th beat", () => {
  const grid: number[] = [];
  const strength = new Float32Array(1000);
  for (let i = 0; i < 32; i++) {
    const hop = 25 * i + 5;
    grid.push(hop * HOP_MS);
    strength[hop] = i % 4 === 2 ? 1.0 : 0.2;
  }
  const downbeats = pickDownbeats(grid, strength);
  expect(downbeats.length).toBe(8);
  expect(downbeats[0]).toBe(grid[2]);
  for (let i = 0; i < downbeats.length; i++) {
    expect(downbeats[i]).toBe(grid[2 + 4 * i]);
  }
});

test("pickDownbeats: fewer than 4 beats yields no downbeats", () => {
  expect(pickDownbeats([0, 345, 690], new Float32Array(100))).toEqual([]);
});

test("pickClipDrops: breakdown→slam beats a lone loud spike", () => {
  const n = 1000;
  const bass = new Float32Array(n);
  const flux = new Float32Array(n);
  for (let h = 0; h < n; h++) {
    bass[h] = h < 400 ? 0.45 : h < 700 ? 0.04 : 0.85;
    flux[h] = 0.05;
  }
  bass[100] = 1.0;
  flux[100] = 1.0;
  for (let h = 700; h < n; h += 17) {
    flux[h] = 0.9;
  }

  const candidates = pickClipDrops(bass, flux);
  assert.ok(candidates.length >= 1, "the slam must be found");
  const top = candidates[0];
  assert.ok(
    Math.abs(top.timeMs - 700 * HOP_MS) <= 500,
    `dropMs must land at the slam onset (~${700 * HOP_MS}ms, got ${top.timeMs}ms)`,
  );

  for (let i = 0; i < candidates.length; i++) {
    expect(candidates[i].score).toBeGreaterThan(0);
    expect(candidates[i].score).toBeLessThanOrEqual(1);
    if (i > 0) {
      expect(candidates[i - 1].score).toBeGreaterThanOrEqual(candidates[i].score);
    }
  }
});

test("pickClipDrops: empty/flat input yields no candidates", () => {
  expect(pickClipDrops(new Float32Array(0), new Float32Array(0))).toEqual([]);
  expect(pickClipDrops(new Float32Array(500), new Float32Array(500))).toEqual([]);
});

test("pickClipDrops: a slam inside the final 2s tail guard is not a candidate", () => {
  const n = 1000;
  const bass = new Float32Array(n);
  const flux = new Float32Array(n);
  for (let h = 0; h < n; h++) {
    bass[h] = h < 920 ? 0.05 : 0.95;
    flux[h] = h >= 920 ? 0.8 : 0.05;
  }
  expect(pickClipDrops(bass, flux)).toEqual([]);
});

const buildDropTrack = (): Float32Array => {
  const seconds = 26;
  const n = Math.round(SR * seconds);
  const samples = new Float32Array(n);
  const beatSec = 60 / 174;

  const sectionAmp = (sec: number): number => (sec < 10 ? 0.5 : sec < 14 ? 0.04 : 0.6);

  for (let beat = 0; beat * beatSec < seconds; beat++) {
    const sec = beat * beatSec;
    const accent = beat % 4 === 0 ? 1.35 : 1.0;
    writeClick(samples, Math.round(sec * SR), sectionAmp(sec) * accent * 0.65);
  }

  for (let i = 0; i < n; i++) {
    const sec = i / SR;
    const bassAmp = sec < 10 ? 0.3 : sec < 14 ? 0.0 : 0.42;
    samples[i] += bassAmp * Math.sin(2 * Math.PI * 55 * sec);
  }

  const crashStart = Math.round(7 * SR);
  const crashLen = Math.round(0.06 * SR);
  for (let i = 0; i < crashLen; i++) {
    samples[crashStart + i] = 0.98 * Math.sin((2 * Math.PI * 500 * i) / SR);
  }
  return samples;
};

const wavPath = join(tmpdir(), "fluncle-analyze-audio-musicality-drop.wav");
writeFileSync(wavPath, encodeWav(buildDropTrack()));
const dropAudio = await analyzeAudio(wavPath, "musicality-test.wav");

test("analyzeAudio: dropMs lands on the slam, not the loudest sample", () => {
  const slamMs = 14000 - dropAudio.startMs;
  assert.ok(dropAudio.dropMs !== undefined, "dropMs must be shipped for a breakdown→slam clip");
  const dropMs = dropAudio.dropMs ?? 0;
  assert.ok(
    Math.abs(dropMs - slamMs) <= 700,
    `dropMs must land at the slam (~${slamMs}ms clip-relative, got ${dropMs}ms)`,
  );

  let peak = dropAudio.energyCurve[0];
  for (const s of dropAudio.energyCurve) {
    if (s.energy > peak.energy) {
      peak = s;
    }
  }
  const crashMs = 7000 - dropAudio.startMs;
  assert.ok(
    Math.abs(peak.timeMs - crashMs) <= 300,
    `the loudest sample must be the crash (~${crashMs}ms, got ${peak.timeMs}ms) — else this fixture lost its point`,
  );
  assert.ok(
    Math.abs(dropMs - peak.timeMs) > 2000,
    "the detected drop must NOT be the loudest instantaneous sample",
  );

  const candidates = dropAudio.dropCandidates ?? [];
  assert.ok(candidates.length >= 1, "dropCandidates must be shipped alongside dropMs");
  assert.equal(candidates[0].timeMs, dropMs, "dropMs is the top candidate");
});

test("analyzeAudio: downbeats are bar-spaced and phase-locked to the accented kicks", () => {
  const downbeats = dropAudio.downbeats ?? [];
  assert.ok(downbeats.length >= 3, `downbeats must span the clip (got ${downbeats.length})`);
  const barMs = (60000 / dropAudio.bpm) * 4;
  for (let i = 1; i < downbeats.length; i++) {
    const gap = downbeats[i] - downbeats[i - 1];
    assert.ok(
      Math.abs(gap - barMs) <= 2 * HOP_MS,
      `downbeats must be one bar apart (~${barMs.toFixed(0)}ms, got ${gap}ms)`,
    );
  }

  const accentPeriodMs = (60000 / 174) * 4;
  for (const d of downbeats) {
    const absMs = d + dropAudio.startMs;
    const nearest = Math.round(absMs / accentPeriodMs) * accentPeriodMs;
    assert.ok(
      Math.abs(absMs - nearest) <= 2.5 * HOP_MS,
      `downbeat ${d}ms must align with an accented kick (off by ${Math.abs(absMs - nearest).toFixed(0)}ms)`,
    );
  }
});

test("analyzeAudio: fine band curves are present, aligned, and in [0,1]", () => {
  const curves = {
    airCurve: dropAudio.airCurve,
    kickCurve: dropAudio.kickCurve,
    snareCurve: dropAudio.snareCurve,
    subCurve: dropAudio.subCurve,
  };
  for (const [name, curve] of Object.entries(curves)) {
    assert.ok(curve !== undefined && curve.length > 0, `${name} must be shipped`);
    assert.equal(curve.length, dropAudio.energyCurve.length, `${name} aligned to energyCurve`);
    for (let i = 0; i < curve.length; i++) {
      assert.ok(
        curve[i].energy >= 0 && curve[i].energy <= 1,
        `${name} sample out of [0,1]: ${curve[i].energy}`,
      );
      assert.equal(curve[i].timeMs, dropAudio.energyCurve[i].timeMs, `${name} timeMs aligned`);
    }
  }

  const subAt = (ms: number): number => {
    const sub = dropAudio.subCurve ?? [];
    let best = sub[0];
    for (const s of sub) {
      if (Math.abs(s.timeMs - ms) < Math.abs(best.timeMs - ms)) {
        best = s;
      }
    }
    return best.energy;
  };
  const breakdownMs = 12000 - dropAudio.startMs;
  const slamMs = 16000 - dropAudio.startMs;
  assert.ok(
    subAt(slamMs) > subAt(breakdownMs) + 0.2,
    `sub must read the slam over the breakdown (${subAt(slamMs)} vs ${subAt(breakdownMs)})`,
  );
});

test("analyzeAudio: bpm is honest (~174) with a shipped confidence", () => {
  expect(Math.abs(dropAudio.bpm - 174)).toBeLessThanOrEqual(3);
  const confidence = dropAudio.bpmConfidence ?? -1;
  expect(confidence).toBeGreaterThanOrEqual(0);
  expect(confidence).toBeLessThanOrEqual(1);
});

test("analyzeAudio: curves are normalized WITHIN the clip window (in-clip peak reads 1.0)", async () => {
  const seconds = 26;
  const n = Math.round(SR * seconds);
  const samples = new Float32Array(n);
  const burstStart = Math.round(0.5 * SR);
  const burstLen = Math.round(0.08 * SR);
  for (let i = 0; i < burstLen; i++) {
    samples[burstStart + i] = 0.98 * Math.sin((2 * Math.PI * 400 * i) / SR);
  }
  const beatSec = 60 / 174;
  for (let beat = 0; beat * beatSec < seconds; beat++) {
    const sec = beat * beatSec;
    if (sec >= 5) {
      writeClick(samples, Math.round(sec * SR), 0.5);
    }
  }
  for (let i = Math.round(5 * SR); i < n; i++) {
    samples[i] += 0.3 * Math.sin((2 * Math.PI * 55 * i) / SR);
  }

  const path = join(tmpdir(), "fluncle-analyze-audio-musicality-windownorm.wav");
  writeFileSync(path, encodeWav(samples));
  const audio = await analyzeAudio(path, "windownorm-test.wav");

  assert.ok(
    audio.startMs > 600,
    `the window must exclude the 0.5s burst (startMs ${audio.startMs})`,
  );
  let maxEnergy = 0;
  for (const s of audio.energyCurve) {
    maxEnergy = Math.max(maxEnergy, s.energy);
  }
  assert.ok(
    maxEnergy >= 0.999,
    `the clip's own energy peak must read 1.0 under window normalization (got ${maxEnergy})`,
  );
});
