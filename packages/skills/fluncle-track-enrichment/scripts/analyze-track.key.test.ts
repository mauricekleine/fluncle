import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import { decodeToSamples, estimateKey } from "./analyze-track.ts";

const SR = 44_100;
const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

const workdir = mkdtempSync(join(tmpdir(), "analyze-key-test-"));

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
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
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

function midiHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

function addTone(out: Float32Array, midi: number, t0: number, dur: number, amp: number): void {
  const start = Math.round(t0 * SR);
  const len = Math.round(dur * SR);
  const f = midiHz(midi);
  const partials = [1, 0.5, 0.33, 0.25, 0.2];

  for (let i = 0; i < len && start + i < out.length; i++) {
    const t = i / SR;
    const env = Math.min(1, t / 0.02) * Math.min(1, (dur - t) / 0.05);
    let s = 0;

    for (let h = 0; h < partials.length; h++) {
      s += (partials[h] ?? 0) * Math.sin(2 * Math.PI * f * (h + 1) * t);
    }

    out[start + i] += amp * env * s;
  }
}

function addChord(out: Float32Array, bass: number, triad: number[], t0: number, dur: number): void {
  addTone(out, bass - 12, t0, dur, 0.5);
  for (const note of triad) {
    addTone(out, note, t0, dur, 0.28);
  }
}

function progression(chords: number[][], seconds: number): Float32Array {
  const out = new Float32Array(Math.round(SR * seconds));
  const chordDur = 2;
  let t = 0;

  while (t + chordDur <= seconds) {
    const chord = chords[Math.floor(t / chordDur) % chords.length] ?? [];
    const [bass, ...triad] = chord;
    addChord(out, bass ?? 0, triad, t, chordDur);
    t += chordDur;
  }

  return out;
}

function addKick(out: Float32Array, t0: number): void {
  const start = Math.round(t0 * SR);
  for (let i = 0; i < 0.18 * SR && start + i < out.length; i++) {
    const t = i / SR;
    const f = 120 * Math.exp(-t * 25) + 45;
    out[start + i] += 0.9 * Math.exp(-t * 18) * Math.sin(2 * Math.PI * f * t);
  }
}

function addSnare(out: Float32Array, t0: number): void {
  const start = Math.round(t0 * SR);
  for (let i = 0; i < 0.12 * SR && start + i < out.length; i++) {
    const nz = Math.sin(i * 12.9898) * 43_758.5453;
    out[start + i] += 0.5 * Math.exp((-i / SR) * 30) * ((nz - Math.floor(nz)) * 2 - 1);
  }
}

function addHat(out: Float32Array, t0: number): void {
  const start = Math.round(t0 * SR);
  for (let i = 0; i < 0.03 * SR && start + i < out.length; i++) {
    const nz = Math.sin(i * 78.233 + 1) * 24_634.6345;
    out[start + i] += 0.22 * Math.exp((-i / SR) * 120) * ((nz - Math.floor(nz)) * 2 - 1);
  }
}

function keyOf(name: string, samples: Float32Array): { confidence: number; key: string } {
  const wav = join(workdir, `${name}.wav`);
  writeWav(wav, samples);
  return estimateKey(decodeToSamples(wav));
}

const G_MINOR = [
  [55, 67, 70, 74],
  [51, 63, 67, 70],
  [46, 58, 62, 65],
  [53, 65, 69, 72],
];

const G_MAJOR = [
  [55, 67, 71, 74],
  [48, 60, 64, 67],
  [55, 67, 71, 74],
  [50, 62, 66, 69],
];

describe.skipIf(!hasFfmpeg)("estimateKey (whole-track chromagram)", () => {
  test("G-minor progression reads G minor (not its relative A# major)", () => {
    const { confidence, key } = keyOf("gmin", progression(G_MINOR, 24));
    expect(key).toBe("G minor");
    expect(confidence).toBeGreaterThan(0);
  });

  test("G-major progression reads G major (the minor-prior spares a real major)", () => {
    const { key } = keyOf("gmaj", progression(G_MAJOR, 24));
    expect(key).toBe("G major");
  });

  test("sparse DnB (tonic+fifth bass, drums, only a quiet minor third) reads minor", () => {
    const seconds = 24;
    const out = new Float32Array(Math.round(SR * seconds));
    const bpm = 174;
    const beat = 60 / bpm;
    const bars = Math.floor(seconds / (4 * beat));

    for (let bar = 0; bar < bars; bar++) {
      const t = bar * 4 * beat;

      addTone(out, 43, t, beat * 0.9, 0.55);
      addTone(out, 50, t + 2 * beat, beat * 0.9, 0.55);
      addTone(out, 43, t + 3 * beat, beat * 0.5, 0.45);

      addTone(out, 70, t, 4 * beat, 0.08);

      addKick(out, t);
      addSnare(out, t + beat);
      addKick(out, t + 2.5 * beat);
      addSnare(out, t + 3 * beat);
      for (let e = 0; e < 8; e++) {
        addHat(out, t + e * 0.5 * beat);
      }
    }

    const { key } = keyOf("dnb", out);
    expect(key).toBe("G minor");
    expect(key).not.toBe("G major");
    expect(key).not.toBe("A# major");
  });
});

describe.skipIf(!hasFfmpeg)("estimateKey (segment-vote guard)", () => {
  test("a clip too short for a real vote reports zero confidence", () => {
    const { confidence } = keyOf("too-short-for-vote", progression(G_MINOR, 14));
    expect(confidence).toBe(0);
  });
});
