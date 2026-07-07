#!/usr/bin/env bun
// analyze-track — self-contained audio analysis for a Fluncle track.
//
// Zero npm dependencies. External tools only: `ffmpeg` (on PATH) and network
// access (Deezer/iTunes for the preview). It does NOT import any Fluncle code, so
// it runs anywhere the skill is installed — a local session or the Hermes box.
//
// Given an artist + title (the agent gets these from `fluncle track get --json`),
// it resolves a legal preview clip, decodes it, and emits an analysis JSON on
// stdout: BPM, musical key (+confidence), and spectral features. The agent then
// writes the result back with `fluncle admin tracks update`.
//
// With `--audio-file <path>` it skips preview resolution and analyzes THAT local file
// (the captured full song the enrich sweep S3-GETs from the private fluncle-source-audio
// bucket) — the whole song rather than a 30s preview (RFC docs/rfcs/full-audio-rfc.md § Unit 2).
//
//   bun analyze-track.ts --artist "Loadstar" --title "Take a Deep Breath" [--isrc GB5KW1701923]
//   bun analyze-track.ts --artist "Loadstar" --title "Take a Deep Breath" --audio-file /tmp/song.opus
//
// Output (stdout): a single JSON object. Diagnostics go to stderr.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);

  return index >= 0 ? process.argv[index + 1] : undefined;
}

const artist = arg("artist");
const title = arg("title");
const isrc = arg("isrc");
const archiveDir = arg("archive-dir");
// When set, analyze THIS local file (the captured full song the enrich sweep S3-GETs
// from the private fluncle-source-audio bucket) instead of resolving a 30s preview —
// RFC docs/rfcs/full-audio-rfc.md § Unit 2. Everything downstream is source-agnostic.
const audioFile = arg("audio-file");

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

// Version-aware matching (self-contained; the skill imports no Fluncle code). A
// finding's ISRC names the EXACT recording — an original and its remix carry
// DIFFERENT ISRCs. The fuzzy Deezer-search + iTunes legs return the whole release
// family, so without a version gate a REMIX finding's BPM/key/feature vector could
// be computed from the ORIGINAL (the fuzzy candidate outvoting the ISRC one). These
// helpers mirror packages/video's resolve-preview / apps/web's discogs resolver:
// the candidate's version descriptor must AGREE with the finding's.
const VERSION_MARKER =
  /\b(mix|edit|version|remix|dub|vip|bootleg|rework|re-?edit|flip|refix|remaster(?:ed)?|instrumental)\b/i;
const REMIX_MARKER = /\b(remix|bootleg|vip|rework|re-?edit|flip|refix)\b/i;
const VERSION_STOPWORDS = new Set(["mix", "the", "and", "feat", "ft", "edit", "version", "remix"]);

function titleTokens(value: string): string[] {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

function versionTokens(value: string): Set<string> {
  const parts = value.split(/\s+-\s+/);
  const tail = parts.length > 1 ? (parts[parts.length - 1] ?? "") : "";
  if (parts.length > 1 && VERSION_MARKER.test(tail)) {
    return new Set(titleTokens(tail));
  }
  const bracketed = /[([]([^)\]]*?)[)\]]/.exec(value);
  if (bracketed?.[1] && VERSION_MARKER.test(bracketed[1])) {
    return new Set(titleTokens(bracketed[1]));
  }
  return new Set();
}

/**
 * Whether a candidate title is the SAME version as the finding (directional).
 * Exported so the focused test can exercise it without running the pipeline (the
 * full run is guarded by `import.meta.main`).
 */
export function versionMatches(findingTitle: string, candidateTitle: string): boolean {
  const findingIsRemix = REMIX_MARKER.test(findingTitle);
  const candidateIsRemix = REMIX_MARKER.test(candidateTitle);

  if (findingIsRemix) {
    if (!candidateIsRemix) {
      return false;
    }
    const want = [...versionTokens(findingTitle)].filter((t) => !VERSION_STOPWORDS.has(t));
    if (want.length === 0) {
      return true;
    }
    const have = versionTokens(candidateTitle);
    return want.every((token) => have.has(token));
  }

  return !candidateIsRemix;
}

async function resolvePreviews(): Promise<Preview[]> {
  const found: Preview[] = [];
  const push = (source: string, url: string | undefined | null) => {
    if (url && !found.some((p) => p.url === url)) {
      found.push({ source, url });
    }
  };

  const findingTitle = title ?? "";

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

  // 2. Deezer search by artist + title — VERSION-GATED so a remix finding never
  //    pulls in the original's preview alongside the ISRC candidate.
  try {
    const query = `artist:"${artist}" track:"${title}"`;
    const response = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(query)}`);
    const body = (await response.json()) as {
      data?: Array<{ artist?: { name?: string }; preview?: string; title?: string }>;
    };
    const hit = (body.data ?? []).find(
      (item) => item.preview && versionMatches(findingTitle, item.title ?? ""),
    );
    push("deezer:search", hit?.preview);
  } catch {
    // fall through
  }

  // 3. iTunes — usually a different window of the song than Deezer. Also version-
  //    gated (artist contains + same version) so it can't seed the wrong recording.
  try {
    const term = encodeURIComponent(`${artist} ${title}`);
    const response = await fetch(
      `https://itunes.apple.com/search?term=${term}&media=music&limit=8`,
    );
    const body = (await response.json()) as {
      results?: Array<{ artistName?: string; previewUrl?: string; trackName?: string }>;
    };
    const hit = (body.results ?? []).find(
      (item) =>
        item.previewUrl &&
        normalize(item.artistName ?? "").includes(normalize(artist ?? "")) &&
        versionMatches(findingTitle, item.trackName ?? ""),
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

type LoadedPreview = {
  bytes: Buffer;
  mime: string;
  samples: Float32Array;
};

// The shared decode tail: ffmpeg reads `inputPath` (a fetched preview OR a captured
// full song — any container/ext; ffmpeg probes the content, not the name) → mono
// SAMPLE_RATE 16-bit WAV → PCM Float32. Factored out so the URL preview path and the
// local `--audio-file` path share ONE decoder (RFC docs/rfcs/full-audio-rfc.md § Unit 2).
// Exported so a focused test can exercise the seam without the full pipeline.
export function decodeToSamples(inputPath: string): Float32Array {
  const dir = mkdtempSync(join(tmpdir(), "fluncle-decode-"));

  try {
    const wavPath = join(dir, "decoded.wav");
    const result = spawnSync(
      "ffmpeg",
      ["-y", "-i", inputPath, "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "wav", wavPath],
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

async function loadPreview(previewUrl: string): Promise<LoadedPreview> {
  const dir = mkdtempSync(join(tmpdir(), "fluncle-analyze-"));

  try {
    const srcPath = join(dir, "preview");
    const response = await fetch(previewUrl);
    const bytes = Buffer.from(await response.arrayBuffer());
    writeFileSync(srcPath, bytes);

    return {
      bytes,
      mime:
        normalizePreviewMime(response.headers.get("content-type") ?? "") ??
        inferPreviewMime(previewUrl) ??
        "audio/mpeg",
      samples: decodeToSamples(srcPath),
    };
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

// Load a LOCAL audio file — the captured full song (`--audio-file`). Mirrors
// bpm-backfill/scripts/analyze-local.ts: ffmpeg reads the path directly, any format.
// `bytes`/`mime` are kept so the archive + `previews` output shape is identical to the
// URL path; mime is inferred from the extension (ffmpeg itself probes the content).
// Exported so the focused test can exercise the seam.
export function loadLocalFile(filePath: string): LoadedPreview {
  return {
    bytes: readFileSync(filePath),
    mime: inferFileMime(filePath),
    samples: decodeToSamples(filePath),
  };
}

function normalizePreviewMime(value: string): string | undefined {
  const mime = value.split(";")[0]?.trim().toLowerCase();

  if (mime === "audio/mpeg" || mime === "audio/mp3") {
    return "audio/mpeg";
  }

  if (mime === "audio/mp4" || mime === "audio/x-m4a" || mime === "audio/m4a") {
    return "audio/mp4";
  }

  if (mime === "audio/aac") {
    return "audio/aac";
  }

  return undefined;
}

function inferPreviewMime(url: string): string | undefined {
  const pathname = new URL(url).pathname.toLowerCase();

  if (pathname.endsWith(".mp3")) {
    return "audio/mpeg";
  }

  if (pathname.endsWith(".m4a")) {
    return "audio/mp4";
  }

  if (pathname.endsWith(".aac")) {
    return "audio/aac";
  }

  return undefined;
}

// Infer an audio content-type from a LOCAL file's extension (the `--audio-file`
// path). Only for the output shape / archive metadata — ffmpeg probes the real
// container regardless. Covers the yt-dlp `bestaudio` extensions capture produces.
function inferFileMime(filePath: string): string {
  const lower = filePath.toLowerCase();

  if (lower.endsWith(".m4a") || lower.endsWith(".mp4")) {
    return "audio/mp4";
  }

  if (lower.endsWith(".aac")) {
    return "audio/aac";
  }

  if (lower.endsWith(".opus")) {
    return "audio/opus";
  }

  if (lower.endsWith(".webm")) {
    return "audio/webm";
  }

  if (lower.endsWith(".flac")) {
    return "audio/flac";
  }

  if (lower.endsWith(".wav")) {
    return "audio/wav";
  }

  if (lower.endsWith(".ogg") || lower.endsWith(".oga")) {
    return "audio/ogg";
  }

  return "audio/mpeg";
}

function previewExtension(mime: string): string {
  if (mime === "audio/mp4") {
    return "m4a";
  }

  if (mime === "audio/aac") {
    return "aac";
  }

  return "mp3";
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

// AcousticBrainz-by-ISRC fallback — the clean, structured BPM source mirrored from
// the manual bpm-backfill skill's Step 1 (ISRC → MusicBrainz recording MBID →
// AcousticBrainz `rhythm.bpm`). Best-effort: any error, 404, missing recording, or
// non-numeric field → null, so the caller keeps the analyzer's honest null. The
// AcousticBrainz BPM is a real measured tempo, so it should octave-fold cleanly
// into the D&B band; if it can't fold, treat it as a miss (in-band discipline).
// `fetchImpl` is injectable so this is testable without touching the network.
export async function acousticBrainzBpmByIsrc(
  isrc: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<number | null> {
  if (!isrc) {
    return null;
  }

  // MusicBrainz requires a descriptive User-Agent and rate-limits to ~1 req/s.
  const userAgent = "fluncle-track-enrichment/1.0 ( hey@mauricekleine.com )";
  const headers = { "User-Agent": userAgent };

  try {
    // ISRC → MusicBrainz recording MBID. Resolving by ISRC is exact-recording, so
    // the first recording is the right one (zero matching risk).
    const mbResponse = await fetchImpl(
      `https://musicbrainz.org/ws/2/recording?query=isrc:${encodeURIComponent(isrc)}&fmt=json`,
      { headers },
    );

    if (!mbResponse.ok) {
      return null;
    }

    const mbBody = (await mbResponse.json()) as { recordings?: Array<{ id?: string }> };
    const mbid = mbBody.recordings?.[0]?.id;

    if (!mbid) {
      return null;
    }

    // MBID → AcousticBrainz BPM. A 404 means "not in the archive" (the project
    // froze in 2022) → miss.
    const abResponse = await fetchImpl(
      `https://acousticbrainz.org/api/v1/${encodeURIComponent(mbid)}/low-level`,
      { headers },
    );

    if (!abResponse.ok) {
      return null;
    }

    const abBody = (await abResponse.json()) as { rhythm?: { bpm?: unknown } };
    const bpm = abBody.rhythm?.bpm;

    if (typeof bpm !== "number" || !Number.isFinite(bpm) || bpm <= 0) {
      return null;
    }

    const folded = foldToBand(bpm);

    return folded === null ? null : Number(folded.toFixed(2));
  } catch {
    return null;
  }
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
  bytes: Buffer;
  key: { confidence: number; key: string };
  mime: string;
  source: string;
  spec: Spectral;
  tempo: { bpm: number | null; bpmConfidence: number; onsetRate: number };
};

// Only run the full pipeline when this file is the directly-invoked entry. On
// import (e.g. from a test), `import.meta.main` is false, so the analyzer can be
// imported to exercise `acousticBrainzBpmByIsrc` in isolation without resolving
// previews or hitting the network.
if (import.meta.main) {
  if (!artist || !title) {
    console.error(
      'usage: bun analyze-track.ts --artist "<artist>" --title "<title>" [--isrc <isrc>] [--audio-file <path>]',
    );
    process.exit(1);
  }

  // Analyze each candidate window, keeping the most-confident read per field. One
  // preview clip may be a beatless build-up while another holds the drop; a captured
  // full song is a single whole-track window that is usually the confident read.
  const analyses: PreviewAnalysis[] = [];

  if (audioFile) {
    // Full-song path (RFC docs/rfcs/full-audio-rfc.md § Unit 2): the enrich sweep S3-GETs
    // the captured source audio to a temp file and passes it here, so we analyze the
    // WHOLE song instead of a 30s preview — skip preview resolution entirely.
    // Everything downstream (spectral / key / BPM / fold) is source-agnostic.
    log(`analyzing captured full song ${audioFile}`);

    try {
      const loaded = loadLocalFile(audioFile);
      const spec = spectral(loaded.samples);
      const key = estimateKey(spec.chroma);
      const tempo = estimateBpm(loaded.samples);
      log(
        `audio-file (${(loaded.samples.length / SAMPLE_RATE).toFixed(1)}s): bpm ${tempo.bpm ?? "null"} (conf ${tempo.bpmConfidence}), key ${key.key} (conf ${key.confidence})`,
      );
      analyses.push({
        bytes: loaded.bytes,
        key,
        mime: loaded.mime,
        source: "audio-file",
        spec,
        tempo,
      });
    } catch (error) {
      console.error(
        `[analyze] audio-file decode failed — ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(2);
    }
  } else {
    log(`resolving previews for ${artist} — ${title}`);
    const previews = await resolvePreviews();

    if (previews.length === 0) {
      console.error("[analyze] no preview found — cannot analyze");
      process.exit(2);
    }

    log(`found ${previews.length} preview(s): ${previews.map((p) => p.source).join(", ")}`);

    for (const preview of previews) {
      try {
        const loaded = await loadPreview(preview.url);
        const spec = spectral(loaded.samples);
        const key = estimateKey(spec.chroma);
        const tempo = estimateBpm(loaded.samples);
        log(
          `${preview.source} (${(loaded.samples.length / SAMPLE_RATE).toFixed(1)}s): bpm ${tempo.bpm ?? "null"} (conf ${tempo.bpmConfidence}), key ${key.key} (conf ${key.confidence})`,
        );
        analyses.push({
          bytes: loaded.bytes,
          key,
          mime: loaded.mime,
          source: preview.source,
          spec,
          tempo,
        });
      } catch (error) {
        log(
          `${preview.source}: skipped — ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  if (analyses.length === 0) {
    console.error("[analyze] nothing decoded — cannot analyze");
    process.exit(2);
  }

  // The most beat-clear window (highest bpmConfidence) is the most rhythmically
  // defined section, so its timbre best characterises the feature vector. BPM =
  // the most confident NON-NULL read; key = the most confident read anywhere (key
  // is a global property, section-independent).
  const primary = [...analyses].sort((a, b) => b.tempo.bpmConfidence - a.tempo.bpmConfidence)[0];
  const bestBpm = [...analyses]
    .sort((a, b) => b.tempo.bpmConfidence - a.tempo.bpmConfidence)
    .find((a) => a.tempo.bpm !== null);
  const bestKey = [...analyses].sort((a, b) => b.key.confidence - a.key.confidence)[0];

  // BPM decision. The preview path is primary; when it yields null (e.g. a
  // beatless build-up clip) AND we have an ISRC, fall back to the structured
  // AcousticBrainz-by-ISRC source (best-effort, in-band folded). A miss leaves
  // bpm null exactly as before — honest null over a fabricated number.
  let outputBpm = bestBpm?.tempo.bpm ?? null;
  let bpmSource = bestBpm?.source ?? null;

  if (outputBpm === null && isrc) {
    const fallbackBpm = await acousticBrainzBpmByIsrc(isrc);

    if (fallbackBpm !== null) {
      outputBpm = fallbackBpm;
      bpmSource = "acousticbrainz";
      log(`bpm fallback: acousticbrainz by isrc ${isrc} -> ${fallbackBpm}`);
    } else {
      log(`bpm fallback: acousticbrainz by isrc ${isrc} -> miss (staying null)`);
    }
  }

  const reliableKey = bestKey.key.confidence >= KEY_CONFIDENCE_FLOOR ? bestKey.key.key : null;
  let archivePreview:
    | {
        mime: string;
        path: string;
        source: string;
      }
    | undefined;

  if (archiveDir) {
    mkdirSync(archiveDir, { recursive: true });
    const path = join(archiveDir, `preview.${previewExtension(primary.mime)}`);
    writeFileSync(path, primary.bytes);
    archivePreview = { mime: primary.mime, path, source: primary.source };
    log(`archive preview -> ${path}`);
  }

  const output = {
    archivePreview,
    artist,
    bpm: outputBpm,
    bpmConfidence: bestBpm?.tempo.bpmConfidence ?? primary.tempo.bpmConfidence,
    bpmSource,
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
}
