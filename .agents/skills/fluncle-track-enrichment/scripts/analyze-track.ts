#!/usr/bin/env bun
// analyze-track — self-contained audio analysis for a Fluncle track.
//
// Zero npm dependencies. External tools only: `ffmpeg` (on PATH) and network
// access (Deezer/iTunes for the preview). It does NOT import any Fluncle code, so
// it runs anywhere the skill is installed — a local session or a Spinup microVM.
//
// Given an artist + title (the agent gets these from `fluncle track get --json`),
// it resolves a legal preview clip, decodes it, and emits an analysis JSON on
// stdout: BPM, musical key (+confidence), spectral features, and a best-guess
// drum & bass sub-genre. The agent then writes the result back with
// `fluncle admin track update`. The sub-genre is a SUGGESTION (provenance "auto");
// a human review always wins.
//
//   bun analyze-track.ts --artist "Loadstar" --title "Take a Deep Breath" [--isrc GB5KW1701923]
//
// Output (stdout): a single JSON object. Diagnostics go to stderr.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);

  return index >= 0 ? process.argv[index + 1] : undefined;
}

const artist = arg("artist");
const title = arg("title");
const isrc = arg("isrc");

if (!artist || !title) {
  console.error('usage: bun analyze-track.ts --artist "<artist>" --title "<title>" [--isrc <isrc>]');
  process.exit(1);
}

const log = (message: string) => console.error(`[analyze] ${message}`);

// ---------------------------------------------------------------------------
// Preview resolution (Deezer by ISRC → Deezer search → iTunes) — HTTP only.
// ---------------------------------------------------------------------------

type Preview = { source: string; url: string };

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function resolvePreview(): Promise<Preview | undefined> {
  // 1. Deezer by ISRC — the most precise (exact recording).
  if (isrc) {
    try {
      const response = await fetch(`https://api.deezer.com/track/isrc:${encodeURIComponent(isrc)}`);
      const track = (await response.json()) as { error?: unknown; preview?: string };

      if (!track.error && track.preview) {
        return { source: "deezer:isrc", url: track.preview };
      }
    } catch {
      // fall through
    }
  }

  // 2. Deezer search by artist + title.
  try {
    const query = `artist:"${artist}" track:"${title}"`;
    const response = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(query)}`);
    const body = (await response.json()) as {
      data?: Array<{ artist?: { name?: string }; preview?: string; title?: string }>;
    };
    const hit = (body.data ?? []).find((item) => item.preview);

    if (hit?.preview) {
      return { source: "deezer:search", url: hit.preview };
    }
  } catch {
    // fall through
  }

  // 3. iTunes search fallback.
  try {
    const term = encodeURIComponent(`${artist} ${title}`);
    const response = await fetch(`https://itunes.apple.com/search?term=${term}&media=music&limit=8`);
    const body = (await response.json()) as {
      results?: Array<{ artistName?: string; previewUrl?: string; trackName?: string }>;
    };
    const hit = (body.results ?? []).find(
      (item) => item.previewUrl && normalize(item.artistName ?? "").includes(normalize(artist)),
    );

    if (hit?.previewUrl) {
      return { source: "itunes", url: hit.previewUrl };
    }
  } catch {
    // fall through
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Decode: download the preview, ffmpeg → mono 22050 Hz s16le WAV.
// ---------------------------------------------------------------------------

const SAMPLE_RATE = 22050;

function decodeWav(buf: Buffer): Float32Array {
  // Find the data chunk (skip RIFF/WAVE header + any chunks before `data`).
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

async function loadSamples(previewUrl: string): Promise<Float32Array> {
  const dir = mkdtempSync(join(tmpdir(), "fluncle-analyze-"));

  try {
    const mp3Path = join(dir, "preview.mp3");
    const wavPath = join(dir, "preview.wav");
    const response = await fetch(previewUrl);
    writeFileSync(mp3Path, Buffer.from(await response.arrayBuffer()));

    const result = spawnSync(
      "ffmpeg",
      ["-y", "-i", mp3Path, "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "wav", wavPath],
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
// FFT (iterative radix-2, in place).
// ---------------------------------------------------------------------------

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;

    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }

    j ^= bit;

    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);

    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;

      for (let k = 0; k < len >> 1; k++) {
        const ar = re[i + k];
        const ai = im[i + k];
        const br = re[i + k + (len >> 1)] * cr - im[i + k + (len >> 1)] * ci;
        const bi = re[i + k + (len >> 1)] * ci + im[i + k + (len >> 1)] * cr;
        re[i + k] = ar + br;
        im[i + k] = ai + bi;
        re[i + k + (len >> 1)] = ar - br;
        im[i + k + (len >> 1)] = ai - bi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Key (Krumhansl-Schmuckler) + spectral features.
// ---------------------------------------------------------------------------

const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;

  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }

  return num / (Math.sqrt(da * db) || 1);
}

type Spectral = {
  centroidHz: number;
  chroma: number[];
  highRatio: number;
  midFlatness: number;
  subBassRatio: number;
};

function spectral(samples: Float32Array): Spectral {
  const N = 4096;
  const hop = 2048;
  const hann = new Float64Array(N);

  for (let i = 0; i < N; i++) {
    hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  }

  const avgMag = new Float64Array(N / 2);
  const chroma = Array.from({ length: 12 }, () => 0);
  let frames = 0;
  const limit = Math.min(samples.length - N, SAMPLE_RATE * 25);

  for (let start = 0; start < limit; start += hop) {
    const re = new Float64Array(N);
    const im = new Float64Array(N);

    for (let i = 0; i < N; i++) {
      re[i] = (samples[start + i] ?? 0) * hann[i];
    }

    fft(re, im);

    for (let b = 1; b < N / 2; b++) {
      const mag = Math.hypot(re[b], im[b]);
      avgMag[b] += mag;
      const freq = (b * SAMPLE_RATE) / N;

      if (freq >= 55 && freq <= 5000) {
        const pc = ((Math.round(69 + 12 * Math.log2(freq / 440)) % 12) + 12) % 12;
        chroma[pc] += mag;
      }
    }

    frames++;
  }

  for (let b = 0; b < avgMag.length; b++) {
    avgMag[b] /= frames || 1;
  }

  let total = 0;
  let centroidNum = 0;
  let subBass = 0;
  let high = 0;
  const mids: number[] = [];

  for (let b = 1; b < avgMag.length; b++) {
    const freq = (b * SAMPLE_RATE) / N;
    const m = avgMag[b];
    total += m;
    centroidNum += freq * m;

    if (freq < 120) {
      subBass += m;
    }

    if (freq >= 300 && freq <= 3000) {
      mids.push(m);
    }

    if (freq > 5000) {
      high += m;
    }
  }

  const geo = Math.exp(mids.reduce((s, m) => s + Math.log(m + 1e-9), 0) / (mids.length || 1));
  const arith = mids.reduce((s, m) => s + m, 0) / (mids.length || 1);

  return {
    centroidHz: Math.round(centroidNum / (total || 1)),
    chroma,
    highRatio: Number((high / (total || 1)).toFixed(3)),
    midFlatness: Number((geo / (arith || 1)).toFixed(3)),
    subBassRatio: Number((subBass / (total || 1)).toFixed(3)),
  };
}

function estimateKey(chroma: number[]): { confidence: number; key: string } {
  let best = { confidence: -2, key: "unknown" };

  for (let r = 0; r < 12; r++) {
    const maj = KS_MAJOR.map((_, i) => KS_MAJOR[(i - r + 12) % 12]);
    const min = KS_MINOR.map((_, i) => KS_MINOR[(i - r + 12) % 12]);
    const cMaj = pearson(chroma, maj);
    const cMin = pearson(chroma, min);

    if (cMaj > best.confidence) {
      best = { confidence: cMaj, key: `${NOTES[r]} major` };
    }

    if (cMin > best.confidence) {
      best = { confidence: cMin, key: `${NOTES[r]} minor` };
    }
  }

  return { confidence: Number(best.confidence.toFixed(2)), key: best.key };
}

// ---------------------------------------------------------------------------
// BPM (onset-envelope autocorrelation, folded to the D&B band).
// ---------------------------------------------------------------------------

const HOP_MS = 50;

function estimateBpm(samples: Float32Array): { bpm: number; onsetRate: number } {
  const hopSamples = Math.max(1, Math.round((HOP_MS / 1000) * SAMPLE_RATE));
  const hops = Math.floor(samples.length / hopSamples);
  const energy = new Float32Array(hops);

  for (let h = 0; h < hops; h++) {
    let sum = 0;

    for (let i = 0; i < hopSamples; i++) {
      const x = samples[h * hopSamples + i] ?? 0;
      sum += x * x;
    }

    energy[h] = Math.sqrt(sum / hopSamples);
  }

  // Half-wave-rectified energy delta = onset envelope.
  const env = new Float32Array(hops);
  let mean = 0;

  for (let h = 1; h < hops; h++) {
    env[h] = Math.max(0, energy[h] - energy[h - 1]);
    mean += env[h];
  }

  mean /= Math.max(1, hops);

  const centered = env.map((value) => value - mean);
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

  let bestLag = lagMin;
  let bestScore = -Infinity;

  for (let lag = lagMin; lag <= lagMax && lag < centered.length; lag++) {
    const score = autocorr(lag) / lag ** 0.5;

    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  // Parabolic sub-hop refinement.
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

  let bpm = (60 * (1000 / HOP_MS)) / refined;

  while (bpm < 160) {
    bpm *= 2;
  }

  while (bpm > 185) {
    bpm /= 2;
  }

  // Onset rate: peaks above a threshold per second (busy-ness; jungle reads high).
  const std = Math.sqrt(centered.reduce((s, v) => s + v * v, 0) / Math.max(1, centered.length));
  const threshold = mean + 0.6 * std;
  let onsets = 0;

  for (let h = 1; h < env.length - 1; h++) {
    if (env[h] > threshold && env[h] >= env[h - 1] && env[h] >= env[h + 1]) {
      onsets++;
    }
  }

  return {
    bpm: Number(Math.min(185, Math.max(160, bpm)).toFixed(2)),
    onsetRate: Number((onsets / ((hops * HOP_MS) / 1000)).toFixed(2)),
  };
}

// ---------------------------------------------------------------------------
// Sub-genre suggestion (heuristic from the features). Best-guess, provenance
// "auto" — a human review always overrides. Only the dnb sub-genre vocabulary.
// ---------------------------------------------------------------------------

function suggestTags(s: Spectral, onsetRate: number): string[] {
  // Jungle: breakbeat-busy + bright top end.
  if (onsetRate >= 7 && s.highRatio >= 0.25) {
    return ["jungle"];
  }

  // Neuro: noisy/modulated mids (reese) + bright + aggressive top.
  if (s.midFlatness >= 0.86 && s.centroidHz >= 3000) {
    return ["neurofunk"];
  }

  // Liquid: dark, tonal mids, smooth top, fat sub.
  if (s.centroidHz <= 2400 && s.midFlatness <= 0.82) {
    return ["liquid funk"];
  }

  return [];
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

log(`resolving preview for ${artist} — ${title}`);
const preview = await resolvePreview();

if (!preview) {
  console.error("[analyze] no preview found — cannot analyze");
  process.exit(2);
}

log(`preview: ${preview.source}`);
const samples = await loadSamples(preview.url);
log(`decoded ${(samples.length / SAMPLE_RATE).toFixed(1)}s @ ${SAMPLE_RATE}Hz`);

const spec = spectral(samples);
const { confidence, key } = estimateKey(spec.chroma);
const { bpm, onsetRate } = estimateBpm(samples);
const suggestedTags = suggestTags(spec, onsetRate);

// Key only above a confidence floor — atonal neuro keys weakly; better null.
const KEY_CONFIDENCE_FLOOR = 0.6;
const reliableKey = confidence >= KEY_CONFIDENCE_FLOOR ? key : null;

const output = {
  artist,
  bpm,
  features: {
    centroidHz: spec.centroidHz,
    highRatio: spec.highRatio,
    midFlatness: spec.midFlatness,
    onsetRate,
    subBassRatio: spec.subBassRatio,
  },
  key: reliableKey,
  keyConfidence: confidence,
  preview,
  suggestedTags,
  tagsSource: "auto",
  title,
};

console.log(JSON.stringify(output, null, 2));
