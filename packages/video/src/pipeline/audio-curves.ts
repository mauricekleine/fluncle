// Shared audio curve-builders for the offline DSP. These are the per-hop spectral
// primitives — the Hann-windowed STFT band split, the onset/flux envelope, and the
// normalizers — factored out of analyze-audio.ts so BOTH the per-track render path
// (analyze-audio.ts, 20s-window selection) and the set-analysis path (analyze-set.ts,
// full-length envelope + drop picker) import the SAME kernel. The math here is moved
// verbatim from analyze-audio.ts; the render path's behavior is unchanged.
//
// Pure + deterministic — no Math.random / clock — so analysis reproduces exactly.

import { fftInPlace, hannWindow, nextPow2 } from "./fft";

/** The internal analysis hop. Both paths analyze at 20ms; the set path decimates
 * the *output* curve to a coarser display hop, but the analysis stays at 20ms. */
export const HOP_MS = 20;
export const BASS_CUTOFF_HZ = 150;
export const MID_CUTOFF_HZ = 2000;

export type DecodedWav = {
  samples: Float32Array;
  sampleRate: number;
};

export type Bands = {
  /** Per-hop overall RMS (time-domain) + per-band magnitude, aligned arrays. */
  full: Float32Array;
  bass: Float32Array;
  mid: Float32Array;
  high: Float32Array;
  hopCount: number;
};

/**
 * Per-hop band magnitudes via STFT. `full` is the time-domain RMS (so the energy
 * curve / u_energy / the drop envelope are identical); the bands come from a
 * Hann-windowed FFT split by bin frequency — a clean spectral separation, replacing
 * the old one-pole filters whose 6dB/oct rolloff bled a kick into mid and a snare
 * into bass+treble. Each band ships its PEAK bin power (not the mean-per-bin): the
 * transient that IS the kick survives instead of being averaged across the whole
 * band's bins, and peak-per-band is bin-count-independent by construction — no
 * /binCount scaling needed to keep the three bands comparable. The shortened ~46ms
 * STFT frame (paired with the 20ms hop) keeps inter-frame overlap sane so onsets/BPM
 * stay sharp.
 *
 * Pure + deterministic. The frame size scales with the sample rate, so this is
 * correct at the render path's 22050Hz AND the set path's 11025Hz.
 */
export function computeBands(decoded: DecodedWav): Bands {
  const { samples, sampleRate } = decoded;
  const hopSamples = Math.max(1, Math.round((HOP_MS / 1000) * sampleRate));
  const hopCount = Math.floor(samples.length / hopSamples);

  // STFT frame ~46ms, power of two (1024 at 22050Hz → ~21.5Hz/bin → ~7 bins
  // below the 150Hz bass cutoff; scales with the rate if it ever changes). Band
  // boundaries are Hz-derived (floor(cutoff/binHz)) so they auto-recompute.
  const fftSize = nextPow2(Math.round(sampleRate * 0.046));
  const half = fftSize >> 1;
  const win = hannWindow(fftSize);
  const binHz = sampleRate / fftSize;
  const bassMaxBin = Math.max(1, Math.floor(BASS_CUTOFF_HZ / binHz));
  const midMaxBin = Math.max(bassMaxBin + 1, Math.floor(MID_CUTOFF_HZ / binHz));

  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);

  const full = new Float32Array(hopCount);
  const bass = new Float32Array(hopCount);
  const mid = new Float32Array(hopCount);
  const high = new Float32Array(hopCount);

  for (let h = 0; h < hopCount; h++) {
    const start = h * hopSamples;

    // Overall energy: time-domain RMS over the hop (identical to before).
    let sFull = 0;
    for (let i = 0; i < hopSamples; i++) {
      const x = samples[start + i] ?? 0;
      sFull += x * x;
    }
    full[h] = Math.sqrt(sFull / hopSamples);

    // Bands: Hann-windowed FFT over a frame centred on the hop.
    const frameStart = start + (hopSamples >> 1) - half;
    for (let i = 0; i < fftSize; i++) {
      const s = frameStart + i;
      re[i] = (s >= 0 && s < samples.length ? samples[s] : 0) * win[i];
      im[i] = 0;
    }
    fftInPlace(re, im);

    // Peak bin power per band (transient punch survives; bin-count-independent).
    // Bass spans the FULL <150Hz range (the sub-bass that IS D&B's kick), taking
    // its single hottest bin — never narrowed to a 40-120Hz sub-band.
    let pBass = 0;
    let pMid = 0;
    let pHigh = 0;
    for (let k = 1; k <= half; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      if (k <= bassMaxBin) {
        if (p > pBass) {
          pBass = p;
        }
      } else if (k <= midMaxBin) {
        if (p > pMid) {
          pMid = p;
        }
      } else {
        if (p > pHigh) {
          pHigh = p;
        }
      }
    }
    bass[h] = Math.sqrt(pBass);
    mid[h] = Math.sqrt(pMid);
    high[h] = Math.sqrt(pHigh);
  }

  return { bass, full, high, hopCount, mid };
}

/** Half-wave-rectified summed band-energy delta = onset envelope (per hop). */
export function onsetEnvelope(bands: Bands): Float32Array {
  const { bass, mid, high, hopCount } = bands;
  const env = new Float32Array(hopCount);
  for (let h = 1; h < hopCount; h++) {
    const dBass = Math.max(0, bass[h] - bass[h - 1]);
    const dMid = Math.max(0, mid[h] - mid[h - 1]);
    const dHigh = Math.max(0, high[h] - high[h - 1]);
    env[h] = dBass + dMid + dHigh;
  }
  return env;
}

/** Divide an array by its own max, in place. No-op on an all-zero array. */
export function normalizeInPlace(arr: Float32Array): void {
  let max = 0;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] > max) {
      max = arr[i];
    }
  }
  if (max <= 0) {
    return;
  }
  for (let i = 0; i < arr.length; i++) {
    arr[i] /= max;
  }
}

/**
 * P-percentile (0..1) of a copy of `values`. Robust to a lone clip/crash outlier
 * the way an absolute max is not. Returns 0 on an empty input.
 */
export function percentile(values: Float32Array, p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = Float32Array.from(values).sort();
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[idx] ?? 0;
}

/**
 * Normalize the three bands to ONE shared reference so cross-band loudness
 * survives (the kick reads louder than the hats). The reference is the Nth
 * percentile of the POOLED band magnitudes (default 97th) — robust, so a single
 * clip/crash hop cannot crush the rest toward zero the way divide-by-absolute-max
 * did. A mild perceptual lift (pow gamma, default 0.7 < 1) raises groove detail
 * off the floor without clipping the peaks. Clamped to [0,1]. Mutates in place.
 */
export function normalizeBandsShared(
  bands: Float32Array[],
  opts: { percentile: number; gamma: number } = { gamma: 0.7, percentile: 0.97 },
): void {
  // Pool all band samples to pick one shared divisor.
  let total = 0;
  for (const b of bands) {
    total += b.length;
  }
  const pool = new Float32Array(total);
  let o = 0;
  for (const b of bands) {
    pool.set(b, o);
    o += b.length;
  }
  const ref = percentile(pool, opts.percentile);
  if (ref <= 0) {
    return;
  }
  for (const b of bands) {
    for (let i = 0; i < b.length; i++) {
      const v = Math.min(1, b[i] / ref);
      b[i] = opts.gamma === 1 ? v : Math.pow(v, opts.gamma);
    }
  }
}
