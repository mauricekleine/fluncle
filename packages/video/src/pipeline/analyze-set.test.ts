// Self-running checks for the set-analysis DSP (Unit B) — no framework, same style
// as analyze-audio.test.ts. The PICKER is tested on synthetic IN-MEMORY curves with
// planted "drops" (NO ffmpeg — so `bun run test` is green on a CI box with no ffmpeg
// on PATH, exactly like analyze-audio.test.ts tests the DSP on synthetic samples).
// A full decode→envelope integration check runs only when ffmpeg is present.
// Run: `bun src/pipeline/analyze-set.test.ts` (exits non-zero on a failed assert).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HOP_MS } from "./audio-curves";
import { analyzeSet, pickDrops, writeStudioEnvelope } from "./analyze-set";

// ---------------------------------------------------------------------------
// Synthetic internal-hop (20ms) curves with planted breakdown→slam drops.
//   - bass/energy: baseline, dip to a quiet breakdown ~4s before each drop, then
//     slam loud ~6s after → dropScore (quiet→loud bass) spikes right at the drop.
//   - flux: a periodic onset impulse per beat (so the LOCAL tempo/phase snap has a
//     grid to lock to) at `bpm`, with a stronger spike on the drop beat.
// All values already in [0,1] (pickDrops expects normalized curves).
// ---------------------------------------------------------------------------
const buildCurves = (
  totalSec: number,
  bpm: number,
  dropsSec: number[],
): { energy: Float32Array; bass: Float32Array; flux: Float32Array } => {
  const hopCount = Math.round((totalSec * 1000) / HOP_MS);
  const energy = new Float32Array(hopCount);
  const bass = new Float32Array(hopCount);
  const flux = new Float32Array(hopCount);
  const beatHops = 60_000 / bpm / HOP_MS;
  const halfBeatSec = 60 / bpm / 2;

  const ampAt = (sec: number): number => {
    for (const d of dropsSec) {
      if (sec >= d - 4 && sec < d) {
        return 0.06; // breakdown
      }
      if (sec >= d && sec < d + 6) {
        return 1.0; // slam
      }
    }
    return 0.4; // baseline
  };

  for (let h = 0; h < hopCount; h++) {
    const sec = (h * HOP_MS) / 1000;
    const a = ampAt(sec);
    energy[h] = a;
    bass[h] = a * 0.9;
    flux[h] = 0.02; // a quiet between-onset floor
  }

  for (let beat = 0; beat * beatHops < hopCount; beat++) {
    const h = Math.round(beat * beatHops);
    if (h < hopCount) {
      const sec = (h * HOP_MS) / 1000;
      const onDrop = dropsSec.some((d) => Math.abs(sec - d) < halfBeatSec);
      flux[h] = onDrop ? 1.0 : 0.5;
    }
  }
  return { bass, energy, flux };
};

// ---------------------------------------------------------------------------
// 1. pickDrops on a single-tempo set: spacing, downbeat-snap, pre-roll, ranking.
//    (Pure synthetic curves — never touches ffmpeg.)
// ---------------------------------------------------------------------------
{
  const bpm = 174;
  const drops = [40, 80, 120];
  const suggestionMs = 15_000;
  const minPeakSpacingMs = 35_000;
  const { energy, bass, flux } = buildCurves(140, bpm, drops);

  const {
    bpm: estBpm,
    peaks,
    suggestions,
  } = pickDrops(energy, bass, flux, {
    minPeakSpacingMs,
    suggestionMs,
  });

  // BPM locks on a single-tempo set.
  assert.ok(estBpm !== null, "single-tempo bpm must not be null");
  assert.ok(Math.abs((estBpm ?? 0) - bpm) <= 3, `bpm ~${bpm} (got ${estBpm})`);

  // The planted drops are found.
  assert.ok(
    suggestions.length >= 2 && suggestions.length <= 8,
    `2..8 candidate drops (got ${suggestions.length})`,
  );

  // Suggestions are ranked by score (descending).
  for (let i = 1; i < suggestions.length; i++) {
    assert.ok(suggestions[i - 1].score >= suggestions[i].score, "suggestions sorted by score desc");
  }

  // Anchors respect the minimum inter-peak spacing.
  const anchors = suggestions.map((s) => s.anchorMs).sort((a, b) => a - b);
  for (let i = 1; i < anchors.length; i++) {
    assert.ok(
      anchors[i] - anchors[i - 1] >= minPeakSpacingMs,
      `anchors ≥ ${minPeakSpacingMs}ms apart (got ${anchors[i] - anchors[i - 1]})`,
    );
  }

  const beatMs = 60_000 / bpm;
  for (const s of suggestions) {
    // Window shape.
    assert.ok(s.startMs >= 0, "startMs ≥ 0");
    assert.ok(s.durationMs > 0 && s.durationMs <= suggestionMs, "duration in (0, suggestionMs]");

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

    // Each candidate sits near a planted drop.
    assert.ok(
      drops.some((d) => Math.abs(s.anchorMs - d * 1000) < 2_000),
      `candidate ${s.anchorMs}ms sits near a planted drop`,
    );
  }

  // Peaks mirror the suggestions, tagged drop, time-ordered.
  for (let i = 0; i < peaks.length; i++) {
    assert.equal(peaks[i].kind, "drop", "peak kind is 'drop'");
    if (i > 0) {
      assert.ok(peaks[i].atMs >= peaks[i - 1].atMs, "peaks ordered by time");
    }
  }
}

// ---------------------------------------------------------------------------
// 2. pickDrops on a multi-tempo set: bpm → null, no crash, still an array.
//    (Pure synthetic — first half 128 BPM, second half 174 BPM.)
// ---------------------------------------------------------------------------
{
  const a = buildCurves(70, 128, [40]);
  const b = buildCurves(70, 174, [30]);
  const join2 = (x: Float32Array, y: Float32Array): Float32Array => {
    const out = new Float32Array(x.length + y.length);
    out.set(x, 0);
    out.set(y, x.length);
    return out;
  };
  const energy = join2(a.energy, b.energy);
  const bass = join2(a.bass, b.bass);
  const flux = join2(a.flux, b.flux);
  const totalMs = bass.length * HOP_MS;

  const { bpm, suggestions } = pickDrops(energy, bass, flux, {
    minPeakSpacingMs: 25_000,
    suggestionMs: 12_000,
  });
  assert.equal(bpm, null, "multi-tempo bpm must be null");
  assert.ok(Array.isArray(suggestions), "suggestions is an array on the null-bpm path");
  for (const s of suggestions) {
    assert.ok(s.anchorMs >= 0 && s.anchorMs <= totalMs, "anchor within the set");
  }
}

// ---------------------------------------------------------------------------
// 3. Empty / degenerate input does not crash.
// ---------------------------------------------------------------------------
{
  const z = new Float32Array(0);
  const res = pickDrops(z, z, z);
  assert.equal(res.suggestions.length, 0, "empty input → no suggestions");
  assert.equal(res.peaks.length, 0, "empty input → no peaks");
}

// ---------------------------------------------------------------------------
// 4. (Integration) full decode→envelope — ONLY when ffmpeg is on PATH, so CI
//    without ffmpeg stays green. Exercises the streaming decode + decimation +
//    the JSON artifact round-trip.
// ---------------------------------------------------------------------------
const ffmpegBin = process.env.FLUNCLE_FFMPEG ?? "ffmpeg";
const probe = spawnSync(ffmpegBin, ["-version"], { stdio: "ignore" });
const hasFfmpeg = !probe.error && probe.status === 0;

if (hasFfmpeg) {
  const SR = 11025;
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
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22);
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

  // A 174 BPM kick train with a planted drop, just enough to exercise the decode.
  const totalSec = 60;
  const bpm = 174;
  const drops = [30];
  const n = Math.round(SR * totalSec);
  const samples = new Float32Array(n);
  const beatSec = 60 / bpm;
  const clickLen = Math.round(0.03 * SR);
  for (let beat = 0; beat * beatSec < totalSec; beat++) {
    const sec = beat * beatSec;
    const start = Math.round(sec * SR);
    let amp = 0.4;
    for (const d of drops) {
      if (sec >= d - 4 && sec < d) {
        amp = 0.06;
      } else if (sec >= d && sec < d + 6) {
        amp = 1.0;
      }
    }
    for (let i = 0; i < clickLen && start + i < n; i++) {
      const env = Math.exp(-i / (clickLen * 0.25));
      const body = Math.sin((2 * Math.PI * 60 * i) / SR);
      const attack = 0.6 * Math.sin((2 * Math.PI * 800 * i) / SR);
      samples[start + i] += env * (body + attack) * amp;
    }
  }

  const wavPath = join(tmpdir(), "fluncle-analyze-set-integration.wav");
  writeFileSync(wavPath, encodeWav(samples, SR));

  const outPath = join(tmpdir(), "fluncle-analyze-set-integration.json");
  const env = await writeStudioEnvelope(wavPath, outPath, { suggestionMs: 12_000 });

  // Display contract: full-length curves decimated to a 100ms hop, all in [0,1].
  assert.equal(env.hopMs, 100, "display hop is 100ms");
  assert.ok(env.durationMs > 55_000, `full-length duration (got ${env.durationMs})`);
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

  // Round-trips to valid JSON matching the return.
  const reparsed = JSON.parse(readFileSync(outPath, "utf8"));
  assert.equal(reparsed.hopMs, 100, "written artifact has hopMs 100");
  assert.equal(reparsed.suggestions.length, env.suggestions.length, "artifact matches return");

  // The full decode→pick path still produces the planted drop.
  const directEnv = await analyzeSet(wavPath, { suggestionMs: 12_000 });
  assert.ok(directEnv.suggestions.length >= 1, "decode→pick finds the planted drop");
}

console.log(
  `✓ analyze-set: synthetic pickDrops (spacing + beat-snap + pre-roll + ranked top-N, multi-tempo → bpm null, empty-safe)${
    hasFfmpeg
      ? " + ffmpeg decode→envelope integration (100ms curves in [0,1], artifact round-trips)"
      : " [ffmpeg absent → decode integration skipped]"
  }`,
);
