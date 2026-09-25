import { type Camelot, parseKey, toCamelot } from "../key-camelot";
import { cosineSimilarity, readEmbeddingBlob } from "./embedding";

export const MIX_WEIGHTS = { bpm: 0.15, key: 0.5, sonic: 0.35 } as const;
export const MIX_WEIGHTS_VERSION = 1;

export const BPM_BAND = { max: 185, min: 160 } as const;

export const SONIC_CALIBRATION = { hi: 0.95, lo: 0.5 } as const;

export const MIN_EMBEDDED_PAIRS = 50;

const HARMONIC_TABLE = {
  0: { diff: 0.9, same: 1.0 },
  1: { diff: 0.55, same: 0.85 },
  2: { diff: 0.35, same: 0.6 },
  3: { diff: 0.25, same: 0.25 },
  4: { diff: 0.15, same: 0.15 },
  5: { diff: 0.1, same: 0.1 },
  6: { diff: 0.05, same: 0.05 },
} as const;

function camelotDistance(a: Camelot, b: Camelot): number {
  const raw = Math.abs(a.number - b.number);

  return Math.min(raw, 12 - raw);
}

export function harmonicScore(a: Camelot | null, b: Camelot | null): number | null {
  if (!a || !b) {
    return null;
  }

  const dn = camelotDistance(a, b) as 0 | 1 | 2 | 3 | 4 | 5 | 6;
  const row = HARMONIC_TABLE[dn];

  return a.letter === b.letter ? row.same : row.diff;
}

export type KeyRelationship =
  | "same_key"
  | "relative"
  | "adjacent"
  | "energy"
  | "diagonal"
  | "distant";

export function keyRelationship(a: Camelot, b: Camelot): KeyRelationship {
  const dn = camelotDistance(a, b);
  const same = a.letter === b.letter;

  if (dn === 0) {
    return same ? "same_key" : "relative";
  }
  if (dn === 1) {
    return same ? "adjacent" : "diagonal";
  }
  if (dn === 2 && same) {
    return "energy";
  }

  return "distant";
}

export function isNamedMove(a: Camelot, b: Camelot): boolean {
  return keyRelationship(a, b) !== "distant";
}

export function namedMoveClasses(from: Camelot): Camelot[] {
  const out: Camelot[] = [];

  for (const letter of ["A", "B"] as const) {
    for (let number = 1; number <= 12; number += 1) {
      const to: Camelot = { letter, number };

      if (isNamedMove(from, to)) {
        out.push(to);
      }
    }
  }

  return out;
}

export const SET_FLOOR = 17;

export const RAIL_DEPTH = 12;

export const MIX_PUBLIC_FLOOR = SET_FLOOR + RAIL_DEPTH;

export type MixChainDepth = {
  median: number;

  open: boolean;

  rankable: number;
};

export function mixChainDepth(
  histogram: readonly { count: number; key: string | null }[],
): MixChainDepth {
  const classes = new Map<string, { camelot: Camelot; count: number }>();

  for (const { count, key } of histogram) {
    const camelot = camelotOf(key);

    if (!camelot || count <= 0) {
      continue;
    }

    const code = `${camelot.number}${camelot.letter}`;
    const existing = classes.get(code);

    if (existing) {
      existing.count += count;
    } else {
      classes.set(code, { camelot, count });
    }
  }

  const entries = [...classes.values()];
  const rankable = entries.reduce((sum, entry) => sum + entry.count, 0);

  if (rankable === 0) {
    return { median: 0, open: false, rankable: 0 };
  }

  const neighbourhoods: { count: number; size: number }[] = entries.map((entry) => {
    const reachable = entries.reduce(
      (sum, other) => (isNamedMove(entry.camelot, other.camelot) ? sum + other.count : sum),
      0,
    );

    return { count: entry.count, size: reachable - 1 };
  });

  neighbourhoods.sort((left, right) => left.size - right.size);

  const half = Math.floor(rankable / 2);
  let seen = 0;
  let median = 0;

  for (const { count, size } of neighbourhoods) {
    seen += count;
    median = size;

    if (seen > half) {
      break;
    }
  }

  return { median, open: median >= MIX_PUBLIC_FLOOR, rankable };
}

export function bpmSubScore(
  a: number | null,
  b: number | null,
): { outOfBand: boolean; score: number | null } {
  if (a == null || b == null) {
    return { outOfBand: false, score: null };
  }

  const inBand = (v: number) => v >= BPM_BAND.min && v <= BPM_BAND.max;

  if (!inBand(a) || !inBand(b)) {
    return { outOfBand: true, score: null };
  }

  const pctDelta = Math.abs(a - b) / Math.min(a, b);

  if (pctDelta <= 0.01) {
    return { outOfBand: false, score: 1 };
  }
  if (pctDelta <= 0.06) {
    return { outOfBand: false, score: 1 - (0.5 * (pctDelta - 0.01)) / 0.05 };
  }
  if (pctDelta <= 0.1) {
    return { outOfBand: false, score: 0.5 - (0.5 * (pctDelta - 0.06)) / 0.04 };
  }

  return { outOfBand: false, score: 0 };
}

export function sonicGateOpen(embeddedCount: number): boolean {
  const pairs = (embeddedCount * (embeddedCount - 1)) / 2;

  return pairs >= MIN_EMBEDDED_PAIRS;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function calibrateCosine(cos: number): number {
  return clamp01((cos - SONIC_CALIBRATION.lo) / (SONIC_CALIBRATION.hi - SONIC_CALIBRATION.lo));
}

export function sonicSubScoreFromCosine(cos: number | null, gateOpen: boolean): number | null {
  if (!gateOpen || cos === null) {
    return null;
  }

  return calibrateCosine(cos);
}

export function tasteSubScore(cos: number | null): number | null {
  return cos === null ? null : calibrateCosine(cos);
}

export function railScore(mix: number, taste: number | null): number {
  return taste === null ? mix : mix * taste;
}

export function sonicSubScore(
  a: number[] | null,
  b: number[] | null,
  gateOpen: boolean,
): number | null {
  return sonicSubScoreFromCosine(a && b ? cosineSimilarity(a, b) : null, gateOpen);
}

const FEATURE_FIELDS = [
  "centroidHz",
  "highRatio",
  "midFlatness",
  "onsetRate",
  "subBassRatio",
] as const;

export function parseFeatureVector(json: string | null | undefined): number[] | null {
  if (!json) {
    return null;
  }

  let raw: Record<string, unknown>;

  try {
    raw = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }

  let anyPresent = false;
  const vector = FEATURE_FIELDS.map((field) => {
    const value = raw[field];

    if (typeof value === "number" && Number.isFinite(value)) {
      anyPresent = true;

      return value;
    }

    return 0;
  });

  return anyPresent ? vector : null;
}

export function featureDistance(a: number[] | null, b: number[] | null): number {
  if (!a || !b) {
    return Number.POSITIVE_INFINITY;
  }

  const length = Math.min(a.length, b.length);
  let sum = 0;

  for (let index = 0; index < length; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    sum += delta * delta;
  }

  return Math.sqrt(sum);
}

export type MixTrack = {
  bpm: number | null;

  embedding: number[] | null;

  features: number[] | null;

  key: string | null;
};

export type MixReason = {
  kind: "key" | "bpm" | "sonic";
  relationship: KeyRelationship | "tempo_match" | "close_in_sound";
};

export type MixPairResult = {
  bpm: number | null;

  flagged: boolean;
  key: number | null;
  reason: MixReason | null;

  score: number | null;
  sonic: number | null;
};

export type MixOptions = { gateOpen?: boolean; sonicCos?: number | null };

function camelotOf(key: string | null): Camelot | null {
  const parsed = parseKey(key);

  return parsed ? toCamelot(parsed) : null;
}

function selectReason(
  keyScore: number | null,
  bpmScore: number | null,
  sonicScore: number | null,
  camelotA: Camelot | null,
  camelotB: Camelot | null,
): MixReason | null {
  const candidates: { kind: MixReason["kind"]; priority: number; value: number }[] = [];

  if (keyScore !== null) {
    candidates.push({ kind: "key", priority: 0, value: keyScore });
  }
  if (sonicScore !== null) {
    candidates.push({ kind: "sonic", priority: 1, value: sonicScore });
  }
  if (bpmScore !== null) {
    candidates.push({ kind: "bpm", priority: 2, value: bpmScore });
  }

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((left, right) => right.value - left.value || left.priority - right.priority);
  const winner = candidates[0];

  if (!winner) {
    return null;
  }

  if (winner.kind === "bpm") {
    return { kind: "bpm", relationship: "tempo_match" };
  }
  if (winner.kind === "sonic") {
    return { kind: "sonic", relationship: "close_in_sound" };
  }

  return {
    kind: "key",
    relationship: camelotA && camelotB ? keyRelationship(camelotA, camelotB) : "distant",
  };
}

export function scoreMix(a: MixTrack, b: MixTrack, options: MixOptions = {}): MixPairResult {
  const gateOpen = options.gateOpen ?? false;

  const camelotA = camelotOf(a.key);
  const camelotB = camelotOf(b.key);
  const keyScore = harmonicScore(camelotA, camelotB);

  const bpm = bpmSubScore(a.bpm, b.bpm);
  const bpmScore = bpm.score;

  const sonicScore =
    options.sonicCos === undefined
      ? sonicSubScore(a.embedding, b.embedding, gateOpen)
      : sonicSubScoreFromCosine(options.sonicCos, gateOpen);

  let numerator = 0;
  let denominator = 0;

  if (keyScore !== null) {
    numerator += MIX_WEIGHTS.key * keyScore;
    denominator += MIX_WEIGHTS.key;
  }
  if (bpmScore !== null) {
    numerator += MIX_WEIGHTS.bpm * bpmScore;
    denominator += MIX_WEIGHTS.bpm;
  }
  if (sonicScore !== null) {
    numerator += MIX_WEIGHTS.sonic * sonicScore;
    denominator += MIX_WEIGHTS.sonic;
  }

  const rankable = denominator >= MIX_WEIGHTS.key;
  const score = rankable && denominator > 0 ? numerator / denominator : null;

  return {
    bpm: bpmScore,
    flagged: score === null || bpm.outOfBand,
    key: keyScore,
    reason: selectReason(keyScore, bpmScore, sonicScore, camelotA, camelotB),
    score,
    sonic: sonicScore,
  };
}

export type MixCandidate<T> = { item: T; sonicCos?: number | null; track: MixTrack };

export type MixScored<T> = { item: T; reason: MixReason; score: number };

export const TASTE_SHORTLIST = RAIL_DEPTH * 25;

export function shortlistMixable<T>(
  target: MixTrack,
  candidates: MixCandidate<T>[],
  limit: number,
  options: MixOptions = {},
): MixScored<T>[] {
  if (limit <= 0) {
    return [];
  }

  const scored = candidates.flatMap((candidate, index) => {
    const result = scoreMix(
      target,
      candidate.track,
      candidate.sonicCos === undefined ? options : { ...options, sonicCos: candidate.sonicCos },
    );

    if (result.score === null || result.reason === null) {
      return [];
    }

    return [
      {
        index,
        item: candidate.item,
        reason: result.reason,
        score: result.score,
        textureDistance: featureDistance(target.features, candidate.track.features),
      },
    ];
  });

  scored.sort(
    (left, right) =>
      right.score - left.score ||
      left.textureDistance - right.textureDistance ||
      left.index - right.index,
  );

  return scored.slice(0, limit).map(({ item, reason, score }) => ({ item, reason, score }));
}

export function rankMixable<T>(
  target: MixTrack,
  candidates: MixCandidate<T>[],
  limit: number,
  options: MixOptions = {},
): { item: T; reason: MixReason }[] {
  return shortlistMixable(target, candidates, limit, options).map(({ item, reason }) => ({
    item,
    reason,
  }));
}

export function applyTaste<T>(
  shortlist: MixScored<T>[],
  tasteOf: (item: T) => number | null,
  limit: number,
): { item: T; reason: MixReason }[] {
  if (limit <= 0) {
    return [];
  }

  const rescored = shortlist.map((entry, index) => ({
    entry,
    index,
    rail: railScore(entry.score, tasteOf(entry.item)),
  }));

  rescored.sort((left, right) => right.rail - left.rail || left.index - right.index);

  return rescored.slice(0, limit).map(({ entry }) => ({ item: entry.item, reason: entry.reason }));
}

export const HELD_KARP_MAX = 16;

export const PATH_MAX = 64;

export type MixTransition = { cost: number; flagged: boolean };

export type MixOrder = {
  algorithm: "held-karp" | "greedy-2opt";
  order: number[];
  totalCost: number;
};

function buildCostMatrix(
  tracks: MixTrack[],
  options: MixOptions,
): { cost: Float64Array; flagged: boolean[] } {
  const n = tracks.length;
  const cost = new Float64Array(n * n);
  const flagged: boolean[] = Array.from({ length: n * n }, () => false);
  const present: number[] = [];

  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const trackI = tracks[i];
      const trackJ = tracks[j];
      const result =
        trackI && trackJ ? scoreMix(trackI, trackJ, options) : { flagged: true, score: null };

      if (result.score === null) {
        flagged[i * n + j] = true;
        flagged[j * n + i] = true;
        cost[i * n + j] = Number.NaN;
        cost[j * n + i] = Number.NaN;
      } else {
        const c = 1 - result.score;
        cost[i * n + j] = c;
        cost[j * n + i] = c;
        present.push(c);
      }
    }
  }

  const median = present.length > 0 ? medianOf(present) : 0.5;

  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      if (Number.isNaN(cost[i * n + j])) {
        cost[i * n + j] = median;
        cost[j * n + i] = median;
      }
    }
  }

  return { cost, flagged };
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[mid] ?? 0.5;
  }

  return ((sorted[mid - 1] ?? 0.5) + (sorted[mid] ?? 0.5)) / 2;
}

function heldKarpPath(cost: Float64Array, n: number, start: number | null): number[] {
  const size = 1 << n;
  const dp = new Float64Array(size * n).fill(Number.POSITIVE_INFINITY);
  const parent = new Int32Array(size * n).fill(-1);

  for (let j = 0; j < n; j += 1) {
    if (start === null || start === j) {
      dp[(1 << j) * n + j] = 0;
    }
  }

  for (let mask = 1; mask < size; mask += 1) {
    for (let end = 0; end < n; end += 1) {
      if ((mask & (1 << end)) === 0) {
        continue;
      }

      const base = dp[mask * n + end] ?? Number.POSITIVE_INFINITY;

      if (base === Number.POSITIVE_INFINITY) {
        continue;
      }

      for (let next = 0; next < n; next += 1) {
        if ((mask & (1 << next)) !== 0) {
          continue;
        }

        const nextMask = mask | (1 << next);
        const candidate = base + (cost[end * n + next] ?? 0);
        const slot = nextMask * n + next;

        if (candidate < (dp[slot] ?? Number.POSITIVE_INFINITY) - 1e-12) {
          dp[slot] = candidate;
          parent[slot] = end;
        }
      }
    }
  }

  const full = size - 1;
  let bestEnd = -1;
  let bestCost = Number.POSITIVE_INFINITY;

  for (let end = 0; end < n; end += 1) {
    const value = dp[full * n + end] ?? Number.POSITIVE_INFINITY;

    if (value < bestCost - 1e-12) {
      bestCost = value;
      bestEnd = end;
    }
  }

  const order: number[] = [];
  let mask = full;
  let end = bestEnd;

  while (end !== -1) {
    order.push(end);
    const prev = parent[mask * n + end];
    mask &= ~(1 << end);
    end = prev ?? -1;
  }

  return order.reverse();
}

function pathCost(order: number[], cost: Float64Array, n: number): number {
  let total = 0;

  for (let i = 0; i + 1 < order.length; i += 1) {
    const from = order[i];
    const to = order[i + 1];

    if (from !== undefined && to !== undefined) {
      total += cost[from * n + to] ?? 0;
    }
  }

  return total;
}

function greedyFrom(start: number, cost: Float64Array, n: number): number[] {
  const visited = Array.from({ length: n }, () => false);
  const order: number[] = [start];
  visited[start] = true;

  for (let step = 1; step < n; step += 1) {
    const current = order[order.length - 1] ?? start;
    let best = -1;
    let bestCost = Number.POSITIVE_INFINITY;

    for (let next = 0; next < n; next += 1) {
      if (visited[next]) {
        continue;
      }

      const c = cost[current * n + next] ?? 0;

      if (c < bestCost - 1e-12) {
        bestCost = c;
        best = next;
      }
    }

    if (best === -1) {
      break;
    }

    visited[best] = true;
    order.push(best);
  }

  return order;
}

function twoOpt(initial: number[], cost: Float64Array, n: number): number[] {
  const order = [...initial];
  const length = order.length;

  for (let pass = 0; pass < n; pass += 1) {
    let improved = false;

    for (let i = 0; i < length - 1; i += 1) {
      for (let k = i + 1; k < length; k += 1) {
        const before = pathCost(order, cost, n);
        const candidate = [
          ...order.slice(0, i),
          ...order.slice(i, k + 1).reverse(),
          ...order.slice(k + 1),
        ];

        if (pathCost(candidate, cost, n) < before - 1e-9) {
          order.splice(0, order.length, ...candidate);
          improved = true;
        }
      }
    }

    if (!improved) {
      break;
    }
  }

  return order;
}

export function orderMixPath(
  tracks: MixTrack[],
  options: MixOptions & { seedIndex?: number } = {},
): MixOrder {
  const n = tracks.length;

  if (n < 2 || n > PATH_MAX) {
    throw new RangeError(`orderMixPath: pool size ${n} outside [2, ${PATH_MAX}]`);
  }

  const seedIndex = options.seedIndex;
  const { cost } = buildCostMatrix(tracks, options);

  if (n <= HELD_KARP_MAX) {
    const order = heldKarpPath(cost, n, seedIndex ?? null);

    return { algorithm: "held-karp", order, totalCost: pathCost(order, cost, n) };
  }

  const starts = seedIndex === undefined ? Array.from({ length: n }, (_, i) => i) : [seedIndex];
  let best: number[] | null = null;
  let bestCost = Number.POSITIVE_INFINITY;

  for (const start of starts) {
    const greedy = greedyFrom(start, cost, n);
    const refined =
      seedIndex === undefined ? twoOpt(greedy, cost, n) : twoOptPinned(greedy, cost, n);
    const c = pathCost(refined, cost, n);

    if (c < bestCost - 1e-9) {
      bestCost = c;
      best = refined;
    }
  }

  return { algorithm: "greedy-2opt", order: best ?? starts, totalCost: bestCost };
}

function twoOptPinned(initial: number[], cost: Float64Array, n: number): number[] {
  const order = [...initial];
  const length = order.length;

  for (let pass = 0; pass < n; pass += 1) {
    let improved = false;

    for (let i = 1; i < length - 1; i += 1) {
      for (let k = i + 1; k < length; k += 1) {
        const before = pathCost(order, cost, n);
        const candidate = [
          ...order.slice(0, i),
          ...order.slice(i, k + 1).reverse(),
          ...order.slice(k + 1),
        ];

        if (pathCost(candidate, cost, n) < before - 1e-9) {
          order.splice(0, order.length, ...candidate);
          improved = true;
        }
      }
    }

    if (!improved) {
      break;
    }
  }

  return order;
}

export function transitionsAlong(
  order: number[],
  tracks: MixTrack[],
  options: MixOptions = {},
): MixTransition[] {
  const transitions: MixTransition[] = [];

  for (let i = 0; i + 1 < order.length; i += 1) {
    const fromIndex = order[i];
    const toIndex = order[i + 1];
    const from = fromIndex === undefined ? undefined : tracks[fromIndex];
    const to = toIndex === undefined ? undefined : tracks[toIndex];

    if (!from || !to) {
      transitions.push({ cost: 0.5, flagged: true });
      continue;
    }

    const result = scoreMix(from, to, options);
    transitions.push({
      cost: result.score === null ? 0.5 : 1 - result.score,
      flagged: result.score === null,
    });
  }

  return transitions;
}

export function toMixTrack(row: {
  bpm: number | null;
  embedding_blob: unknown;
  features_json: string | null;
  key: string | null;
}): MixTrack {
  return {
    bpm: row.bpm,
    embedding: readEmbeddingBlob(row.embedding_blob),
    features: parseFeatureVector(row.features_json),
    key: row.key,
  };
}
