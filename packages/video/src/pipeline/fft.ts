// Dependency-free radix-2 Cooley-Tukey FFT for offline audio analysis (the STFT
// band split in analyze-audio.ts). In-place forward transform on Float64Array
// re/im pairs; N MUST be a power of two. Fully deterministic — no Math.random /
// clock — so a render's audio analysis reproduces exactly.

/** Smallest power of two >= n (n >= 1). */
export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) {
    p <<= 1;
  }
  return p;
}

/** Periodic Hann window coefficients of length n (reduces spectral leakage). */
export function hannWindow(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  }
  return w;
}

/**
 * In-place radix-2 forward FFT. `re`/`im` are length N (a power of two); on
 * return they hold the complex spectrum. Standard bit-reversal + Danielson-
 * Lanczos butterflies with an incremental twiddle (the tiny accumulated rounding
 * over N=2048 is immaterial for band-power sums).
 */
export function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n <= 1) {
    return;
  }

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;
      const ti = im[i]!;
      im[i] = im[j]!;
      im[j] = ti;
    }
  }

  // Butterflies, doubling the transform length each stage.
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const br = re[b]!;
        const bi = im[b]!;
        const xr = br * cr - bi * ci;
        const xi = br * ci + bi * cr;
        const ar = re[a]!;
        const ai = im[a]!;
        re[b] = ar - xr;
        im[b] = ai - xi;
        re[a] = ar + xr;
        im[a] = ai + xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}
