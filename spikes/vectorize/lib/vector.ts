// Pure vector math over raw float arrays. No Cloudflare imports — this is the
// ground-truth cosine used by the recall harness and the corpus generator, and
// it must run under plain `bun test` with zero infra.

import { gaussian, type Rng } from "./prng";

export const DIMENSIONS = 1024;

/** Euclidean magnitude. */
export function magnitude(v: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i] ?? 0;
    sum += x * x;
  }
  return Math.sqrt(sum);
}

/** Returns a unit-length copy of `v`. A zero vector is returned unchanged. */
export function normalize(v: ArrayLike<number>): Float32Array {
  const mag = magnitude(v);
  const out = new Float32Array(v.length);
  if (mag === 0) {
    return out;
  }
  for (let i = 0; i < v.length; i++) {
    out[i] = (v[i] ?? 0) / mag;
  }
  return out;
}

/** Dot product. Assumes equal length. */
export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return sum;
}

/**
 * Cosine similarity in [-1, 1]. Divides by magnitudes so it is correct for
 * non-unit inputs; for unit vectors it reduces to the dot product. This is the
 * exact metric Vectorize approximates (metric=cosine), so it is the ground truth
 * for the recall A/B.
 */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const denom = magnitude(a) * magnitude(b);
  if (denom === 0) {
    return 0;
  }
  return dot(a, b) / denom;
}

/** A deterministic random UNIT vector, uniform on the sphere (gaussian + normalise). */
export function randomUnitVector(rng: Rng, dim: number = DIMENSIONS): Float32Array {
  const raw = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    raw[i] = gaussian(rng);
  }
  return normalize(raw);
}

/**
 * Average a set of vectors into one, then normalise — the "pre-averaged single
 * probe" shape the `like` surface uses (average K anchor vectors into one query).
 */
export function averageUnit(vectors: ArrayLike<number>[], dim: number = DIMENSIONS): Float32Array {
  const acc = new Float32Array(dim);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) {
      acc[i] = (acc[i] ?? 0) + (v[i] ?? 0);
    }
  }
  return normalize(acc);
}

/** Convert to a plain number[] (the shape Vectorize's query()/upsert() accept). */
export function toArray(v: Float32Array): number[] {
  return Array.from(v);
}
