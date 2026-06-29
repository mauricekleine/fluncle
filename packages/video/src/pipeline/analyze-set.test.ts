// Self-running checks for the set-analysis DSP (Unit B) — no framework, same style
// as analyze-audio.test.ts. Generates synthetic set WAVs with planted "drops",
// decodes them through the real ffmpeg streaming path, and asserts the picker:
//   - returns spacing-respecting, downbeat-snapped windows with a musical pre-roll,
//   - normalizes the display curves to [0,1] at a 100ms hop,
//   - and on a MULTI-TEMPO set sets bpm → null without crashing.
// Run: `bun src/pipeline/analyze-set.test.ts` (exits non-zero on a failed assert).

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { analyzeSet, writeStudioEnvelope } from "./analyze-set";

const SR = 11025;

// Encode a Float32 mono signal as a 16-bit PCM WAV (matches analyze-audio.test.ts).
const encodeWav = (samples: Float32Array, sampleRate: number): Buffer => {
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
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * bytesPerSample, 28);
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

// A kick train at `bpm`, with planted breakdown→slam drops at `dropSec`. Each beat
// gets a 60Hz body + 800Hz attack; amplitude is the baseline, dips to a quiet
// breakdown for ~4s before each drop, then slams loud for ~6s after — and the drop
// beat also gets a 45Hz sub burst (the slam). This makes dropScore (quiet→loud bass)
// spike right at the drop, on a clean 174 grid the snap can lock to.
const buildSet = (totalSec: number, bpm: number, dropSec: number[]): Float32Array => {
  const n = Math.round(SR * totalSec);
  const out = new Float32Array(n);
  const beatSec = 60 / bpm;
  const clickLen = Math.round(0.03 * SR);
  const subLen = Math.round(0.3 * SR);

  const ampAt = (sec: number): number => {
    for (const d of dropSec) {
      if (sec >= d - 4 && sec < d) {
        return 0.06; // breakdown
      }
      if (sec >= d && sec < d + 6) {
        return 1.0; // slam
      }
    }
    return 0.4; // baseline
  };

  for (let beat = 0; beat * beatSec < totalSec; beat++) {
    const sec = beat * beatSec;
    const start = Math.round(sec * SR);
    const amp = ampAt(sec);
    for (let i = 0; i < clickLen && start + i < n; i++) {
      const env = Math.exp(-i / (clickLen * 0.25));
      const body = Math.sin((2 * Math.PI * 60 * i) / SR);
      const attack = 0.6 * Math.sin((2 * Math.PI * 800 * i) / SR);
      out[start + i] += env * (body + attack) * amp;
    }
    // The slam's sub burst on the exact drop beat.
    if (dropSec.some((d) => Math.abs(sec - d) < beatSec / 2)) {
      for (let i = 0; i < subLen && start + i < n; i++) {
        const env = Math.exp(-i / (subLen * 0.4));
        out[start + i] += env * Math.sin((2 * Math.PI * 45 * i) / SR) * 0.9;
      }
    }
  }
  return out;
};

// ---------------------------------------------------------------------------
// 1. Single-tempo set: spacing, downbeat-snap, pre-roll, normalized curves.
// ---------------------------------------------------------------------------
{
  const bpm = 174;
  const drops = [40, 80, 120];
  const totalSec = 140;
  const wavPath = join(tmpdir(), "fluncle-analyze-set-single.wav");
  writeFileSync(wavPath, encodeWav(buildSet(totalSec, bpm, drops), SR));

  const suggestionMs = 15_000;
  const minPeakSpacingMs = 35_000;
  const env = await analyzeSet(wavPath, { minPeakSpacingMs, suggestionMs });

  // Display contract.
  assert.equal(env.hopMs, 100, "display hop is 100ms");
  assert.ok(env.durationMs > 130_000, `full-length duration (got ${env.durationMs})`);
  const expectedPoints = Math.floor(env.durationMs / env.hopMs);
  for (const [name, curve] of [
    ["energy", env.energy],
    ["bass", env.bass],
    ["flux", env.flux],
  ] as const) {
    assert.ok(
      Math.abs(curve.length - expectedPoints) <= 2,
      `${name} curve length ~${expectedPoints} (got ${curve.length})`,
    );
    for (const v of curve) {
      assert.ok(v >= 0 && v <= 1, `${name} sample in [0,1] (got ${v})`);
    }
  }

  // BPM locks on a single-tempo set.
  assert.ok(env.bpm !== null, "single-tempo bpm must not be null");
  assert.ok(Math.abs((env.bpm ?? 0) - bpm) <= 3, `bpm ~${bpm} (got ${env.bpm})`);

  // The planted drops are found.
  assert.ok(
    env.suggestions.length >= 2 && env.suggestions.length <= 8,
    `2..8 candidate drops (got ${env.suggestions.length})`,
  );

  // Suggestions are ranked by score (descending).
  for (let i = 1; i < env.suggestions.length; i++) {
    assert.ok(
      env.suggestions[i - 1].score >= env.suggestions[i].score,
      "suggestions sorted by score desc",
    );
  }

  // Anchors respect the minimum inter-peak spacing.
  const anchors = env.suggestions.map((s) => s.anchorMs).sort((a, b) => a - b);
  for (let i = 1; i < anchors.length; i++) {
    assert.ok(
      anchors[i] - anchors[i - 1] >= minPeakSpacingMs,
      `anchors ≥ ${minPeakSpacingMs}ms apart (got ${anchors[i] - anchors[i - 1]})`,
    );
  }

  const beatMs = 60_000 / bpm;
  for (const s of env.suggestions) {
    // Window shape.
    assert.ok(s.startMs >= 0, "startMs ≥ 0");
    assert.ok(s.durationMs > 0 && s.durationMs <= suggestionMs, "duration in (0, suggestionMs]");
    assert.ok(s.startMs + s.durationMs <= env.durationMs + 1, "window inside the set");

    // The drop lands JUST INSIDE the window (a musical pre-roll, not at 0).
    const preRoll = s.anchorMs - s.startMs;
    assert.ok(
      preRoll > 0 && preRoll < s.durationMs,
      `drop lands inside the window via pre-roll (got ${preRoll}ms)`,
    );
    assert.ok(preRoll <= suggestionMs * 0.4 + 5, "pre-roll ≤ the cap (one bar here)");

    // The anchor snapped to (near) a true beat of the 174 grid.
    const nearestBeat = Math.round(s.anchorMs / beatMs) * beatMs;
    assert.ok(
      Math.abs(s.anchorMs - nearestBeat) <= beatMs / 2,
      `anchor snapped to a beat (off by ${Math.abs(s.anchorMs - nearestBeat).toFixed(0)}ms)`,
    );
  }

  // Peaks mirror the suggestions, tagged drop, time-ordered.
  for (let i = 0; i < env.peaks.length; i++) {
    assert.equal(env.peaks[i].kind, "drop", "peak kind is 'drop'");
    if (i > 0) {
      assert.ok(env.peaks[i].atMs >= env.peaks[i - 1].atMs, "peaks ordered by time");
    }
  }

  // writeStudioEnvelope round-trips to valid JSON.
  const outPath = join(tmpdir(), "fluncle-analyze-set-single.json");
  const written = await writeStudioEnvelope(wavPath, outPath, { minPeakSpacingMs, suggestionMs });
  const reparsed = JSON.parse(readFileSync(outPath, "utf8"));
  assert.equal(reparsed.hopMs, 100, "written artifact has hopMs 100");
  assert.equal(reparsed.suggestions.length, written.suggestions.length, "artifact matches return");
}

// ---------------------------------------------------------------------------
// 2. Multi-tempo set: bpm → null, no crash, still returns an array.
// ---------------------------------------------------------------------------
{
  // First half at 128 BPM, second half at 174 BPM (a real multi-tempo set).
  const half = buildSet(70, 128, [40]);
  const second = buildSet(70, 174, [30]);
  const total = new Float32Array(half.length + second.length);
  total.set(half, 0);
  total.set(second, half.length);
  const wavPath = join(tmpdir(), "fluncle-analyze-set-multi.wav");
  writeFileSync(wavPath, encodeWav(total, SR));

  const env = await analyzeSet(wavPath, { minPeakSpacingMs: 25_000, suggestionMs: 12_000 });
  assert.equal(env.bpm, null, "multi-tempo bpm must be null");
  assert.ok(Array.isArray(env.suggestions), "suggestions is an array on the null-bpm path");
  // Local snap still works per-peak regardless of the null global bpm.
  for (const s of env.suggestions) {
    assert.ok(s.anchorMs >= 0 && s.anchorMs <= env.durationMs, "anchor within the set");
  }
}

console.log(
  "✓ analyze-set: 100ms display curves in [0,1], spacing-respected + beat-snapped windows with a musical pre-roll, ranked top-N, multi-tempo → bpm null (no crash), artifact round-trips",
);
