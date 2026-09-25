import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { type StudioEnvelope, type StudioPeak, type StudioSuggestion } from "@fluncle/contracts";

import {
  type Bands,
  HOP_MS,
  computeBands,
  meanRange,
  movingAverage,
  normalizeBandsShared,
  normalizeInPlace,
  onsetEnvelope,
} from "./audio-curves";
import { bestPhaseGrid, estimateBpm, pickOnsets } from "./analyze-audio";

export type { StudioEnvelope, StudioPeak, StudioSuggestion };

const FFMPEG = process.env.FLUNCLE_FFMPEG ?? "ffmpeg";
const FFPROBE = process.env.FLUNCLE_FFPROBE ?? "ffprobe";

const SET_SAMPLE_RATE = 11025;
const DISPLAY_HOP_MS = 100;

const DEFAULT_SUGGESTION_MS = 15_000;
const DEFAULT_TOP_N = 8;
const DEFAULT_MIN_PEAK_SPACING_MS = 35_000;
const NOVELTY_PRE_MS = 3_000;
const NOVELTY_POST_MS = 3_000;
const REENTRY_FLUX_MS = 800;
const BAR_SMOOTH_MS = 1_400;
const LOCAL_NORM_HALF_MS = 30_000;
const LOCAL_TEMPO_HALF_MS = 8_000;
const DROP_SCORE_WEIGHT = 1.0;
const MULTI_TEMPO_TOLERANCE_BPM = 4;

export type AnalyzeSetOptions = {
  sampleRate?: number;
  displayHopMs?: number;
  suggestionMs?: number;
  topN?: number;
  minPeakSpacingMs?: number;
};

async function probeDurationSec(setPath: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(FFPROBE, [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=nokey=1:noprint_wrappers=1",
      setPath,
    ]);
    let out = "";
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString();
    });

    child.on("error", () => resolve(0));
    child.on("close", () => {
      const n = Number.parseFloat(out.trim());
      resolve(Number.isFinite(n) && n > 0 ? n : 0);
    });
  });
}

async function decodeSetMono(setPath: string, sampleRate: number): Promise<Float32Array> {
  const durationSec = await probeDurationSec(setPath);

  let samples = new Float32Array(Math.max(sampleRate, Math.ceil((durationSec + 2) * sampleRate)));
  let count = 0;
  let leftover = -1;

  const push = (v: number): void => {
    if (count >= samples.length) {
      const grown = new Float32Array(Math.ceil(samples.length * 1.5) + sampleRate);
      grown.set(samples);
      samples = grown;
    }
    samples[count++] = v;
  };

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      FFMPEG,
      [
        "-v",
        "error",
        "-i",
        setPath,
        "-ac",
        "1",
        "-ar",
        String(sampleRate),
        "-f",
        "s16le",
        "-acodec",
        "pcm_s16le",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stderr = "";
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString();
    });

    child.stdout.on("data", (chunk: Buffer) => {
      const end = chunk.length;
      let i = 0;

      if (leftover >= 0 && end > 0) {
        const raw = leftover | (chunk[0] << 8);
        push((raw >= 0x8000 ? raw - 0x10000 : raw) / 32768);
        leftover = -1;
        i = 1;
      }

      for (; i + 1 < end; i += 2) {
        push(chunk.readInt16LE(i) / 32768);
      }

      if (i < end) {
        leftover = chunk[i];
      }
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${FFMPEG} exited with ${code}\n${stderr.slice(-2000)}`));
      }
    });
  });

  return count === samples.length ? samples : samples.subarray(0, count);
}

function slidingMax(arr: Float32Array, halfWin: number): Float32Array {
  const n = arr.length;
  const out = new Float32Array(n);
  if (n === 0) {
    return out;
  }
  const dq: number[] = [];
  let head = 0;

  for (let j = 0; j < n; j++) {
    while (head < dq.length && arr[dq[dq.length - 1]] <= arr[j]) {
      dq.pop();
    }
    dq.push(j);
    const c = j - halfWin;
    if (c >= 0) {
      while (head < dq.length && dq[head] < c - halfWin) {
        head++;
      }
      out[c] = arr[dq[head]];
    }
  }

  for (let c = Math.max(0, n - halfWin); c < n; c++) {
    while (head < dq.length && dq[head] < c - halfWin) {
      head++;
    }
    out[c] = head < dq.length ? arr[dq[head]] : 0;
  }
  return out;
}

function decimate(arr: Float32Array, factor: number): number[] {
  if (factor <= 1) {
    return Array.from(arr, (v) => Number(v.toFixed(4)));
  }
  const out: number[] = [];
  for (let i = 0; i + factor <= arr.length; i += factor) {
    let s = 0;
    for (let j = 0; j < factor; j++) {
      s += arr[i + j];
    }
    out.push(Number((s / factor).toFixed(4)));
  }
  return out;
}

export type PickResult = {
  bpm: number | null;
  peaks: StudioPeak[];
  suggestions: StudioSuggestion[];
};

function estimateGlobalBpm(flux: Float32Array): number | null {
  const half = Math.round(LOCAL_TEMPO_HALF_MS / HOP_MS);
  const span = half * 2;
  if (flux.length < span) {
    return null;
  }
  const probes: number[] = [];

  const probeCount = Math.max(3, Math.min(12, Math.floor(flux.length / span)));
  for (let p = 0; p < probeCount; p++) {
    const centre = Math.round(((p + 0.5) / probeCount) * flux.length);
    const lo = Math.max(0, centre - half);
    const hi = Math.min(flux.length, lo + span);
    const slice = flux.subarray(lo, hi);
    if (slice.length >= span / 2) {
      probes.push(estimateBpm(slice));
    }
  }
  if (probes.length === 0) {
    return null;
  }
  let min = Infinity;
  let max = -Infinity;
  for (const b of probes) {
    min = Math.min(min, b);
    max = Math.max(max, b);
  }
  if (max - min > MULTI_TEMPO_TOLERANCE_BPM) {
    return null;
  }
  const sorted = [...probes].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return Number(median.toFixed(2));
}

function snapToLocalDownbeat(
  flux: Float32Array,
  peakHop: number,
): { anchorMs: number; barMs: number } {
  const half = Math.round(LOCAL_TEMPO_HALF_MS / HOP_MS);
  const lo = Math.max(0, peakHop - half);
  const hi = Math.min(flux.length, peakHop + half);
  const slice = flux.subarray(lo, hi);
  const peakMs = peakHop * HOP_MS;
  if (slice.length < 8) {
    return { anchorMs: peakMs, barMs: BAR_SMOOTH_MS };
  }
  const localBpm = estimateBpm(slice);
  const barMs = (60_000 / localBpm) * 4;
  const grid = bestPhaseGrid(slice, localBpm, slice.length * HOP_MS);
  const peakInSliceMs = (peakHop - lo) * HOP_MS;
  let nearest = peakInSliceMs;
  let best = Infinity;
  for (const g of grid) {
    const d = Math.abs(g - peakInSliceMs);
    if (d < best) {
      best = d;
      nearest = g;
    }
  }
  return { anchorMs: lo * HOP_MS + nearest, barMs };
}

export function pickDrops(
  energy: Float32Array,
  bass: Float32Array,
  flux: Float32Array,
  opts: {
    suggestionMs?: number;
    topN?: number;
    minPeakSpacingMs?: number;
  } = {},
): PickResult {
  const suggestionMs = opts.suggestionMs ?? DEFAULT_SUGGESTION_MS;
  const topN = opts.topN ?? DEFAULT_TOP_N;
  const minSpacingMs = opts.minPeakSpacingMs ?? DEFAULT_MIN_PEAK_SPACING_MS;

  const n = bass.length;
  const totalMs = n * HOP_MS;
  const bpm = estimateGlobalBpm(flux);

  if (n < 4) {
    return { bpm, peaks: [], suggestions: [] };
  }

  const barHalf = Math.max(1, Math.round(BAR_SMOOTH_MS / 2 / HOP_MS));
  const smoothBass = movingAverage(bass, barHalf);
  let fluxMax = 0;
  for (let i = 0; i < flux.length; i++) {
    if (flux[i] > fluxMax) {
      fluxMax = flux[i];
    }
  }
  const fluxScale = fluxMax > 0 ? fluxMax : 1;

  const preHops = Math.round(NOVELTY_PRE_MS / HOP_MS);
  const postHops = Math.round(NOVELTY_POST_MS / HOP_MS);
  const fluxHops = Math.round(REENTRY_FLUX_MS / HOP_MS);

  const dropScore = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    const pre = meanRange(smoothBass, t - preHops, t - 1);
    const post = meanRange(smoothBass, t, t + postHops);
    const rise = Math.max(0, post - pre);
    const reentry = meanRange(flux, t, t + fluxHops) / fluxScale;
    dropScore[t] = rise * post * (0.25 + 0.75 * Math.min(1, reentry));
  }

  const localHalf = Math.max(1, Math.round(LOCAL_NORM_HALF_MS / HOP_MS));
  const localMax = slidingMax(dropScore, localHalf);
  const dropNorm = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    dropNorm[t] = localMax[t] > 1e-9 ? dropScore[t] / localMax[t] : 0;
  }

  const neighHops = Math.max(1, Math.round(1_000 / HOP_MS));
  const candidates: { hop: number; norm: number; raw: number }[] = [];
  for (let t = 1; t < n - 1; t++) {
    if (dropNorm[t] < 0.5 || dropScore[t] <= 1e-9) {
      continue;
    }
    let isMax = true;
    for (let j = Math.max(0, t - neighHops); j <= Math.min(n - 1, t + neighHops); j++) {
      if (dropNorm[j] > dropNorm[t]) {
        isMax = false;
        break;
      }
    }
    if (isMax) {
      candidates.push({ hop: t, norm: dropNorm[t], raw: dropScore[t] });
    }
  }

  candidates.sort((a, b) => b.norm - a.norm || b.raw - a.raw);
  const minSpacingHops = Math.round(minSpacingMs / HOP_MS);
  const accepted: { hop: number; norm: number }[] = [];
  for (const c of candidates) {
    if (accepted.every((a) => Math.abs(a.hop - c.hop) >= minSpacingHops)) {
      accepted.push({ hop: c.hop, norm: c.norm });
    }
  }

  const onsets = pickOnsets(flux);

  const built = accepted.map(({ hop, norm }) => {
    const { anchorMs, barMs } = snapToLocalDownbeat(flux, hop);

    const preRollMs = Math.min(barMs, suggestionMs * 0.4);
    let startMs = Math.round(anchorMs - preRollMs);
    startMs = Math.max(0, Math.min(startMs, Math.max(0, totalMs - suggestionMs)));
    const durationMs = Math.min(suggestionMs, totalMs - startMs);

    const startHop = Math.round(startMs / HOP_MS);
    const endHop = Math.min(n, startHop + Math.round(durationMs / HOP_MS));
    let eSum = 0;
    let bSum = 0;
    const span = Math.max(1, endHop - startHop);
    for (let h = startHop; h < endHop; h++) {
      eSum += energy[h];
      bSum += bass[h];
    }
    const endMs = startMs + durationMs;
    const onsetCount = onsets.filter((o) => o >= startMs && o < endMs).length;
    const meanEnergy = eSum / span;
    const meanBass = bSum / span;
    const onsetDensity = onsetCount / (durationMs / 1000);
    const score = meanEnergy + 2 * meanBass + 0.02 * onsetDensity + DROP_SCORE_WEIGHT * norm;

    return { anchorMs: Math.round(anchorMs), durationMs, score, startMs };
  });

  built.sort((a, b) => b.score - a.score);
  const suggestions: StudioSuggestion[] = [];
  for (const s of built) {
    if (suggestions.length >= topN) {
      break;
    }
    if (suggestions.every((x) => Math.abs(x.anchorMs - s.anchorMs) >= minSpacingMs)) {
      suggestions.push({
        anchorMs: s.anchorMs,
        durationMs: s.durationMs,
        score: Number(s.score.toFixed(4)),
        startMs: s.startMs,
      });
    }
  }

  const peaks: StudioPeak[] = suggestions
    .map((s) => ({ atMs: s.anchorMs, kind: "drop" as const, score: s.score }))
    .sort((a, b) => a.atMs - b.atMs);

  return { bpm, peaks, suggestions };
}

export async function analyzeSet(
  setPath: string,
  opts: AnalyzeSetOptions = {},
): Promise<StudioEnvelope> {
  const sampleRate = opts.sampleRate ?? SET_SAMPLE_RATE;
  const displayHopMs = opts.displayHopMs ?? DISPLAY_HOP_MS;

  const samples = await decodeSetMono(setPath, sampleRate);
  const bands: Bands = computeBands({ sampleRate, samples });
  const fluxRaw = onsetEnvelope(bands);

  const energyHop = new Float32Array(bands.full);
  const bassHop = new Float32Array(bands.bass);
  const midHop = new Float32Array(bands.mid);
  const trebleHop = new Float32Array(bands.high);
  normalizeInPlace(energyHop);
  normalizeBandsShared([bassHop, midHop, trebleHop]);
  const fluxHop = new Float32Array(fluxRaw);
  normalizeInPlace(fluxHop);

  const { bpm, peaks, suggestions } = pickDrops(energyHop, bassHop, fluxHop, {
    minPeakSpacingMs: opts.minPeakSpacingMs,
    suggestionMs: opts.suggestionMs,
    topN: opts.topN,
  });

  const durationMs = bands.hopCount * HOP_MS;
  const factor = Math.max(1, Math.round(displayHopMs / HOP_MS));

  return {
    bass: decimate(bassHop, factor),
    bpm,
    durationMs,
    energy: decimate(energyHop, factor),
    flux: decimate(fluxHop, factor),
    hopMs: factor * HOP_MS,
    peaks,
    suggestions,
  };
}

export async function writeStudioEnvelope(
  setPath: string,
  outPath: string,
  opts: AnalyzeSetOptions = {},
): Promise<StudioEnvelope> {
  const envelope = await analyzeSet(setPath, opts);
  await writeFile(outPath, JSON.stringify(envelope));
  return envelope;
}

if (import.meta.main) {
  const [, , setPath, outPath] = process.argv;
  if (!setPath) {
    console.error("usage: analyze-set <set-audio> [out.json]");
    process.exit(1);
  }
  const target = outPath ?? `${setPath}.studio-envelope.json`;
  const env = await writeStudioEnvelope(setPath, target);
  console.log(
    `✓ analyze-set: ${(env.durationMs / 60000).toFixed(1)}min, bpm=${env.bpm ?? "null (multi-tempo)"}, ${env.suggestions.length} candidate drops → ${target}`,
  );
}
