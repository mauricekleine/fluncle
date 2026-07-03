// The log-mel fingerprint feature — the shared spectral vocabulary of the
// plan-scoped matcher. The glass computes these 40 bins in-browser from its live
// AudioContext and streams them at 10Hz ({ cmd: "mel", frame: number[40] }); the
// bridge computes the SAME 40 bins server-side over each planned finding's 30s
// preview. Cosine-comparable only because both sides share this exact definition:
// 40 triangular mel bands over 0-8kHz, log1p-compressed, L2-normalized per frame.
//
// The de-risk spike (scratchpad/plan-pointer/align.ts) proved the primitive on
// real data (official previews aligned into a real set at cosine 0.87-0.985); this
// is its productionized, streaming-shaped form. Conventions mirror
// packages/video/src/pipeline/analyze-set.ts (ffmpeg decode) and reuse the render
// path's dependency-free FFT so a fingerprint reproduces exactly.

import { MEL_BINS, MEL_FMAX, MEL_FMIN } from "../contract";
import { fftInPlace, hannWindow } from "./fft";

/** The fingerprint SR: Nyquist 8kHz matches the mel span exactly; halves memory vs 22050. */
export const MEL_SAMPLE_RATE = 16000;
/** STFT window (power of two for the radix-2 FFT). */
export const MEL_FFT_SIZE = 2048;
/** Hop = 1600 samples @ 16kHz = 100ms => the glass's 10Hz frame rate. */
export const MEL_HOP = 1600;
/** The hop in milliseconds (the frame period; 10Hz). */
export const MEL_HOP_MS = (MEL_HOP / MEL_SAMPLE_RATE) * 1000;

const hzToMel = (f: number): number => 2595 * Math.log10(1 + f / 700);
const melToHz = (m: number): number => 700 * (10 ** (m / 2595) - 1);

/**
 * A mel triangular filter as a bin range + per-bin weight, precomputed once. The
 * filterbank spans MEL_BINS bands between MEL_FMIN..MEL_FMAX on the mel scale.
 */
type MelFilter = { start: number; end: number; weights: Float64Array };

function buildFilterbank(sampleRate: number, fftSize: number): MelFilter[] {
  const nyquistBins = fftSize / 2;
  const melLo = hzToMel(MEL_FMIN);
  const melHi = hzToMel(MEL_FMAX);
  // MEL_BINS+2 edges -> MEL_BINS triangular filters (each spans edge[m-1]..edge[m+1]).
  const edgesHz: number[] = [];
  for (let i = 0; i <= MEL_BINS + 1; i++) {
    edgesHz.push(melToHz(melLo + ((melHi - melLo) * i) / (MEL_BINS + 1)));
  }
  const binToHz = (k: number): number => (k * sampleRate) / fftSize;
  const filters: MelFilter[] = [];
  for (let m = 1; m <= MEL_BINS; m++) {
    const lo = edgesHz[m - 1];
    const center = edgesHz[m];
    const hi = edgesHz[m + 1];
    const startBin = Math.max(1, Math.floor((lo / sampleRate) * fftSize));
    const endBin = Math.min(nyquistBins, Math.ceil((hi / sampleRate) * fftSize));
    const weights = new Float64Array(Math.max(0, endBin - startBin));
    for (let k = startBin; k < endBin; k++) {
      const hz = binToHz(k);
      let w = 0;
      if (hz >= lo && hz <= center) {
        w = (hz - lo) / Math.max(1e-9, center - lo);
      } else if (hz > center && hz <= hi) {
        w = (hi - hz) / Math.max(1e-9, hi - center);
      }
      weights[k - startBin] = w;
    }
    filters.push({ end: endBin, start: startBin, weights });
  }
  return filters;
}

const FILTERBANK = buildFilterbank(MEL_SAMPLE_RATE, MEL_FFT_SIZE);
const WINDOW = hannWindow(MEL_FFT_SIZE);

/** L2-normalize a mel frame in place (so a frame dot-product is a cosine). */
export function l2Normalize(frame: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < frame.length; i++) {
    n += frame[i] * frame[i];
  }
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < frame.length; i++) {
    frame[i] /= n;
  }
  return frame;
}

/**
 * SHAPE-normalize a mel frame in place: subtract the per-frame mean, then L2.
 * This is the matcher's frame normalization on BOTH sides of the wire, and it is
 * load-bearing for cross-analyzer robustness: it removes each source's spectral
 * tilt/level (browser AnalyserNode vs ffmpeg FFT; preview master vs live mix), and
 * because log-power ≈ 2·log-amplitude per band, mean-subtraction + L2 collapses the
 * amplitude-vs-power analyzer difference to (nearly) the same unit vector. Raw
 * plain-L2 log-mel cosines on near-identical liquid DnB sit at 0.86+ everywhere
 * (tilt-dominated); shape cosines separate content (~0.6-0.9 self vs ~0.0-0.5
 * foreign, measured in the accuracy harness).
 */
export function shapeNormalize(frame: Float32Array): Float32Array {
  let mean = 0;
  for (let i = 0; i < frame.length; i++) {
    mean += frame[i];
  }
  mean /= frame.length || 1;
  for (let i = 0; i < frame.length; i++) {
    frame[i] -= mean;
  }
  return l2Normalize(frame);
}

/**
 * Compute one SHAPE-normalized log-mel frame from a windowed slice of mono PCM.
 * Pure and deterministic. `signal` must have at least `offset + MEL_FFT_SIZE`
 * samples. The glass streams RAW log-mel; the bridge shape-normalizes both the
 * wire frames and these fingerprints so the cosine compares content, not tilt.
 */
export function melFrameAt(signal: Float32Array, offset: number): Float32Array {
  const re = new Float64Array(MEL_FFT_SIZE);
  const im = new Float64Array(MEL_FFT_SIZE);
  for (let i = 0; i < MEL_FFT_SIZE; i++) {
    re[i] = signal[offset + i] * WINDOW[i];
    im[i] = 0;
  }
  fftInPlace(re, im);
  const out = new Float32Array(MEL_BINS);
  for (let m = 0; m < MEL_BINS; m++) {
    const filter = FILTERBANK[m];
    let acc = 0;
    for (let k = filter.start; k < filter.end; k++) {
      const w = filter.weights[k - filter.start];
      if (w > 0) {
        // AMPLITUDE accumulation (|X|, not |X|^2) — mirrors the glass's browser DSP,
        // which sums 10^(dB/20) per band (glass/client/dsp.ts melFrame). The live
        // window and the server-side preview fingerprints must share one definition
        // for the cosine to mean the same thing across the wire.
        acc += w * Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      }
    }
    out[m] = Math.log1p(acc);
  }
  return shapeNormalize(out);
}

/**
 * Turn a mono PCM signal (at MEL_SAMPLE_RATE) into the full sequence of
 * L2-normalized log-mel frames at the 100ms hop. This IS the server-side
 * fingerprint of a preview (and, in the offline accuracy harness, of the set).
 */
export function melFrames(signal: Float32Array): Float32Array[] {
  const frameCount = Math.max(0, Math.floor((signal.length - MEL_FFT_SIZE) / MEL_HOP) + 1);
  return Array.from({ length: frameCount }, (_, f) => melFrameAt(signal, f * MEL_HOP));
}
