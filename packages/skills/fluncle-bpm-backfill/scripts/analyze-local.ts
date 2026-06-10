#!/usr/bin/env bun
// analyze-local — BPM analysis of a LOCAL full-length audio file for the
// fluncle-bpm-backfill skill.
//
// Zero npm dependencies. External tool: `ffmpeg` (on PATH). It does NOT import
// any Fluncle code, so it stands alone wherever the skill is installed — exactly
// like the enrichment skill's analyze-track.ts. The BPM DSP below is a faithful
// copy of that script's `estimateBpm`; keep them in sync if the core DSP changes.
//
// Why this exists: the automated enrichment path analyzes a 30s preview. Some
// drum & bass previews are beatless build-ups, so the preview yields no foldable
// tempo. Given the FULL song (sourced transiently, e.g. via yt-dlp, then deleted),
// the same algorithm recovers a confident in-band BPM. This script takes a local
// audio file (any format ffmpeg reads), runs the DSP over the whole track AND
// across overlapping windows, and reports a confidence-weighted consensus.
//
//   bun analyze-local.ts --audio-file /tmp/song.opus
//
// Output (stdout): a single JSON object. Diagnostics go to stderr.

import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);

  return index >= 0 ? process.argv[index + 1] : undefined;
}

const audioFile = arg("audio-file");
const segmentS = Number(arg("segment-s") ?? "30"); // window length for the scan
const stepS = Number(arg("step-s") ?? "15"); // hop between scan windows

if (!audioFile) {
  console.error("usage: bun analyze-local.ts --audio-file <path> [--segment-s 30] [--step-s 15]");
  process.exit(1);
}

if (!existsSync(audioFile)) {
  console.error(`[analyze-local] file not found: ${audioFile}`);
  process.exit(1);
}

const log = (message: string) => console.error(`[analyze-local] ${message}`);

// ---------------------------------------------------------------------------
// Decode: ffmpeg → mono 22050 Hz s16le WAV, then parse PCM. Same target format
// as the core analyzer, so the DSP sees identical input.
// ---------------------------------------------------------------------------

const SAMPLE_RATE = 22050;

function decodeWav(buf: Buffer): Float32Array {
  let offset = 12;
  let dataOffset = -1;
  let dataLength = 0;

  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);

    if (id === "data") {
      dataOffset = offset + 8;
      dataLength = size;
      break;
    }

    offset += 8 + size + (size % 2);
  }

  if (dataOffset < 0) {
    throw new Error("no data chunk in wav");
  }

  const count = Math.floor(dataLength / 2);
  const samples = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    samples[i] = buf.readInt16LE(dataOffset + i * 2) / 32768;
  }

  return samples;
}

function loadSamples(path: string): Float32Array {
  const dir = mkdtempSync(join(tmpdir(), "fluncle-bpm-local-"));

  try {
    const wavPath = join(dir, "audio.wav");
    const result = spawnSync(
      "ffmpeg",
      ["-y", "-i", path, "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "wav", wavPath],
      { stdio: ["ignore", "ignore", "ignore"] },
    );

    if (result.status !== 0) {
      throw new Error("ffmpeg decode failed (is ffmpeg installed and on PATH?)");
    }

    return decodeWav(readFileSync(wavPath));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

// ---------------------------------------------------------------------------
// BPM (onset-envelope autocorrelation, folded to the D&B band).
// Faithful copy of analyze-track.ts:estimateBpm — keep in sync.
// ---------------------------------------------------------------------------

const HOP_MS = 50;
const BPM_WINDOW_S = 12; // analyze the busiest contiguous stretch, not the whole clip
const BPM_CONFIDENCE_FLOOR = 0.15; // normalized autocorr peak; below this → null
const BASS_CUTOFF_HZ = 150; // one-pole split: isolate the kick from pads/melody
const MID_CUTOFF_HZ = 2000;

function lowpassAlpha(cutoffHz: number, sampleRate: number): number {
  const dt = 1 / sampleRate;
  const rc = 1 / (2 * Math.PI * cutoffHz);

  return dt / (rc + dt);
}

// Octave-fold a raw tempo into the D&B band — WITHOUT clamping. Returns the
// in-band tempo, or null when no ×2^k of it lands in [160,185]. A tempo that
// can't fold is itself a low-confidence signal: better null than a fake number.
function foldToBand(bpm: number): number | null {
  for (const m of [1, 2, 0.5, 4, 0.25]) {
    const c = bpm * m;

    if (c >= 160 && c <= 185) {
      return c;
    }
  }

  return null;
}

function estimateBpm(samples: Float32Array): {
  bpm: number | null;
  bpmConfidence: number;
  onsetRate: number;
} {
  const hopSamples = Math.max(1, Math.round((HOP_MS / 1000) * SAMPLE_RATE));
  const hops = Math.floor(samples.length / hopSamples);

  if (hops < 8) {
    return { bpm: null, bpmConfidence: 0, onsetRate: 0 };
  }

  const aBass = lowpassAlpha(BASS_CUTOFF_HZ, SAMPLE_RATE);
  const aMid = lowpassAlpha(MID_CUTOFF_HZ, SAMPLE_RATE);
  let lpBass = 0;
  let lpMid = 0;

  const bass = new Float32Array(hops);
  const mid = new Float32Array(hops);
  const high = new Float32Array(hops);

  for (let h = 0; h < hops; h++) {
    let sBass = 0;
    let sMid = 0;
    let sHigh = 0;
    const start = h * hopSamples;

    for (let i = 0; i < hopSamples; i++) {
      const x = samples[start + i] ?? 0;
      lpBass += aBass * (x - lpBass);
      lpMid += aMid * (x - lpMid);
      const bassV = lpBass;
      const midV = lpMid - lpBass;
      const highV = x - lpMid;
      sBass += bassV * bassV;
      sMid += midV * midV;
      sHigh += highV * highV;
    }

    bass[h] = Math.sqrt(sBass / hopSamples);
    mid[h] = Math.sqrt(sMid / hopSamples);
    high[h] = Math.sqrt(sHigh / hopSamples);
  }

  const env = new Float32Array(hops);

  for (let h = 1; h < hops; h++) {
    env[h] =
      Math.max(0, bass[h] - bass[h - 1]) +
      Math.max(0, mid[h] - mid[h - 1]) +
      Math.max(0, high[h] - high[h - 1]);
  }

  let envMean = 0;

  for (let h = 0; h < hops; h++) {
    envMean += env[h];
  }

  envMean /= Math.max(1, hops);
  const envStd = Math.sqrt(env.reduce((s, v) => s + (v - envMean) ** 2, 0) / Math.max(1, hops));
  const onsetThreshold = envMean + 0.6 * envStd;
  let onsets = 0;

  for (let h = 1; h < env.length - 1; h++) {
    if (env[h] > onsetThreshold && env[h] >= env[h - 1] && env[h] >= env[h + 1]) {
      onsets++;
    }
  }

  const onsetRate = Number((onsets / Math.max(1e-6, (hops * HOP_MS) / 1000)).toFixed(2));

  const winHops = Math.min(hops, Math.round((BPM_WINDOW_S * 1000) / HOP_MS));
  let winStart = 0;

  if (hops > winHops) {
    let envMax = 1e-9;
    let bassMax = 1e-9;

    for (let h = 0; h < hops; h++) {
      if (env[h] > envMax) {
        envMax = env[h];
      }

      if (bass[h] > bassMax) {
        bassMax = bass[h];
      }
    }

    let onsetRun = 0;
    let bassRun = 0;

    for (let h = 0; h < winHops; h++) {
      onsetRun += env[h] / envMax;
      bassRun += bass[h] / bassMax;
    }

    let bestScore = onsetRun + 2 * bassRun;

    for (let h = winHops; h < hops; h++) {
      onsetRun += (env[h] - env[h - winHops]) / envMax;
      bassRun += (bass[h] - bass[h - winHops]) / bassMax;
      const score = onsetRun + 2 * bassRun;

      if (score > bestScore) {
        bestScore = score;
        winStart = h - winHops + 1;
      }
    }
  }

  const win = env.subarray(winStart, winStart + winHops);
  let winMean = 0;

  for (const v of win) {
    winMean += v;
  }

  winMean /= Math.max(1, win.length);
  const centered = Float64Array.from(win, (v) => v - winMean);

  const bpmToLag = (bpm: number) => (60 / bpm) * (1000 / HOP_MS);
  const lagMin = Math.floor(bpmToLag(190));
  const lagMax = Math.ceil(bpmToLag(70));

  const autocorr = (lag: number): number => {
    let acc = 0;

    for (let i = lag; i < centered.length; i++) {
      acc += centered[i] * centered[i - lag];
    }

    return acc;
  };

  const energy0 = autocorr(0);
  let bestLag = lagMin;
  let bestScore = -Infinity;

  for (let lag = lagMin; lag <= lagMax && lag < centered.length; lag++) {
    const score = autocorr(lag) / lag ** 0.5;

    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  let refined = bestLag;

  if (bestLag - 1 >= lagMin && bestLag + 1 < centered.length) {
    const a = autocorr(bestLag - 1);
    const b = autocorr(bestLag);
    const c = autocorr(bestLag + 1);
    const denom = a - 2 * b + c;

    if (Math.abs(denom) > 1e-9) {
      refined = bestLag + Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom));
    }
  }

  const confidence = energy0 > 0 ? Math.max(0, autocorr(bestLag) / energy0) : 0;
  const folded = foldToBand((60 * (1000 / HOP_MS)) / refined);
  const reliable = folded !== null && confidence >= BPM_CONFIDENCE_FLOOR;

  return {
    bpm: reliable && folded !== null ? Number(folded.toFixed(2)) : null,
    bpmConfidence: Number(confidence.toFixed(3)),
    onsetRate,
  };
}

// ---------------------------------------------------------------------------
// Multi-window consensus. A single busiest-12s window can land on a breakdown
// or a half-time section. Scanning overlapping windows across the whole track
// and taking the confidence-weighted mode of the folded tempos is more robust,
// and the agreement count is a trust signal you can threshold on.
// ---------------------------------------------------------------------------

function multiWindow(samples: Float32Array): {
  bpm: number | null;
  confidence: number;
  agreement: number;
  windows: number;
} {
  const segLen = Math.round(segmentS * SAMPLE_RATE);
  const stepLen = Math.max(1, Math.round(stepS * SAMPLE_RATE));

  if (samples.length <= segLen) {
    const whole = estimateBpm(samples);

    return {
      agreement: whole.bpm === null ? 0 : 1,
      bpm: whole.bpm,
      confidence: whole.bpmConfidence,
      windows: 1,
    };
  }

  // Bucket folded tempos to the nearest 0.5 BPM; sum confidence per bucket.
  const buckets = new Map<number, { sumConf: number; sumBpm: number; votes: number }>();
  let windows = 0;

  for (let start = 0; start + segLen <= samples.length; start += stepLen) {
    windows++;
    const seg = estimateBpm(samples.subarray(start, start + segLen));

    if (seg.bpm === null) {
      continue;
    }

    const key = Math.round(seg.bpm * 2) / 2;
    const cur = buckets.get(key) ?? { sumBpm: 0, sumConf: 0, votes: 0 };
    cur.sumConf += seg.bpmConfidence;
    cur.sumBpm += seg.bpm * seg.bpmConfidence;
    cur.votes += 1;
    buckets.set(key, cur);
  }

  let best: { sumConf: number; sumBpm: number; votes: number } | null = null;

  for (const bucket of buckets.values()) {
    if (!best || bucket.sumConf > best.sumConf) {
      best = bucket;
    }
  }

  if (!best || best.sumConf <= 0) {
    return { agreement: 0, bpm: null, confidence: 0, windows };
  }

  // Confidence-weighted mean within the winning bucket.
  const bpm = Number((best.sumBpm / best.sumConf).toFixed(2));

  return {
    agreement: best.votes,
    bpm,
    confidence: Number((best.sumConf / Math.max(1, windows)).toFixed(3)),
    windows,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

try {
  log(`decoding ${audioFile}`);
  const samples = loadSamples(audioFile);
  const durationS = Number((samples.length / SAMPLE_RATE).toFixed(1));
  log(`decoded ${durationS}s of audio`);

  const whole = estimateBpm(samples);
  const scan = multiWindow(samples);

  log(
    `whole-track: bpm ${whole.bpm} (conf ${whole.bpmConfidence}); ` +
      `multi-window: bpm ${scan.bpm} (conf ${scan.confidence}, ${scan.agreement}/${scan.windows} windows agree)`,
  );

  // The multi-window consensus is the headline figure; the whole-track pass is
  // reported alongside so you can sanity-check they agree before writing.
  console.log(
    JSON.stringify(
      {
        agreement: scan.agreement,
        audioFile,
        bpm: scan.bpm,
        confidence: scan.confidence,
        durationS,
        onsetRate: whole.onsetRate,
        wholeTrack: { bpm: whole.bpm, confidence: whole.bpmConfidence },
        windows: scan.windows,
      },
      null,
      2,
    ),
  );
} catch (error) {
  log(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
