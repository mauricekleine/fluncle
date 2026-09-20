// The shared machinery behind a due-work family's DEFINITION version.
//
// `source_version` hashes SOURCE COLUMN VALUES, so it answers "did this row's inputs change?" and
// nothing else. Changing an order component or an eligibility constant changes neither a source
// value nor a checkpoint generation, so projected rows keep the previous definition's `sort_key`
// until something repairs them. A stored definition version closes that gap: a rebuild checkpoint
// whose stored version differs from the running code's is not complete, and the next ordinary
// rebuild step restarts its generation.
//
// The version is DERIVED, never hand-bumped. It is a behavioural fingerprint: a family's own pure
// decision function is run over a fixed matrix of probe sources at a frozen instant, and the
// transcript of its answers is hashed. Touch an order component, a predicate, or a constant and
// some probe answer moves, so the version moves. A comment, a rename, or an unrelated edit leaves
// every answer identical, so the version holds.

import { createHash } from "node:crypto";

/** The frozen probe instant and its two neighbours. Fixture data, never a clock read. */
export const PROBE_NOW = "2026-01-02T03:04:05.000Z";
export const PROBE_BEFORE = "2025-11-02T03:04:05.000Z";
export const PROBE_AFTER = "2026-02-02T03:04:05.000Z";

/**
 * The shape-independent half of the ladder: nulls, empties, both boolean faces, three ordered
 * instants, and the status words the evaluators branch on.
 *
 * A constant an evaluator ADDS to a timestamp (every cooldown and re-ask window) needs no ladder
 * value at all — it lands in the computed `nextDueAt` and therefore in the transcript, provided a
 * BASE reaches that branch with the companion stamp set. A constant an evaluator COMPARES against
 * is the opposite: it is invisible unless the ladder straddles it, which is what
 * `probeLadderCrossing` derives.
 */
export const PROBE_LADDER_BASE: readonly unknown[] = [
  null,
  "",
  "probe",
  0,
  1,
  PROBE_BEFORE,
  PROBE_AFTER,
  true,
  false,
  "pending",
  "failed",
  "processing",
  "complete",
  "empty",
  "duplicate-cleared",
  "wrong-audio",
  "full",
  "disabled",
];

/**
 * The ladder a TIMESTAMP column gets, and the reason the matrix types its columns at all.
 *
 * `Date.parse` of anything that is not an ISO-8601 string falls back to an implementation-defined
 * parse that reads the result in the HOST'S LOCAL TIME: a bare `899999` in an `*_at` column becomes
 * a year, and the `next_due_at` it produces then differs by the machine's UTC offset. That would
 * make the fingerprint a function of the host clock's timezone rather than of the code — the
 * version would flap between a developer's machine and the UTC Worker and re-project forever.
 *
 * So a timestamp column is probed only with values whose parse is specified: `null`, the two
 * strings that are unambiguously not dates (both yield NaN, which every evaluator documents as the
 * self-healing arm), and the three fixed ISO instants. Every other column keeps the full ladder,
 * which is where the numeric thresholds need to be crossed anyway.
 */
export const PROBE_LADDER_TIMESTAMP: readonly unknown[] = [
  null,
  "",
  "probe",
  PROBE_BEFORE,
  PROBE_NOW,
  PROBE_AFTER,
];

/** A column the evaluators feed to `Date.parse`, by the naming both source shapes already use. */
export function isTimestampProbeColumn(column: string): boolean {
  return /(?:_at|At)$/.test(column);
}

/**
 * The ladder, DERIVED from the thresholds the caller's evaluators compare against: each one
 * contributes its own value plus both neighbours, so a retune of any size — including by one —
 * moves a probe answer and therefore the version. Deriving it is the point: a hand-listed ladder
 * silently stops straddling a constant the moment someone retunes it, which is the same
 * hand-maintenance trap the definition version exists to remove.
 */
export function probeLadderCrossing(thresholds: readonly number[]): readonly unknown[] {
  const crossings = new Set<number>();
  for (const threshold of thresholds) {
    if (!Number.isFinite(threshold)) {
      throw new Error("a probe threshold must be a finite number");
    }
    crossings.add(threshold - 1);
    crossings.add(threshold);
    crossings.add(threshold + 1);
  }
  return [...PROBE_LADDER_BASE, ...[...crossings].sort((left, right) => left - right)];
}

/**
 * The probe matrix: every base, then each base with one column replaced by each ladder value.
 *
 * ONE COLUMN MOVES AT A TIME, which is the matrix's blind spot and the reason the base set carries
 * weight: a branch that needs two columns together (a `failed` capture AND a non-null attempt
 * timestamp; a vendor cooldown that only runs once its `*_attempted_at` is set) is unreachable
 * unless some BASE already carries the companion column. Adding a branch that depends on a
 * companion column means adding a base that satisfies it, not only a ladder value.
 */
export function probeMatrix<Base extends Record<string, unknown>>(
  bases: readonly Base[],
  columns: readonly string[],
  ladder: readonly unknown[],
): Base[] {
  const probes: Base[] = [...bases];
  for (const base of bases) {
    for (const column of columns) {
      for (const value of isTimestampProbeColumn(column) ? PROBE_LADDER_TIMESTAMP : ladder) {
        probes.push({ ...base, [column]: value });
      }
    }
  }
  return probes;
}

/**
 * A matrix is shared by every family that probes the same source shape, so build it once. The
 * caller's key names that shape; the matrix is pure, so the memo is safe for the isolate.
 */
export function memoizedProbeMatrix<Base extends Record<string, unknown>>(
  cache: Map<string, unknown>,
  key: string,
  build: () => Base[],
): Base[] {
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached as Base[];
  }
  const built = build();
  cache.set(key, built);
  return built;
}

/** An evaluator may reject a probe's deliberately ill-typed value; the refusal is the answer. */
export function probeAnswer(answer: () => string): string {
  try {
    return answer();
  } catch {
    return "!";
  }
}

export function definitionFingerprint(namespace: string, transcript: readonly string[]): string {
  const digest = createHash("sha256")
    .update(`${namespace}${transcript.join("")}`)
    .digest("hex");
  return `dv1-${digest.slice(0, 16)}`;
}

/** A per-isolate memo: a definition version is a pure function of the module graph. */
export function memoizedDefinitionVersion(
  cache: Map<string, string>,
  key: string,
  compute: () => string,
): string {
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const value = compute();
  cache.set(key, value);
  return value;
}
