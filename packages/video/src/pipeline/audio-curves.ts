import { fftInPlace, hannWindow, nextPow2 } from "./fft";

export const HOP_MS = 20;
export const BASS_CUTOFF_HZ = 150;
export const MID_CUTOFF_HZ = 2000;

export const SUB_CUTOFF_HZ = 60;
export const SNARE_MIN_HZ = 2000;
export const SNARE_MAX_HZ = 5000;

const SUPERFLUX_LOG_GAIN = 50;

export type DecodedWav = {
  samples: Float32Array;
  sampleRate: number;
};

export type Bands = {
  full: Float32Array;
  bass: Float32Array;
  mid: Float32Array;
  high: Float32Array;

  sub: Float32Array;

  kick: Float32Array;

  snare: Float32Array;

  air: Float32Array;

  superflux: Float32Array;
  hopCount: number;
};

export function computeBands(decoded: DecodedWav): Bands {
  const { samples, sampleRate } = decoded;
  const hopSamples = Math.max(1, Math.round((HOP_MS / 1000) * sampleRate));
  const hopCount = Math.floor(samples.length / hopSamples);

  const fftSize = nextPow2(Math.round(sampleRate * 0.046));
  const half = fftSize >> 1;
  const win = hannWindow(fftSize);
  const binHz = sampleRate / fftSize;
  const bassMaxBin = Math.max(1, Math.floor(BASS_CUTOFF_HZ / binHz));
  const midMaxBin = Math.max(bassMaxBin + 1, Math.floor(MID_CUTOFF_HZ / binHz));

  const subMaxBin = Math.max(1, Math.floor(SUB_CUTOFF_HZ / binHz));
  const snareMinBin = Math.max(midMaxBin, Math.floor(SNARE_MIN_HZ / binHz));
  const snareMaxBin = Math.max(snareMinBin + 1, Math.floor(SNARE_MAX_HZ / binHz));

  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);

  const full = new Float32Array(hopCount);
  const bass = new Float32Array(hopCount);
  const mid = new Float32Array(hopCount);
  const high = new Float32Array(hopCount);
  const sub = new Float32Array(hopCount);
  const kick = new Float32Array(hopCount);
  const snare = new Float32Array(hopCount);
  const air = new Float32Array(hopCount);
  const superflux = new Float32Array(hopCount);

  const prevLog = new Float64Array(half + 1);
  const currLog = new Float64Array(half + 1);

  for (let h = 0; h < hopCount; h++) {
    const start = h * hopSamples;

    let sFull = 0;
    for (let i = 0; i < hopSamples; i++) {
      const x = samples[start + i] ?? 0;
      sFull += x * x;
    }
    full[h] = Math.sqrt(sFull / hopSamples);

    const frameStart = start + (hopSamples >> 1) - half;
    for (let i = 0; i < fftSize; i++) {
      const s = frameStart + i;
      re[i] = (s >= 0 && s < samples.length ? samples[s] : 0) * win[i];
      im[i] = 0;
    }
    fftInPlace(re, im);

    let pBass = 0;
    let pMid = 0;
    let pHigh = 0;
    let pSub = 0;
    let pKick = 0;
    let pSnare = 0;
    let pAir = 0;
    let sf = 0;
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

      if (k <= subMaxBin) {
        if (p > pSub) {
          pSub = p;
        }
      } else if (k <= bassMaxBin) {
        if (p > pKick) {
          pKick = p;
        }
      } else if (k > snareMinBin && k <= snareMaxBin) {
        if (p > pSnare) {
          pSnare = p;
        }
      } else if (k > snareMaxBin) {
        if (p > pAir) {
          pAir = p;
        }
      }

      currLog[k] = Math.log1p(SUPERFLUX_LOG_GAIN * Math.sqrt(p));
      if (h > 0) {
        const prevMax = Math.max(prevLog[k - 1], prevLog[k], prevLog[Math.min(half, k + 1)]);
        const d = currLog[k] - prevMax;
        if (d > 0) {
          sf += d;
        }
      }
    }
    bass[h] = Math.sqrt(pBass);
    mid[h] = Math.sqrt(pMid);
    high[h] = Math.sqrt(pHigh);
    sub[h] = Math.sqrt(pSub);
    kick[h] = Math.sqrt(pKick);
    snare[h] = Math.sqrt(pSnare);
    air[h] = Math.sqrt(pAir);
    superflux[h] = h > 0 ? sf : 0;
    prevLog.set(currLog);
  }

  return { air, bass, full, high, hopCount, kick, mid, snare, sub, superflux };
}

export function emphasizeTransients(band: Float32Array, amount = 1.5): Float32Array {
  const out = new Float32Array(band.length);
  if (band.length > 0) {
    out[0] = band[0];
  }
  for (let h = 1; h < band.length; h++) {
    out[h] = band[h] + amount * Math.max(0, band[h] - band[h - 1]);
  }
  return out;
}

export function movingAverage(arr: Float32Array, halfWin: number): Float32Array {
  const n = arr.length;
  const out = new Float32Array(n);
  if (n === 0) {
    return out;
  }
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    prefix[i + 1] = prefix[i] + arr[i];
  }
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - halfWin);
    const hi = Math.min(n - 1, i + halfWin);
    out[i] = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1);
  }
  return out;
}

export function meanRange(arr: Float32Array, fromHop: number, toHop: number): number {
  const lo = Math.max(0, fromHop);
  const hi = Math.min(arr.length - 1, toHop);
  if (hi < lo) {
    return 0;
  }
  let s = 0;
  for (let i = lo; i <= hi; i++) {
    s += arr[i];
  }
  return s / (hi - lo + 1);
}

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

export function percentile(values: Float32Array, p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = Float32Array.from(values).sort();
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[idx] ?? 0;
}

export function normalizeBandsShared(
  bands: Float32Array[],
  opts: { percentile: number; gamma: number } = { gamma: 0.7, percentile: 0.97 },
): void {
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
