// Latency summary — p50/p95/p99/mean over a sample of per-iteration timings.
// Pure: no Cloudflare imports.

export type Summary = {
  count: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
};

/** Nearest-rank percentile over an already-SORTED ascending array. */
export function percentileSorted(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx] ?? 0;
}

export function summarize(samples: number[]): Summary {
  const n = samples.length;
  if (n === 0) {
    return { count: 0, max: 0, mean: 0, min: 0, p50: 0, p95: 0, p99: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  let sum = 0;
  for (const s of sorted) {
    sum += s;
  }
  return {
    count: n,
    max: sorted[n - 1] ?? 0,
    mean: sum / n,
    min: sorted[0] ?? 0,
    p50: percentileSorted(sorted, 50),
    p95: percentileSorted(sorted, 95),
    p99: percentileSorted(sorted, 99),
  };
}

/** Round a summary's timings to 2 d.p. for readable JSON. */
export function roundSummary(s: Summary): Summary {
  const r = (x: number): number => Math.round(x * 100) / 100;
  return {
    count: s.count,
    max: r(s.max),
    mean: r(s.mean),
    min: r(s.min),
    p50: r(s.p50),
    p95: r(s.p95),
    p99: r(s.p99),
  };
}
