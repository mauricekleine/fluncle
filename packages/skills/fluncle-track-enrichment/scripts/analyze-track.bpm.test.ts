// Focused test for the tempo-comb BPM estimator in analyze-track.ts.
//
// Generates real mono 16-bit PCM WAV fixtures with an exactly-known beat grid, decodes
// them through the same ffmpeg seam the pipeline uses, and asserts the comb reads the
// tempo back. The four cases pin the estimator's load-bearing properties: sub-0.1 BPM
// accuracy in the D&B band (no +0.4 bias), half-time octave-folding, and an honest null
// for out-of-band music. Importing analyze-track.ts is safe — the CLI pipeline is
// guarded by `if (import.meta.main)`, so the import only loads the exported functions.
//
//   bun test packages/skills/fluncle-track-enrichment/scripts/analyze-track.bpm.test.ts
//
// The cases skip when ffmpeg is absent (a documented skill prereq, so on a real box /
// dev machine they run). No preview / network is involved.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import { decodeToSamples, estimateBpm } from "./analyze-track.ts";

const SR = 44_100; // fixture sample rate; ffmpeg resamples to the analyzer's 22050 Hz
const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

const workdir = mkdtempSync(join(tmpdir(), "analyze-bpm-test-"));

afterAll(() => {
  rmSync(workdir, { force: true, recursive: true });
});

function writeWav(path: string, samples: Float32Array): void {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i] ?? 0));
    buf.writeInt16LE(Math.round(v * 32_767), 44 + i * 2);
  }
  writeFileSync(path, buf);
}

// A DnB-ish beat: kick on 1 with a syncopated two-step kick, snares on 2 and 4, hats on
// eighths. Deterministic pseudo-noise keeps the fixture reproducible across runs.
function beatTrack(bpm: number, seconds: number): Float32Array {
  const n = Math.round(SR * seconds);
  const out = new Float32Array(n);
  const beat = 60 / bpm;

  const addKick = (t0: number) => {
    const start = Math.round(t0 * SR);
    for (let i = 0; i < 0.18 * SR && start + i < n; i++) {
      const t = i / SR;
      const f = 120 * Math.exp(-t * 25) + 45;
      out[start + i] += 0.9 * Math.exp(-t * 18) * Math.sin(2 * Math.PI * f * t);
    }
  };
  const addSnare = (t0: number) => {
    const start = Math.round(t0 * SR);
    for (let i = 0; i < 0.12 * SR && start + i < n; i++) {
      const nz = Math.sin(i * 12.9898) * 43_758.5453;
      out[start + i] += 0.5 * Math.exp((-i / SR) * 30) * ((nz - Math.floor(nz)) * 2 - 1);
    }
  };
  const addHat = (t0: number) => {
    const start = Math.round(t0 * SR);
    for (let i = 0; i < 0.03 * SR && start + i < n; i++) {
      const nz = Math.sin(i * 78.233 + 1) * 24_634.6345;
      out[start + i] += 0.25 * Math.exp((-i / SR) * 120) * ((nz - Math.floor(nz)) * 2 - 1);
    }
  };

  const bars = Math.floor(seconds / (4 * beat));
  for (let bar = 0; bar < bars; bar++) {
    const t = bar * 4 * beat;
    addKick(t); // 1
    addSnare(t + beat); // 2
    addKick(t + 2.5 * beat); // syncopated two-step kick
    addSnare(t + 3 * beat); // 4
    for (let e = 0; e < 8; e++) {
      addHat(t + e * 0.5 * beat);
    }
  }
  return out;
}

function bpmOf(bpm: number, seconds: number): { bpm: number | null; bpmConfidence: number } {
  const wav = join(workdir, `beat-${bpm}-${seconds}s.wav`);
  writeWav(wav, beatTrack(bpm, seconds));
  const { bpm: read, bpmConfidence } = estimateBpm(decodeToSamples(wav));
  return { bpm: read, bpmConfidence };
}

describe.skipIf(!hasFfmpeg)("estimateBpm (tempo comb)", () => {
  test("172 BPM reads back within 0.1 BPM (no comb bias)", () => {
    const { bpm } = bpmOf(172, 30);
    expect(bpm).not.toBeNull();
    expect(Math.abs((bpm ?? 0) - 172)).toBeLessThanOrEqual(0.1);
  });

  test("174 BPM reads back within 0.1 BPM (no comb bias)", () => {
    const { bpm } = bpmOf(174, 30);
    expect(bpm).not.toBeNull();
    expect(Math.abs((bpm ?? 0) - 174)).toBeLessThanOrEqual(0.1);
  });

  test("87 BPM half-time folds up to ≈174 via even harmonics", () => {
    const { bpm } = bpmOf(87, 30);
    expect(bpm).not.toBeNull();
    expect(Math.abs((bpm ?? 0) - 174)).toBeLessThanOrEqual(0.1);
  });

  test("128 BPM house is honestly out-of-band → null", () => {
    const { bpm, bpmConfidence } = bpmOf(128, 30);
    expect(bpm).toBeNull();
    // It reports a confidence but stays under the reliability floor — no fake tempo.
    expect(bpmConfidence).toBeLessThan(0.15);
  });
});
