import { MEL_BINS, MEL_FMAX, MEL_FMIN } from "../contract";
import { fftInPlace, hannWindow } from "./fft";

export const MEL_SAMPLE_RATE = 16000;

export const MEL_FFT_SIZE = 2048;

export const MEL_HOP = 1600;

export const MEL_HOP_MS = (MEL_HOP / MEL_SAMPLE_RATE) * 1000;

const hzToMel = (f: number): number => 2595 * Math.log10(1 + f / 700);
const melToHz = (m: number): number => 700 * (10 ** (m / 2595) - 1);

type MelFilter = { start: number; end: number; weights: Float64Array };

function buildFilterbank(sampleRate: number, fftSize: number): MelFilter[] {
  const nyquistBins = fftSize / 2;
  const melLo = hzToMel(MEL_FMIN);
  const melHi = hzToMel(MEL_FMAX);

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
        acc += w * Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      }
    }
    out[m] = Math.log1p(acc);
  }
  return shapeNormalize(out);
}

export function melFrames(signal: Float32Array): Float32Array[] {
  const frameCount = Math.max(0, Math.floor((signal.length - MEL_FFT_SIZE) / MEL_HOP) + 1);
  return Array.from({ length: frameCount }, (_, f) => melFrameAt(signal, f * MEL_HOP));
}
