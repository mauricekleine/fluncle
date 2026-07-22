// Deterministic, seeded PRNG so every corpus / probe set is byte-for-byte
// reproducible across runs and machines. NO Math.random anywhere in the spike.
//
// mulberry32: a fast 32-bit generator with a single uint32 of state. Good enough
// for synthetic vectors (we are measuring latency + recall mechanics, not
// cryptographic quality).

export type Rng = () => number;

/** Returns a stateful generator producing floats in [0, 1). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A standard-normal sample via Box-Muller. Sampling each vector component from
 * N(0,1) and normalising yields points distributed UNIFORMLY on the unit sphere
 * (uniform [0,1) components would bias every vector into the positive orthant,
 * making cosine similarities uselessly high).
 */
export function gaussian(rng: Rng): number {
  // Guard against log(0): u1 in (0, 1].
  const u1 = 1 - rng();
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Deterministic integer in [min, max] inclusive. */
export function intBetween(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}
