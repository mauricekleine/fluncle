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
  console.error(
    'usage: bun analyze-track.ts --artist "<artist>" --title "<title>" [--isrc <isrc>]',
  );
  process.exit(1);
}

const log = (message: string) => console.error(`[analyze] ${message}`);

// ---------------------------------------------------------------------------
// Preview resolution (Deezer by ISRC + Deezer search + iTunes) — HTTP only.
// We gather ALL candidates rather than first-hit: the platforms often return
// DIFFERENT 30s windows of the same track (Deezer the intro, iTunes the drop).
// Analyzing each and keeping the most-confident read per field beats betting on
// one clip that might be a beatless build-up.
// ---------------------------------------------------------------------------

type Preview = { source: string; url: string };

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function resolvePreviews(): Promise<Preview[]> {
  const found: Preview[] = [];
  const push = (source: string, url: string | undefined | null) => {
    if (url && !found.some((p) => p.url === url)) {
      found.push({ source, url });
    }
  };

  // 1. Deezer by ISRC — the most precise (exact recording).
  if (isrc) {
    try {
      const response = await fetch(`https://api.deezer.com/track/isrc:${encodeURIComponent(isrc)}`);
      const track = (await response.json()) as { error?: unknown; preview?: string };

      if (!track.error) {
        push("deezer:isrc", track.preview);
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
    push("deezer:search", (body.data ?? []).find((item) => item.preview)?.preview);
  } catch {
    // fall through
  }

  // 3. iTunes — usually a different window of the song than Deezer.
  try {
    const term = encodeURIComponent(`${artist} ${title}`);
    const response = await fetch(
      `https://itunes.apple.com/search?term=${term}&media=music&limit=8`,
    );
    const body = (await response.json()) as {
      results?: Array<{ artistName?: string; previewUrl?: string; trackName?: string }>;
    };
    const hit = (body.results ?? []).find(
      (item) => item.previewUrl && normalize(item.artistName ?? "").includes(normalize(artist)),
    );
    push("itunes", hit?.previewUrl);
  } catch {
    // fall through
  }

  return found;
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
const BPM_WINDOW_S = 12; // analyze the busiest contiguous stretch, not the whole clip
const BPM_CONFIDENCE_FLOOR = 0.15; // normalized autocorr peak; below this → null
const BASS_CUTOFF_HZ = 150; // one-pole split: isolate the kick from pads/melody
const MID_CUTOFF_HZ = 2000;

// One-pole low-pass coefficient for a given cutoff.
function lowpassAlpha(cutoffHz: number, sampleRate: number): number {
  const dt = 1 / sampleRate;
  const rc = 1 / (2 * Math.PI * cutoffHz);

  return dt / (rc + dt);
}

// Octave-fold a raw tempo into the D&B band — WITHOUT clamping. Returns the
// in-band tempo, or null when no ×2^k of it lands in [160,185]. A tempo that
// can't fold is itself a low-confidence signal: better null than a fake number
// (the old code clamped such values to exactly 160, which read as "confident").
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

  // Split into bass/mid/high via one-pole filters (per-hop RMS). The kick lives
  // in the bass band, so a band-summed onset envelope catches the beat even when
  // pads dominate total energy — the trick the video pipeline uses to lock onto
  // beats that a full-spectrum envelope misses entirely.
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

  // Band-summed, half-wave-rectified onset envelope.
  const env = new Float32Array(hops);

  for (let h = 1; h < hops; h++) {
    env[h] =
      Math.max(0, bass[h] - bass[h - 1]) +
      Math.max(0, mid[h] - mid[h - 1]) +
      Math.max(0, high[h] - high[h - 1]);
  }

  // Onset rate over the whole clip (busy-ness; jungle reads high).
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

  // Energy window: previews often open on a beatless build-up. Slide a window and
  // score it by onset energy + a bass weight, so it lands on the section that has
  // the kick rather than a busy hi-hat fill or a pad swell.
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

  const energy0 = autocorr(0); // zero-lag = total windowed onset energy
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

  // Confidence = how strongly the beat period stands out (normalized peak).
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
// Run
// ---------------------------------------------------------------------------

const KEY_CONFIDENCE_FLOOR = 0.6; // below this, the key is unreliable → null

type PreviewAnalysis = {
  key: { confidence: number; key: string };
  source: string;
  spec: Spectral;
  tempo: { bpm: number | null; bpmConfidence: number; onsetRate: number };
};

log(`resolving previews for ${artist} — ${title}`);
const previews = await resolvePreviews();

if (previews.length === 0) {
  console.error("[analyze] no preview found — cannot analyze");
  process.exit(2);
}

log(`found ${previews.length} preview(s): ${previews.map((p) => p.source).join(", ")}`);

// Analyze every window. One clip may be a beatless build-up while another holds
// the drop — so we measure each and keep the most-confident read per field.
const analyses: PreviewAnalysis[] = [];

for (const preview of previews) {
  try {
    const samples = await loadSamples(preview.url);
    const spec = spectral(samples);
    const key = estimateKey(spec.chroma);
    const tempo = estimateBpm(samples);
    log(
      `${preview.source} (${(samples.length / SAMPLE_RATE).toFixed(1)}s): bpm ${tempo.bpm ?? "null"} (conf ${tempo.bpmConfidence}), key ${key.key} (conf ${key.confidence})`,
    );
    analyses.push({ key, source: preview.source, spec, tempo });
  } catch (error) {
    log(`${preview.source}: skipped — ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (analyses.length === 0) {
  console.error("[analyze] every preview failed to decode — cannot analyze");
  process.exit(2);
}

// The most beat-clear window (highest bpmConfidence) is the most rhythmically
// defined section, so its timbre best characterises the sub-genre — read the
// feature vector from it. BPM = the most confident NON-NULL read; key = the most
// confident read anywhere (key is a global property, section-independent).
const primary = [...analyses].sort((a, b) => b.tempo.bpmConfidence - a.tempo.bpmConfidence)[0];
const bestBpm = [...analyses]
  .sort((a, b) => b.tempo.bpmConfidence - a.tempo.bpmConfidence)
  .find((a) => a.tempo.bpm !== null);
const bestKey = [...analyses].sort((a, b) => b.key.confidence - a.key.confidence)[0];

const reliableKey = bestKey.key.confidence >= KEY_CONFIDENCE_FLOOR ? bestKey.key.key : null;

const output = {
  artist,
  bpm: bestBpm?.tempo.bpm ?? null,
  bpmConfidence: bestBpm?.tempo.bpmConfidence ?? primary.tempo.bpmConfidence,
  bpmSource: bestBpm?.source ?? null,
  features: {
    centroidHz: primary.spec.centroidHz,
    highRatio: primary.spec.highRatio,
    midFlatness: primary.spec.midFlatness,
    onsetRate: primary.tempo.onsetRate,
    subBassRatio: primary.spec.subBassRatio,
  },
  key: reliableKey,
  keyConfidence: bestKey.key.confidence,
  keySource: reliableKey ? bestKey.source : null,
  previews: analyses.map((a) => ({
    bpm: a.tempo.bpm,
    bpmConfidence: a.tempo.bpmConfidence,
    keyConfidence: a.key.confidence,
    source: a.source,
  })),
  title,
};

console.log(JSON.stringify(output, null, 2));
