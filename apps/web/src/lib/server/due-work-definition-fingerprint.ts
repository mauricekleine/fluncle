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
 * One ladder of values applied to EVERY probed column regardless of its declared type. Crossing a
 * threshold constant, a null test, or a status literal is what makes a predicate change visible, so
 * the ladder deliberately spans nulls, empties, both boolean faces, the failure-cap neighbourhood,
 * three ordered instants, and the status words the evaluators branch on.
 */
export const PROBE_LADDER: readonly unknown[] = [
  null,
  "",
  "probe",
  0,
  1,
  8,
  PROBE_BEFORE,
  PROBE_AFTER,
  true,
  false,
  "pending",
  "failed",
  "complete",
  "wrong-audio",
  "full",
  "disabled",
];

/** The probe matrix: every base, then each base with one column replaced by each ladder value. */
export function probeMatrix<Base extends Record<string, unknown>>(
  bases: readonly Base[],
  columns: readonly string[],
): Base[] {
  const probes: Base[] = [...bases];
  for (const base of bases) {
    for (const column of columns) {
      for (const value of PROBE_LADDER) {
        probes.push({ ...base, [column]: value });
      }
    }
  }
  return probes;
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
