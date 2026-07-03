// Unit O · chapter props — slice the mastered set audio at the cue boundaries and
// analyze each slice into a FULL-LENGTH per-chapter `CosmosAudio`.
//
// This is NOT `analyzeAudio` (which selects a best 20 s window inside a ≤30 s
// preview). A chapter is minutes long and every second is on screen, so the whole
// slice becomes the reactive curves — energy/bass/mid/treble + the fine
// sub/kick/snare/air bands + flux, spanning 0..chapterDurationMs. It reuses the
// EXACT shared DSP kernel (audio-curves.ts) and the render-path estimators
// (analyze-audio.ts) + the set-path multi-drop picker (analyze-set.ts) — no DSP is
// forked. The one genuinely-new choice is passing MULTIPLE `dropCandidates` (the
// one-shot-climax design note: a long chapter that should re-slam needs more than
// one drop window, or it leans on the continuous energy/swell envelopes).
//
// The set audio itself is the SOURCE OF TRUTH for the reactivity — the chapter's
// look reacts to the actual mixed set, not the archived preview.

import { spawn } from "node:child_process";

import { type CosmosAudio, type EnergySample } from "../remotion/types";
import {
  type Bands,
  type DecodedWav,
  HOP_MS,
  computeBands,
  emphasizeTransients,
  normalizeBandsShared,
  normalizeInPlace,
  onsetEnvelope,
  percentile,
} from "../pipeline/audio-curves";
import {
  bestPhaseGrid,
  type DropCandidate,
  estimateBpmDetailed,
  pickDownbeats,
  pickOnsets,
} from "../pipeline/analyze-audio";
import { pickDrops } from "../pipeline/analyze-set";

const FFMPEG = process.env.FLUNCLE_FFMPEG ?? "ffmpeg";
// 22050Hz matches the render path so the band boundaries (Hz-derived in
// computeBands) are byte-identical to a per-track analysis.
const CHAPTER_SAMPLE_RATE = 22050;
// Chapter drops: a smaller inter-peak spacing than a whole 48-min set (a 2-4 min
// chapter still wants a few re-slam windows), capped so the list stays fuel.
const CHAPTER_DROP_SPACING_MS = 8_000;
const CHAPTER_DROP_TOP_N = 5;

/**
 * Decode a slice [startMs, endMs) of a local set-audio file to mono Float32 PCM
 * via a single ffmpeg pass (input-seek before -i, so only the slice is decoded).
 * Buffered — a few-minute chapter is a few MB, never the whole 48-min set.
 */
export async function decodeSlice(
  setAudioPath: string,
  startMs: number,
  endMs: number,
  sampleRate: number = CHAPTER_SAMPLE_RATE,
): Promise<DecodedWav> {
  const startSec = Math.max(0, startMs / 1000);
  const durSec = Math.max(0.1, (endMs - startMs) / 1000);
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      FFMPEG,
      [
        "-v",
        "error",
        "-ss",
        String(startSec),
        "-t",
        String(durSec),
        "-i",
        setAudioPath,
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
    child.stdout.on("data", (c: Buffer) => {
      chunks.push(c);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${FFMPEG} slice exited ${code}\n${stderr.slice(-2000)}`));
      }
    });
  });

  const buf = Buffer.concat(chunks);
  const frameCount = Math.floor(buf.length / 2);
  const samples = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i += 1) {
    samples[i] = buf.readInt16LE(i * 2) / 32768;
  }
  return { sampleRate, samples };
}

/** RAW crest factor (P98 / mean) of a band — the render path's rawDynamicsHint. */
function crestFactor(band: Float32Array): number {
  if (band.length === 0) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < band.length; i += 1) {
    sum += band[i] ?? 0;
  }
  const mean = sum / band.length;
  return percentile(band, 0.98) / Math.max(mean, 1e-9);
}

const toCurve = (arr: Float32Array): EnergySample[] =>
  Array.from(arr, (v, i) => ({ energy: Number(v.toFixed(4)), timeMs: i * HOP_MS }));

/**
 * Analyze a decoded chapter slice into a full-length `CosmosAudio`. Pure over the
 * decoded samples. `file` is inert for a set chapter (the parent strips
 * <TrackAudio> and mixes the mastered set once, at the end) but the contract
 * requires it; startMs is 0 (curves are chapter-relative).
 */
export function analyzeChapterAudio(decoded: DecodedWav, durationMs: number): CosmosAudio {
  const bands: Bands = computeBands(decoded);
  const flux = onsetEnvelope(bands);

  // Same normalization discipline as the render path, over the WHOLE chapter.
  const energy = new Float32Array(bands.full);
  const bass = new Float32Array(bands.bass);
  const mid = new Float32Array(bands.mid);
  const treble = new Float32Array(bands.high);
  normalizeInPlace(energy);
  normalizeBandsShared([bass, mid, treble]);
  const fluxNorm = new Float32Array(flux);
  normalizeInPlace(fluxNorm);

  // Fine bands: emphasize the kick/snare transients before the shared normalize.
  const sub = new Float32Array(bands.sub);
  const kick = emphasizeTransients(bands.kick);
  const snare = emphasizeTransients(bands.snare);
  const air = new Float32Array(bands.air);
  normalizeBandsShared([sub, kick, snare, air]);

  const rawDynamicsHint = {
    bass: Number(crestFactor(bands.bass).toFixed(4)),
    mid: Number(crestFactor(bands.mid).toFixed(4)),
    treble: Number(crestFactor(bands.high).toFixed(4)),
  };

  // Tempo + grid + onsets from the superflux envelope (loudness-robust).
  const { bpm, confidence: bpmConfidence } = estimateBpmDetailed(bands.superflux);
  const superfluxNorm = new Float32Array(bands.superflux);
  normalizeInPlace(superfluxNorm);
  const totalMs = bands.hopCount * HOP_MS;
  const beatGrid = bestPhaseGrid(superfluxNorm, bpm, totalMs);
  const onsets = pickOnsets(bands.superflux);

  // Downbeats: bar phase scored on the kick/sub attack (the kick on the one).
  const kickStrength = new Float32Array(bands.hopCount);
  for (let h = 1; h < bands.hopCount; h += 1) {
    const low = (bands.sub[h] ?? 0) + (bands.kick[h] ?? 0);
    const lowPrev = (bands.sub[h - 1] ?? 0) + (bands.kick[h - 1] ?? 0);
    kickStrength[h] = Math.max(0, low - lowPrev);
  }
  const downbeats = pickDownbeats(beatGrid, kickStrength);

  // Multiple drop windows across the whole chapter (the re-slam fuel). Reuses the
  // set-path multi-drop picker on the chapter's own normalized curves.
  const { peaks } = pickDrops(energy, bass, fluxNorm, {
    minPeakSpacingMs: CHAPTER_DROP_SPACING_MS,
    suggestionMs: Math.min(15_000, Math.max(4_000, totalMs / 4)),
    topN: CHAPTER_DROP_TOP_N,
  });
  const dropCandidates: DropCandidate[] = peaks
    .map((p) => ({ score: Number(p.score.toFixed(4)), timeMs: p.atMs }))
    .sort((a, b) => b.score - a.score);
  const dropMs = dropCandidates[0]?.timeMs;

  return {
    airCurve: toCurve(air),
    bassCurve: toCurve(bass),
    beatGrid,
    bpm: Number(bpm.toFixed(2)),
    bpmConfidence,
    ...(dropCandidates.length > 0 ? { dropCandidates, dropMs } : {}),
    downbeats,
    durationMs,
    energyCurve: toCurve(energy),
    file: "",
    fluxCurve: toCurve(fluxNorm),
    kickCurve: toCurve(kick),
    midCurve: toCurve(mid),
    onsets,
    rawDynamicsHint,
    snareCurve: toCurve(snare),
    startMs: 0,
    subCurve: toCurve(sub),
    trebleCurve: toCurve(treble),
  };
}

/** Slice + analyze one chapter from a local set-audio file into its CosmosAudio. */
export async function buildChapterAudio(
  setAudioPath: string,
  startMs: number,
  endMs: number,
): Promise<CosmosAudio> {
  const decoded = await decodeSlice(setAudioPath, startMs, endMs);
  return analyzeChapterAudio(decoded, endMs - startMs);
}
