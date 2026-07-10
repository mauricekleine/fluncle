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
// bucket) — the whole song rather than a 30s preview (docs/track-lifecycle.md).
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
// docs/track-lifecycle.md. Everything downstream is source-agnostic.
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

// Exported (with an explicit params object) so the ground-truth key eval can resolve
// the SAME preview windows the production pipeline analyzes. The CLI calls it with the
// module-level args.
export async function resolvePreviews(
  params: { artist?: string; isrc?: string; title?: string } = { artist, isrc, title },
): Promise<Preview[]> {
  const { artist: pArtist, isrc: pIsrc, title: pTitle } = params;
  const found: Preview[] = [];
  const push = (source: string, url: string | undefined | null) => {
    if (url && !found.some((p) => p.url === url)) {
      found.push({ source, url });
    }
  };

  const findingTitle = pTitle ?? "";

  // 1. Deezer by ISRC — the most precise (exact recording).
  if (pIsrc) {
    try {
      const response = await fetch(
        `https://api.deezer.com/track/isrc:${encodeURIComponent(pIsrc)}`,
      );
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
    const query = `artist:"${pArtist}" track:"${pTitle}"`;
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
    const term = encodeURIComponent(`${pArtist} ${pTitle}`);
    const response = await fetch(
      `https://itunes.apple.com/search?term=${term}&media=music&limit=8`,
    );
    const body = (await response.json()) as {
      results?: Array<{ artistName?: string; previewUrl?: string; trackName?: string }>;
    };
    const hit = (body.results ?? []).find(
      (item) =>
        item.previewUrl &&
        normalize(item.artistName ?? "").includes(normalize(pArtist ?? "")) &&
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
// local `--audio-file` path share ONE decoder (docs/track-lifecycle.md).
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

// Load a LOCAL audio file — the captured full song (`--audio-file`). ffmpeg reads
// the path directly, any format.
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
// Spectral features (the archived creative-fuel vector) + key profiles.
// ---------------------------------------------------------------------------

const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

// Key profiles, verbatim from Essentia's `src/algorithms/tonal/key.cpp`
// (github.com/MTG/essentia, AGPL) — the `krumhansl`, `temperley`, and Faraldo `edma`
// (electronic-dance-music corpus) tables. EDMA won the Rekordbox ground-truth eval
// (analyze-track.key-eval.ts): classical K-S profiles are weakest on the relative-key
// axis, which is DnB's dominant error. Krumhansl/Temperley are kept so the eval can
// re-measure them. Values not invented — copied from:
// https://github.com/MTG/essentia/blob/master/src/algorithms/tonal/key.cpp
type KeyProfiles = { major: number[]; minor: number[] };

const KEY_PROFILE_EDMA: KeyProfiles = {
  major: [1.0, 0.29, 0.5, 0.4, 0.6, 0.56, 0.32, 0.8, 0.31, 0.45, 0.42, 0.39],
  minor: [1.0, 0.31, 0.44, 0.58, 0.33, 0.49, 0.29, 0.78, 0.43, 0.29, 0.53, 0.32],
};

const KEY_PROFILE_KRUMHANSL: KeyProfiles = {
  major: [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
  minor: [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17],
};

const KEY_PROFILE_TEMPERLEY: KeyProfiles = {
  major: [5.0, 2.0, 3.5, 2.0, 4.5, 4.0, 2.0, 4.5, 2.0, 3.5, 1.5, 4.0],
  minor: [5.0, 2.0, 3.5, 4.5, 2.0, 4.0, 2.0, 4.5, 3.5, 2.0, 1.5, 4.0],
};

// Faraldo `edmm` — the manually-tweaked EDM profile whose major table is uniform, so
// it reports (rare, poorly-represented) EDM majors as minor. Kept for the eval; the
// production estimator instead uses EDMA + a measured `majorBias` minor-prior, which
// recovers the relative-minor reads without throwing away genuine majors.
const KEY_PROFILE_EDMM: KeyProfiles = {
  major: [0.083, 0.083, 0.083, 0.083, 0.083, 0.083, 0.083, 0.083, 0.083, 0.083, 0.083, 0.083],
  minor: [
    0.17235348, 0.04, 0.0761009, 0.12, 0.05621498, 0.08527853, 0.0497915, 0.13451001, 0.07458916,
    0.05003023, 0.09187879, 0.05545106,
  ],
};

// The production profile pair, the ground-truth eval winner: EDMA's major table (so a
// genuinely strong EDM major still registers) with EDMM's manually-tuned minor table
// (the better minor shape). Paired with KEY_DEFAULTS.majorBias it beat every single
// profile on the 35-track Rekordbox set — 60% exact, zero relative-key errors.
const KEY_PROFILE_DEFAULT: KeyProfiles = {
  major: KEY_PROFILE_EDMA.major,
  minor: KEY_PROFILE_EDMM.minor,
};

// Exported so the ground-truth eval can sweep profiles without re-declaring them.
export const KEY_PROFILES = {
  default: KEY_PROFILE_DEFAULT,
  edma: KEY_PROFILE_EDMA,
  edmm: KEY_PROFILE_EDMM,
  krumhansl: KEY_PROFILE_KRUMHANSL,
  temperley: KEY_PROFILE_TEMPERLEY,
};

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
  highRatio: number;
  midFlatness: number;
  subBassRatio: number;
};

// The archived creative-fuel feature vector. Its 25 s window + linear-magnitude
// semantics are frozen: the stored rows depend on these EXACT numbers, so the key
// path was moved to its own whole-track chromagram below rather than widen this.
function spectral(samples: Float32Array): Spectral {
  const N = 4096;
  const hop = 2048;
  const hann = new Float64Array(N);

  for (let i = 0; i < N; i++) {
    hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  }

  const avgMag = new Float64Array(N / 2);
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
      avgMag[b] += Math.hypot(re[b], im[b]);
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
    highRatio: Number((high / (total || 1)).toFixed(3)),
    midFlatness: Number((geo / (arith || 1)).toFixed(3)),
    subBassRatio: Number((subBass / (total || 1)).toFixed(3)),
  };
}

// The whole-track chromagram key estimator. Tunable so the ground-truth eval can
// sweep ingredients; the defaults are the config that won that eval.
type KeyOptions = {
  compression: "log" | "none" | "sqrt";
  edgeSkipS: number;
  harmonicDecay: number;
  harmonics: number;
  hopS: number;
  majorBias: number;
  maxHz: number;
  minHz: number;
  peakThreshold: number;
  profiles: KeyProfiles;
  segmentS: number;
  tuning: boolean;
};

const KEY_DEFAULTS: KeyOptions = {
  compression: "sqrt", // tame the DnB sub-bass so it can't drown the mid thirds
  edgeSkipS: 3, // skip intro/outro build-ups where the harmony is thin
  harmonicDecay: 0.6, // HPCP-style decay across the harmonic ladder
  harmonics: 4, // credit each peak to fundamentals f/h, h=1..4 (de-alias the 5th → III)
  hopS: 6, // overlapping segments so a section vote has enough members
  // EDM minor-prior: a note's relative major shares its diatonic set, so the
  // correlation flips minor DnB to its relative MAJOR on thin margins. DnB is
  // overwhelmingly minor, so subtract a small penalty from every major correlation —
  // enough to reclaim the relative-minor reads without unseating a genuinely strong
  // major. The value is the ground-truth eval winner (analyze-track.key-eval.ts).
  majorBias: 0.15,
  maxHz: 3520, // A7 — chroma band ceiling
  minHz: 110, // A2 — below this is bass energy, not harmony
  peakThreshold: 0.1, // peaks below 10% of the frame max are noise/percussion
  profiles: KEY_PROFILE_DEFAULT,
  segmentS: 12, // ~a phrase; long enough for a stable key, short enough to vote
  tuning: false, // measured no gain on the eval — off keeps the estimator single-pass
};

const KEY_FFT = 8192; // 2.7 Hz bins at 22050 Hz — resolves semitones down to A2
const KEY_HOP = 4096;
const KEY_HANN = (() => {
  const w = new Float64Array(KEY_FFT);

  for (let i = 0; i < KEY_FFT; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (KEY_FFT - 1));
  }

  return w;
})();

function compressMag(m: number, mode: KeyOptions["compression"]): number {
  if (mode === "log") {
    return Math.log1p(m);
  }

  if (mode === "sqrt") {
    return Math.sqrt(m);
  }

  return m;
}

// Spectral peaks of one analysis frame: local magnitude maxima above a per-frame
// threshold, with parabolic interpolation for a precise peak frequency. Peaks are the
// percussive-rejection mechanism — a broadband drum hit is noise-like (no sharp
// maxima), so it never enters the chroma the way raw per-bin magnitude did.
function framePeaks(
  samples: Float32Array,
  start: number,
  opts: KeyOptions,
): Array<{ freq: number; mag: number }> {
  const N = KEY_FFT;
  const re = new Float64Array(N);
  const im = new Float64Array(N);

  for (let i = 0; i < N; i++) {
    re[i] = (samples[start + i] ?? 0) * KEY_HANN[i];
  }

  fft(re, im);

  const half = N / 2;
  const mag = new Float64Array(half);
  let maxMag = 0;

  for (let b = 1; b < half; b++) {
    const m = Math.hypot(re[b], im[b]);
    mag[b] = m;

    if (m > maxMag) {
      maxMag = m;
    }
  }

  const peaks: Array<{ freq: number; mag: number }> = [];

  if (maxMag <= 0) {
    return peaks;
  }

  const binHz = SAMPLE_RATE / N;
  const threshold = opts.peakThreshold * maxMag;
  const loBin = Math.max(2, Math.floor(opts.minHz / binHz));
  const hiBin = Math.min(half - 2, Math.ceil(opts.maxHz / binHz));

  for (let b = loBin; b <= hiBin; b++) {
    const m = mag[b];

    if (m < threshold || m < (mag[b - 1] ?? 0) || m < (mag[b + 1] ?? 0)) {
      continue;
    }

    const a = mag[b - 1] ?? 0;
    const c = mag[b + 1] ?? 0;
    const denom = a - 2 * m + c;
    const delta = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
    peaks.push({ freq: (b + delta) * binHz, mag: m });
  }

  return peaks;
}

// Global tuning offset (semitone fraction, +sharp) as the circular mean of every
// peak's deviation from the equal-tempered grid — so a track cut a few cents off
// concert pitch still bins to the right pitch classes.
function estimateTuning(samples: Float32Array, lo: number, hi: number, opts: KeyOptions): number {
  let sx = 0;
  let sy = 0;

  for (let start = lo; start + KEY_FFT <= hi; start += KEY_HOP) {
    for (const p of framePeaks(samples, start, opts)) {
      const midi = 69 + 12 * Math.log2(p.freq / 440);
      const angle = 2 * Math.PI * (midi - Math.round(midi));
      const w = Math.sqrt(p.mag);
      sx += w * Math.cos(angle);
      sy += w * Math.sin(angle);
    }
  }

  return sx === 0 && sy === 0 ? 0 : Math.atan2(sy, sx) / (2 * Math.PI);
}

// One segment's 12-bin chroma. Each frame's peaks are de-aliased up the harmonic
// ladder (a peak at f credits fundamentals f/h for h=1..H), which pulls the injected
// energy of a note's overtones — its fifth (3rd harmonic) and, crucially, its MAJOR
// THIRD (5th harmonic) — back toward the true root instead of biasing the mode. Each
// frame is normalized to unit sum before summing, so a loud drop frame does not
// outvote the rest of the phrase.
function segmentChroma(
  samples: Float32Array,
  from: number,
  to: number,
  opts: KeyOptions,
  tuning: number,
): number[] {
  const chroma = Array.from({ length: 12 }, () => 0);

  for (let start = from; start + KEY_FFT <= to; start += KEY_HOP) {
    const peaks = framePeaks(samples, start, opts);

    if (peaks.length === 0) {
      continue;
    }

    const frame = Array.from({ length: 12 }, () => 0);

    for (const p of peaks) {
      const amp = compressMag(p.mag, opts.compression);

      for (let h = 1; h <= opts.harmonics; h++) {
        const f0 = p.freq / h;

        if (f0 < opts.minHz || f0 > opts.maxHz) {
          continue;
        }

        const midi = 69 + 12 * Math.log2(f0 / 440) - tuning;
        const pc = ((Math.round(midi) % 12) + 12) % 12;
        frame[pc] += amp * opts.harmonicDecay ** (h - 1);
      }
    }

    let sum = 0;

    for (const v of frame) {
      sum += v;
    }

    if (sum > 0) {
      for (let i = 0; i < 12; i++) {
        chroma[i] += (frame[i] ?? 0) / sum;
      }
    }
  }

  return chroma;
}

// A key profile rotated so pitch class `root` is the tonic (matches the legacy K-S
// rotation: index i draws from profile[(i - root + 12) % 12]).
function rotateProfile(profile: number[], root: number): number[] {
  return profile.map((_, i) => profile[(i - root + 12) % 12] ?? 0);
}

// Best major/minor key for a 12-bin chroma, by Pearson correlation against the 24
// rotated profiles. `majorBias` is subtracted from every MAJOR correlation (the EDM
// minor-prior — see KEY_DEFAULTS.majorBias).
function scoreChroma(
  chroma: number[],
  profiles: KeyProfiles,
  majorBias: number,
): { corr: number; mode: "major" | "minor"; root: number } {
  let bestCorr = -2;
  let bestMode: "major" | "minor" = "major";
  let bestRoot = 0;

  for (let r = 0; r < 12; r++) {
    const candidates = [
      {
        corr: pearson(chroma, rotateProfile(profiles.major, r)) - majorBias,
        mode: "major" as const,
      },
      { corr: pearson(chroma, rotateProfile(profiles.minor, r)), mode: "minor" as const },
    ];

    for (const candidate of candidates) {
      if (candidate.corr > bestCorr) {
        bestCorr = candidate.corr;
        bestMode = candidate.mode;
        bestRoot = r;
      }
    }
  }

  return { corr: bestCorr, mode: bestMode, root: bestRoot };
}

// Estimate the musical key over the WHOLE track. Segment the audio into overlapping
// phrase-length windows, build an HPCP-style chroma per segment, pick the key of the
// summed (global) chroma, and report the fraction of segments that independently agree
// as the confidence — a vote, not a single fragile correlation. `opts` is a test/eval
// seam; production uses KEY_DEFAULTS. Output contract stays `{ confidence, key }` with
// key sharp-spelled `"<Note> major|minor"`.
export function estimateKey(
  samples: Float32Array,
  opts?: Partial<KeyOptions>,
): { confidence: number; key: string } {
  const o: KeyOptions = { ...KEY_DEFAULTS, ...opts };
  const edge = Math.round(o.edgeSkipS * SAMPLE_RATE);
  const segLen = Math.round(o.segmentS * SAMPLE_RATE);
  const hop = Math.max(1, Math.round(o.hopS * SAMPLE_RATE));

  // Analysis span: trim the intro/outro, but never trim away everything (short clips).
  let lo = edge;
  let hi = samples.length - edge;

  if (hi - lo < KEY_FFT) {
    lo = 0;
    hi = samples.length;
  }

  if (hi - lo < KEY_FFT) {
    return { confidence: 0, key: "unknown" };
  }

  const tuning = o.tuning ? estimateTuning(samples, lo, hi, o) : 0;

  // Collect one chroma per overlapping segment.
  const segments: number[][] = [];
  const span = hi - lo;
  const window = Math.min(segLen, span);

  for (let from = lo; from + window <= hi; from += hop) {
    const to = Math.min(from + window, hi);
    const chroma = segmentChroma(samples, from, to, o, tuning);
    let sum = 0;

    for (const v of chroma) {
      sum += v;
    }

    if (sum > 0) {
      segments.push(chroma);
    }

    if (to >= hi) {
      break;
    }
  }

  if (segments.length === 0) {
    return { confidence: 0, key: "unknown" };
  }

  // Global chroma decides the key; segment agreement with it is the confidence.
  const global = Array.from({ length: 12 }, () => 0);

  for (const chroma of segments) {
    for (let i = 0; i < 12; i++) {
      global[i] += chroma[i] ?? 0;
    }
  }

  const winner = scoreChroma(global, o.profiles, o.majorBias);
  const label = `${NOTES[winner.root]} ${winner.mode}`;

  // An agreement VOTE needs voters: a clip too short for at least two overlapping
  // segments (< ~18 s) would score a meaningless 1/1 = full confidence off a single
  // segment trivially agreeing with itself. Report the read but at zero confidence,
  // so the floor nulls it — a 30 s preview still yields 3 segments and a real vote.
  if (segments.length < 2) {
    return { confidence: 0, key: label };
  }

  let agree = 0;

  for (const chroma of segments) {
    const s = scoreChroma(chroma, o.profiles, o.majorBias);

    if (s.root === winner.root && s.mode === winner.mode) {
      agree++;
    }
  }

  return { confidence: Number((agree / segments.length).toFixed(2)), key: label };
}

// ---------------------------------------------------------------------------
// BPM (onset-envelope tempo comb over the D&B band).
// ---------------------------------------------------------------------------

// The tempo comb runs on a fine ~100 Hz onset envelope (10 ms hop). A 50 ms hop is
// under-resolved for the 160–185 D&B band: at 174 BPM the beat period is only ~6.9
// hops, so the autocorrelation at integer lags nearly vanishes and the picker lands on
// syncopation intervals instead of the beat. The finer hop puts ~34 samples across one
// beat, which is what lets the comb resolve tempo to the scan granularity.
const BPM_HOP_MS = 10;
// onsetRate stays on the ORIGINAL 50 ms hop so features.onsetRate remains
// distribution-compatible with the archived rows — it is a busy-ness measure, not a
// tempo, and shifting its hop would silently move every stored number.
const ONSET_HOP_MS = 50;
const BPM_WINDOW_S = 20; // score the busiest contiguous stretch — previews open on build-ups
const BPM_CONFIDENCE_FLOOR = 0.15; // normalized comb score; below this → null (honest out-of-band)
const BPM_BAND_MIN = 160; // the D&B tempo band; a comb winner outside it is not reliable
const BPM_BAND_MAX = 185;
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

// AcousticBrainz-by-ISRC fallback — a clean, structured BPM source (ISRC → MusicBrainz
// recording MBID → AcousticBrainz `rhythm.bpm`), reached only when the DSP itself yields
// a null BPM. Best-effort: any error, 404, missing recording, or
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

// Three-band (bass/mid/high) half-wave-rectified onset envelope at a given hop.
// One-pole filters split the signal (per-hop RMS): the kick lives in the bass band,
// so a band-summed onset envelope catches the beat even when pads dominate total
// energy — the trick the video pipeline uses to lock onto beats a full-spectrum
// envelope misses entirely. `bass` is returned alongside so the BPM window picker can
// weight it and land on the section that actually carries the kick. `hopSamples` is
// the ROUNDED integer hop (round(220.5) = 221 at 22050 Hz), returned so the caller can
// derive the true envelope rate rather than assuming 1000 / hopMs.
function onsetEnvelope(
  samples: Float32Array,
  hopMs: number,
): { bass: Float32Array; env: Float32Array; hopSamples: number; hops: number } {
  const hopSamples = Math.max(1, Math.round((hopMs / 1000) * SAMPLE_RATE));
  const hops = Math.floor(samples.length / hopSamples);
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

  return { bass, env, hopSamples, hops };
}

// Onset rate over the whole clip (busy-ness; jungle reads high). Kept on the 50 ms hop
// so features.onsetRate stays distribution-compatible with the archive (see
// ONSET_HOP_MS): the count of prominent onset peaks per second, threshold = mean +
// 0.6·std of the envelope.
function onsetRateOf(samples: Float32Array): number {
  const { env, hops } = onsetEnvelope(samples, ONSET_HOP_MS);
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

  return Number((onsets / Math.max(1e-6, (hops * ONSET_HOP_MS) / 1000)).toFixed(2));
}

// Tempo estimator: a comb over the D&B band scored against the onset envelope's
// autocorrelation. Where a plain autocorrelation-peak picker at 50 ms lands on
// syncopation intervals in the 160–185 band, the comb sums each candidate tempo's
// harmonics, so the true beat and all its multiples reinforce one answer — and a
// half-time track folds up through its even harmonics. Out-of-band music scores below
// the confidence floor and returns null rather than a fabricated in-band number.
// Exported so the focused BPM test can exercise it on decoded synthetic fixtures
// without resolving previews or hitting the network.
export function estimateBpm(samples: Float32Array): {
  bpm: number | null;
  bpmConfidence: number;
  onsetRate: number;
} {
  const onsetRate = onsetRateOf(samples);

  // The comb runs on the fine 10 ms envelope.
  const { bass, env, hopSamples, hops } = onsetEnvelope(samples, BPM_HOP_MS);

  // Energy window: previews often open on a beatless build-up. Slide a window and
  // score it by onset energy + a bass weight, so it lands on the section that has
  // the kick rather than a busy hi-hat fill or a pad swell.
  const winHops = Math.min(hops, Math.round((BPM_WINDOW_S * 1000) / BPM_HOP_MS));
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

    let bestWindowScore = onsetRun + 2 * bassRun;

    for (let h = winHops; h < hops; h++) {
      onsetRun += (env[h] - env[h - winHops]) / envMax;
      bassRun += (bass[h] - bass[h - winHops]) / bassMax;
      const score = onsetRun + 2 * bassRun;

      if (score > bestWindowScore) {
        bestWindowScore = score;
        winStart = h - winHops + 1;
      }
    }
  }

  // 1-2-1 smoothing before autocorrelation: the fine envelope's onset spikes are only
  // 1–2 hops wide, and un-smoothed narrow peaks biased the comb high by ~0.4 BPM.
  const smoothed = new Float32Array(hops);

  for (let h = 0; h < hops; h++) {
    smoothed[h] = ((env[h - 1] ?? 0) + 2 * env[h] + (env[h + 1] ?? 0)) / 4;
  }

  const win = smoothed.subarray(winStart, winStart + winHops);
  let winMean = 0;

  for (const v of win) {
    winMean += v;
  }

  winMean /= Math.max(1, win.length);
  const centered = Float64Array.from(win, (v) => v - winMean);

  // Lag→BPM MUST use the TRUE envelope rate SAMPLE_RATE / hopSamples, not
  // 1000 / BPM_HOP_MS: hopSamples is rounded (round(220.5) = 221 at 22050 Hz), so an
  // assumed 100 Hz rate is 0.23% off — a constant +0.40 BPM bias at 174 (measured
  // before this correction).
  const envRate = SAMPLE_RATE / hopSamples;

  // Full autocorrelation out to 8 beats at the slowest candidate tempo.
  const maxLag = Math.min(centered.length - 1, Math.ceil((60 / BPM_BAND_MIN) * envRate * 8) + 2);
  const ac = new Float64Array(maxLag + 1);

  for (let lag = 0; lag <= maxLag; lag++) {
    let acc = 0;

    for (let i = lag; i < centered.length; i++) {
      acc += centered[i] * centered[i - lag];
    }

    // Unbiased: divide by the overlap count so longer lags aren't tapered down, which
    // would tilt the comb toward shorter lags (higher BPM).
    ac[lag] = acc / Math.max(1, centered.length - lag);
  }

  const energy0 = ac[0]; // zero-lag = total windowed onset energy

  if (energy0 <= 0) {
    return { bpm: null, bpmConfidence: 0, onsetRate };
  }

  // Quadratic (3-point) interpolation of the autocorrelation at a fractional lag —
  // linear interpolation of these narrow peaks biased the comb by +0.4 BPM.
  const interp = (x: number): number => {
    const i = Math.round(x);

    if (i < 1 || i + 1 > maxLag) {
      return 0;
    }

    const a = ac[i - 1];
    const b = ac[i];
    const c = ac[i + 1];
    const f = x - i; // in [-0.5, 0.5]

    return b + 0.5 * f * (c - a) + 0.5 * f * f * (a - 2 * b + c);
  };

  // Tempo comb: score each candidate BPM by the mean autocorrelation at k×period for
  // k=1..8. The true beat and all its harmonics reinforce one candidate; a half-time
  // track (e.g. 87 BPM) folds up because its even harmonics line up with 174. Scan a
  // little past the band edges so an in-band winner is a genuine local best.
  let bestBpm = 0;
  let bestScore = -Infinity;

  for (let bpm = BPM_BAND_MIN - 2; bpm <= BPM_BAND_MAX + 2; bpm += 0.02) {
    const period = (60 / bpm) * envRate;
    let score = 0;
    let weights = 0;

    for (let k = 1; k <= 8; k++) {
      const lag = k * period;

      if (lag > maxLag) {
        break;
      }

      score += interp(lag);
      weights += 1;
    }

    if (weights === 0) {
      continue;
    }

    score /= weights;

    if (score > bestScore) {
      bestScore = score;
      bestBpm = bpm;
    }
  }

  // Confidence = how strongly the winning comb stands out (normalized by zero-lag
  // energy). Out-of-band music scores below the floor → honest null over a fake tempo.
  const confidence = Math.max(0, bestScore / energy0);
  const inBand = bestBpm >= BPM_BAND_MIN && bestBpm <= BPM_BAND_MAX;
  const reliable = inBand && confidence >= BPM_CONFIDENCE_FLOOR;

  return {
    bpm: reliable ? Number(bestBpm.toFixed(2)) : null,
    bpmConfidence: Number(confidence.toFixed(3)),
    onsetRate,
  };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

// Key confidence is now the segment-vote AGREEMENT FRACTION (0..1), not a Pearson
// correlation. 0.6 = a clear majority of the whole-track segments landed on the same
// key. On the Rekordbox ground-truth eval this floor nulled exactly the two
// low-agreement (0.5) reads — both wrong — so precision on non-null outputs rose from
// 60.0% to 63.6% exact with no correct read lost and a 5.7% null rate.
const KEY_CONFIDENCE_FLOOR = 0.6; // below this, the vote is too split → honest null

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
    // Full-song path (docs/track-lifecycle.md): the enrich sweep S3-GETs
    // the captured source audio to a temp file and passes it here, so we analyze the
    // WHOLE song instead of a 30s preview — skip preview resolution entirely.
    // Everything downstream (spectral / key / BPM / fold) is source-agnostic.
    log(`analyzing captured full song ${audioFile}`);

    try {
      const loaded = loadLocalFile(audioFile);
      const spec = spectral(loaded.samples);
      const key = estimateKey(loaded.samples);
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
        const key = estimateKey(loaded.samples);
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
