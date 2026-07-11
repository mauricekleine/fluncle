// The mixability engine — one pure scoring core, three consumers (the public `/mix`
// rail, the operator's path search, the diagnostics). Sibling of `embedding.ts`:
// no I/O, deterministic, exhaustively unit-tested. It answers the question a working
// junglist pays software to answer — "what mixes out of this?" — as a well-defined
// DJ-doctrine objective (beatmatchable + harmonic-safe + sonically continuous), NOT
// an imitation of how Fluncle himself sequences (see the ground-truth note below).
//
// THE GROUND TRUTH SAID NO TO A FIT. Over the real ordered transitions of mixtape
// `019.F.1A`, the Camelot sub-score is AT CHANCE — statistically indistinguishable
// from random key pairs (and if anything slightly below), including a literal tritone
// move. Fluncle mixes liquid DnB on phrasing, intros/outros, and energy, not harmonic
// adjacency. So the weights below are VERSIONED PRODUCT CONFIG, not a fitted model,
// and validation (`scripts/mixability-diagnostics.ts` + the committed floor-check
// test) is a characterization diagnostic, never a training target. Do not re-invent
// the fit. RECORDED DIAGNOSTIC (2026-07-10, live archive; re-run to refresh):
//   Floor check — real consecutive transitions n=14 mean≈0.30–0.34; all-pairs random
//     baseline n=240 mean≈0.35–0.36 → verdict AT CHANCE (key does not predict him).
//   Within-set successor rank — mean true-next rank ≈5.2 vs ~4.75 random (no signal).
//   Coverage — 16/17 keyed, 17/17 features, 1/17 embedded (the sonic term dormant).
//
// THE SIGNAL REALITY. As of 2026-07-11 the embed cron has DRAINED: all 60 findings
// carry an `embedding_json` vector (every one is assigned to a sonic galaxy, which is
// impossible without one), so `sonicGateOpen(60)` → 1770 pairs ≥ MIN_EMBEDDED_PAIRS
// and THE SONIC TERM IS LIVE. It activated with zero code change, exactly as designed.
// The other signals: `key` ~50/60 and discriminative; `bpm` ~53/60 but near-constant in
// the folded 170–175 band (tiebreak-grade); `features_json` 60/60 (the dense texture
// tiebreak, which now backs up the sonic term inside key plateaus rather than standing
// in for it). Re-measure at build time rather than trusting this comment — an earlier
// snapshot of it (3/56 embedded, "dormant") outlived its truth by a day and misled a
// downstream RFC into planning around a dead engine.

import { type Camelot, parseKey, toCamelot } from "../key-camelot";
import { cosineSimilarity, parseEmbedding } from "./embedding";

// ── Versioned product config ─────────────────────────────────────────────────

/**
 * The combiner weights — a PRODUCT CHOICE, not a fitted model (the ground truth
 * makes a fit impossible and imitation the wrong target; see the module header).
 * `key` leads because it is the dense discriminative axis and the objective is
 * harmonic-clean mixability; `bpm` is low because the folded band makes it
 * near-constant (tiebreak-grade); `sonic` carries real weight for the day its gate
 * lifts. Bump `MIX_WEIGHTS_VERSION` on any change so a cache/version token can
 * invalidate.
 */
export const MIX_WEIGHTS = { bpm: 0.15, key: 0.5, sonic: 0.35 } as const;
export const MIX_WEIGHTS_VERSION = 1;

/**
 * The DnB tempo band the archive folds every stored BPM into at write time
 * (`foldToBand`, analyze-track.ts). The core ASSERTS this as an input contract
 * rather than re-folding: an out-of-band value yields a `null` BPM sub-score plus a
 * raised `outOfBand` flag (never a silent mis-score). Cross-band/half-time scoring is
 * out of scope by construction of the archive.
 */
export const BPM_BAND = { max: 185, min: 160 } as const;

/**
 * The affine calibration mapping a MuQ cosine into a [0,1] sonic sub-score:
 * `clamp01((cos − LO) / (HI − LO))`. ONE fixed calibration for both products (a
 * per-query min-max is NaN-prone at n=1, a coin-flip at n=2, and demotes the few
 * embedded findings under renormalization). LO/HI are the archive's global
 * pairwise-cosine 5th/95th percentile, set once by a checked-in bootstrap the day the
 * gate lifts. PROVISIONAL until then — the gate keeps the sonic term `null`, so these
 * values are inert at launch; the bootstrap overwrites them (a logged one-time step).
 */
export const SONIC_CALIBRATION = { hi: 0.95, lo: 0.5 } as const;

/**
 * The sonic-term coverage gate. Until the archive holds at least this many embedded
 * PAIRS, the sonic sub-score is `null` for every pair (a percentile of 3 embedded
 * findings = 3 pairs is garbage), and renormalization carries key + BPM. The gate
 * lifts — and the bootstrap runs, once — when the embed cron gets there; no code
 * change before then. Pairs from `E` embedded findings = `E·(E−1)/2`.
 */
export const MIN_EMBEDDED_PAIRS = 50;

// ── The Camelot harmonic sub-score ───────────────────────────────────────────

/**
 * The harmonic compatibility table, keyed by `(dn, letter-match)` — `dn` is the
 * circular distance on the number ring (0..6). Camelot is 24 genuinely discrete
 * classes, so a lookup is right and a continuous function would be false precision.
 * The ±2 (whole-tone "energy") move scores symmetrically; direction/energy is a
 * sequencing concern (the path search), not pairwise compatibility.
 */
const HARMONIC_TABLE = {
  0: { diff: 0.9, same: 1.0 }, // same key / relative major↔minor
  1: { diff: 0.55, same: 0.85 }, // adjacent (perfect fifth) / diagonal
  2: { diff: 0.35, same: 0.6 }, // energy boost/drop (whole tone) / 2-diff
  3: { diff: 0.25, same: 0.25 },
  4: { diff: 0.15, same: 0.15 },
  5: { diff: 0.1, same: 0.1 },
  6: { diff: 0.05, same: 0.05 }, // tritone
} as const;

/** Circular distance on the 12-slot Camelot number ring (0..6). */
function camelotDistance(a: Camelot, b: Camelot): number {
  const raw = Math.abs(a.number - b.number);

  return Math.min(raw, 12 - raw);
}

/**
 * The harmonic sub-score for two Camelot positions, in [0,1] (see `HARMONIC_TABLE`),
 * or `null` when either key is absent/unparseable — never 0 for missing data.
 */
export function harmonicScore(a: Camelot | null, b: Camelot | null): number | null {
  if (!a || !b) {
    return null;
  }

  const dn = camelotDistance(a, b) as 0 | 1 | 2 | 3 | 4 | 5 | 6;
  const row = HARMONIC_TABLE[dn];

  return a.letter === b.letter ? row.same : row.diff;
}

/** The `key` sub-score's harmonic relationship, for the reason chip a surface renders. */
export type KeyRelationship =
  | "same_key"
  | "relative"
  | "adjacent"
  | "energy"
  | "diagonal"
  | "distant";

/** Name the harmonic relationship between two Camelot positions (for the reason chip). */
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

// ── The BPM sub-score (band-contract percent delta) ──────────────────────────

/**
 * The BPM sub-score for two tempos, plus the band-contract flag. `outOfBand` is true
 * when a present tempo sits outside `BPM_BAND` (a data problem worth NAMING, e.g. a
 * stray half-time 87 vs 174 — the exact relationship a DJ wants surfaced, not erased
 * by a silent octave fold); such a pair scores `null`. A NULL tempo scores `null`
 * with `outOfBand` false (simply absent).
 *
 * For an in-band pair the delta is a percent against the SLOWER tempo (the beatmatch
 * window is a pitch-fader percentage, CDJ default ±6%). Piecewise-linear:
 * ≤1% → 1.00; 1–6% → 1.00→0.50; 6–10% → 0.50→0.00; >10% → 0.00.
 */
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
    // Linear 1.00 → 0.50 across the 1%–6% beatmatch window.
    return { outOfBand: false, score: 1 - (0.5 * (pctDelta - 0.01)) / 0.05 };
  }
  if (pctDelta <= 0.1) {
    // Linear 0.50 → 0.00 across 6%–10%.
    return { outOfBand: false, score: 0.5 - (0.5 * (pctDelta - 0.06)) / 0.04 };
  }

  return { outOfBand: false, score: 0 };
}

// ── The sonic sub-score (MuQ cosine, gated + fixed calibration) ──────────────

/** Whether the archive's embedded-finding count clears the sonic-term coverage gate. */
export function sonicGateOpen(embeddedCount: number): boolean {
  const pairs = (embeddedCount * (embeddedCount - 1)) / 2;

  return pairs >= MIN_EMBEDDED_PAIRS;
}

/** Clamp to [0,1]. */
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * The sonic sub-score from an ALREADY-COMPUTED cosine, in [0,1], or `null` when the
 * cosine is absent OR the coverage gate is closed. The `/mix` rail's candidate scan
 * gets its cosine from the DATABASE (`vector_distance_cos`, converted by
 * `cosineFromDistance`) rather than by pulling 21 KB of vector per candidate into the
 * isolate — the calibration below is the same either way, which is the point.
 */
export function sonicSubScoreFromCosine(cos: number | null, gateOpen: boolean): number | null {
  if (!gateOpen || cos === null) {
    return null;
  }

  return clamp01((cos - SONIC_CALIBRATION.lo) / (SONIC_CALIBRATION.hi - SONIC_CALIBRATION.lo));
}

/**
 * The sonic sub-score for two MuQ embeddings under the fixed affine calibration, in
 * [0,1], or `null` when either embedding is absent OR the coverage gate is closed
 * (`gateOpen === false`). Aesthetic continuity (liquid vs neuro at the same 8A/174) —
 * the term most likely to reflect how Fluncle actually sequences, which is why it
 * ships wired rather than cut.
 */
export function sonicSubScore(
  a: number[] | null,
  b: number[] | null,
  gateOpen: boolean,
): number | null {
  return sonicSubScoreFromCosine(a && b ? cosineSimilarity(a, b) : null, gateOpen);
}

// ── The texture tiebreak (`features_json`) ───────────────────────────────────

// The DSP spectral fields, in a fixed canonical order — the tiebreak vector. Present
// on 56/56 findings. Scale/semantics are DSP-internal and UNVALIDATED as a similarity
// metric (Decision 3 sanctions it as a tiebreak ONLY, never a weighted term, never
// surfaced in copy); determinism is the whole job here, not perceptual accuracy.
const FEATURE_FIELDS = [
  "centroidHz",
  "highRatio",
  "midFlatness",
  "onsetRate",
  "subBassRatio",
] as const;

/**
 * Parse a stored `features_json` string into the fixed-order tiebreak vector, or
 * `null` when it is absent / not JSON / carries none of the known fields. A missing
 * individual field is 0 (the vector stays fixed-width so distances are comparable).
 */
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

/** Deterministic Euclidean distance between two feature vectors (∞ when either is absent). */
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

// ── The combiner ─────────────────────────────────────────────────────────────

/** A track's mixability-relevant inputs — parsed once, then scored pure. */
export type MixTrack = {
  bpm: number | null;
  /** The parsed MuQ embedding (or null). */
  embedding: number[] | null;
  /** The parsed DSP feature vector for the tiebreak (or null). */
  features: number[] | null;
  /** The scale-text key (`"A minor"`), parsed internally. */
  key: string | null;
};

/** The reason kinds + relationships a surface renders (mirrors `MixReasonSchema`). */
export type MixReason = {
  kind: "key" | "bpm" | "sonic";
  relationship: KeyRelationship | "tempo_match" | "close_in_sound";
};

/** The full pairwise result: the combined score, each sub-score, the reason, the flag. */
export type MixPairResult = {
  bpm: number | null;
  /** True when an input was out-of-band (BPM) or the pair carried no scorable term. */
  flagged: boolean;
  key: number | null;
  reason: MixReason | null;
  /** The combined, present-term-renormalized score in [0,1], or null (all terms absent). */
  score: number | null;
  sonic: number | null;
};

/**
 * Options for a scoring pass. `gateOpen` lifts the sonic term (default closed).
 *
 * `sonicCos` is the cosine between THE TWO TRACKS BEING SCORED, already computed —
 * the `/mix` rail's candidate scan has the database compute it (`vector_distance_cos`
 * against the target, one exact scan) instead of shipping every candidate's 21 KB
 * vector into the isolate. Supplied, it is used verbatim; omitted (`undefined`), the
 * cosine comes from the two `MixTrack.embedding`s as before. It is a PER-CALL option
 * precisely so it cannot be smuggled onto a `MixTrack` and silently mis-score the
 * pairwise path search, whose N² cosines are all different pairs.
 */
export type MixOptions = { gateOpen?: boolean; sonicCos?: number | null };

function camelotOf(key: string | null): Camelot | null {
  const parsed = parseKey(key);

  return parsed ? toCamelot(parsed) : null;
}

/**
 * Pick the dominant PRESENT sub-score as a structured reason for the surfaces to
 * render. Argmax over present terms by raw value; ties break by a fixed priority
 * (key → sonic → bpm) so the harmonic/aesthetic reason is named over a bare tempo
 * match. Returns null when no term is present.
 */
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

  // key — name the harmonic relationship (both camelots are present when keyScore is).
  return {
    kind: "key",
    relationship: camelotA && camelotB ? keyRelationship(camelotA, camelotB) : "distant",
  };
}

/**
 * Score how cleanly track `b` mixes out of track `a`. Symmetric in the pairwise sub-
 * scores (direction is a sequencing concern, handled by the path search). Present-term
 * renormalization: a finding scored on what it HAS, at full scale
 * (`Σ wᵢ·scoreᵢ / Σ wᵢ·[present]`); all-null ⇒ `score: null`, `flagged: true`.
 */
export function scoreMix(a: MixTrack, b: MixTrack, options: MixOptions = {}): MixPairResult {
  const gateOpen = options.gateOpen ?? false;

  const camelotA = camelotOf(a.key);
  const camelotB = camelotOf(b.key);
  const keyScore = harmonicScore(camelotA, camelotB);

  const bpm = bpmSubScore(a.bpm, b.bpm);
  const bpmScore = bpm.score;

  // The cosine either came from the database (the `/mix` candidate scan) or is computed
  // here from the two vectors — same number, same calibration, same score.
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

  // PRESENT-TERM RENORMALIZATION NEEDS A FLOOR. Renormalizing over only the terms a
  // pair HAS means a data-poor row wins: with no key and no BPM, a strong embedding
  // renormalizes over its own 0.35 weight alone and scores a perfect 1.00 — beating a
  // fully-measured, genuinely good match at ~0.82. So the KEY IS MANDATORY to be
  // rankable: harmonic compatibility is this tool's whole premise, and a pair whose key
  // we do not know is a pair we cannot justify. Without it the score is null, and
  // `rankMixable` drops the row rather than floating it to the top of the rail.
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

// ── Ranking (Product A) ──────────────────────────────────────────────────────

/**
 * A ranking candidate: an opaque item paired with its mixability inputs, and
 * optionally the cosine to the TARGET already computed by the database (see
 * `MixOptions.sonicCos`). When `sonicCos` is set, `track.embedding` is not needed —
 * which is exactly how the `/mix` rail avoids loading the corpus's vectors.
 */
export type MixCandidate<T> = { item: T; sonicCos?: number | null; track: MixTrack };

/**
 * Rank `candidates` by descending mixability to `target`, breaking equal-score
 * plateaus by ASCENDING feature-vector distance (the texture tiebreak), then by index
 * (stable). Candidates whose combined score is `null` (no scorable term) are dropped —
 * the rail never shows a pair it cannot justify. Returns the top `limit` items with
 * each item's reason chip. A non-positive `limit` returns nothing.
 */
export function rankMixable<T>(
  target: MixTrack,
  candidates: MixCandidate<T>[],
  limit: number,
  options: MixOptions = {},
): { item: T; reason: MixReason }[] {
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

  return scored.slice(0, limit).map(({ item, reason }) => ({ item, reason }));
}

// ── Path search (Product B) ──────────────────────────────────────────────────

/** The largest pool the exact Held-Karp DP is used for; above it, greedy + 2-opt. */
export const HELD_KARP_MAX = 16;
/** The hard cap on a path-search request (the input schema enforces `.min(2).max(64)`). */
export const PATH_MAX = 64;

/** One ordered transition in a proposed path: from index → to index, its cost + flag. */
export type MixTransition = { cost: number; flagged: boolean };

/** A proposed order over the input tracks: the index order, the total cost, the algorithm. */
export type MixOrder = {
  algorithm: "held-karp" | "greedy-2opt";
  order: number[];
  totalCost: number;
};

/** Build the symmetric N×N cost matrix (`1 − mixability`), null pairs at the neutral median. */
function buildCostMatrix(
  tracks: MixTrack[],
  options: MixOptions,
): { cost: Float64Array; flagged: boolean[] } {
  const n = tracks.length;
  const cost = new Float64Array(n * n);
  const flagged: boolean[] = Array.from({ length: n * n }, () => false);
  const present: number[] = [];

  // First pass: real costs where the pair is scorable; mark null pairs for the median.
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

  // Neutral median for null pairs — max-cost would exile data-poor findings to the
  // path ends, a data-availability artifact masquerading as musical judgment. Median
  // of the present costs (0.5 when nothing is scorable at all).
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

/**
 * Held-Karp exact shortest open Hamiltonian path over `n ≤ HELD_KARP_MAX` nodes, from
 * the precomputed `cost` matrix. Flat typed arrays indexed by an integer bitmask — the
 * mandated implementation (a string-keyed Map blows the Worker budget). `start`:
 * pin the first vertex (seed), or `null` for free-both-endpoints (every singleton is a
 * base case — equivalent to the zero-edge dummy-node collapsed to N nodes). Both take
 * the min over all end states. Fully deterministic (ties by cost then index).
 */
function heldKarpPath(cost: Float64Array, n: number, start: number | null): number[] {
  const size = 1 << n;
  const dp = new Float64Array(size * n).fill(Number.POSITIVE_INFINITY);
  const parent = new Int32Array(size * n).fill(-1);

  // Base cases: the pinned singleton, or every singleton when both ends are free.
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

  // Best end state over the full set (ties by lowest end index for determinism).
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

  // Reconstruct backwards from the best end.
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

/** Total cost of an open path (sum of adjacent edges). */
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

/**
 * Greedy nearest-neighbor from `start` (ties by lowest index), returning the visiting
 * order. Deterministic.
 */
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

/** 2-opt local search on an open path, capped at `n` passes. Deterministic; keeps improvements only. */
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

/**
 * Order a candidate pool into a smoothness-optimized chain (minimizing total adjacent
 * roughness `Σ 1 − mixability`). NOT an energy-shaped set (open → build → peak →
 * comedown) — a symmetric cost cannot express that; the admin copy says so, and the
 * asymmetric energy-arc term is the recorded extension. Exact Held-Karp for
 * `n ≤ HELD_KARP_MAX`, multi-start greedy + 2-opt above. `seedIndex` pins the first
 * vertex. Fully deterministic. Requires `2 ≤ n ≤ PATH_MAX`.
 */
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

  // Multi-start greedy + 2-opt. Every start (index order) when free; only the seed
  // when pinned. Keep the lowest-cost result (ties by the earliest start).
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

/** 2-opt that never moves index 0 (the pinned seed stays first). Deterministic. */
function twoOptPinned(initial: number[], cost: Float64Array, n: number): number[] {
  const order = [...initial];
  const length = order.length;

  for (let pass = 0; pass < n; pass += 1) {
    let improved = false;

    // i starts at 1: never reverse across position 0, so the seed stays pinned.
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

/** The per-transition costs + flags along a proposed order (for the admin output rows). */
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

/** Parse a stored embedding for a `MixTrack` (thin re-export of the embedding parser). */
export function toMixTrack(row: {
  bpm: number | null;
  embedding_json: string | null;
  features_json: string | null;
  key: string | null;
}): MixTrack {
  return {
    bpm: row.bpm,
    embedding: parseEmbedding(row.embedding_json),
    features: parseFeatureVector(row.features_json),
    key: row.key,
  };
}
