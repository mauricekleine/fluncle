// overlap@K — the recall metric. Given the EXACT top-K ids (brute-force cosine
// ground truth) and the Vectorize ANN top-K ids for the same probe, overlap@K is
// the fraction of the exact top-K that Vectorize also returned:
//
//   overlap@K = |groundTruth[0..K) ∩ candidate[0..K)| / K
//
// 1.0 means the ANN result is indistinguishable from the exact scan at that K;
// Vectorize documents ~0.8 raw / >0.95 refined, never 1.0.
//
// Pure: no Cloudflare imports.

/** overlap@K over two id lists. K is clamped to the ground-truth length. */
export function overlapAtK(groundTruth: string[], candidate: string[], k: number): number {
  const kEff = Math.min(k, groundTruth.length);
  if (kEff <= 0) {
    return 0;
  }
  const truthTop = new Set(groundTruth.slice(0, kEff));
  const candTop = candidate.slice(0, kEff);
  let hits = 0;
  for (const id of candTop) {
    if (truthTop.has(id)) {
      hits++;
    }
  }
  return hits / kEff;
}

/** Mean of a set of overlap values (per-probe → per-surface average). */
export function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const v of values) {
    sum += v;
  }
  return sum / values.length;
}
