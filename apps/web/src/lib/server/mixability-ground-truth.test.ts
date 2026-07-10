import { describe, expect, it } from "vitest";
import groundTruth from "./__fixtures__/mixability-ground-truth.json";
import { parseKey, toCamelot } from "../key-camelot";
import { harmonicScore } from "./mixability";

// THE FLOOR CHECK — a regression pin on the engine's honest characterization, run
// PURE (no DB) off the committed ground-truth extract so it lives inside
// `deploy:gate`. The verdict is already known and is NOT a suspense gate: over
// Fluncle's real ordered set `019.F.1A`, the Camelot sub-score of his actual
// transitions is AT CHANCE — statistically indistinguishable from random key pairs,
// and if anything slightly below. Fluncle mixes on phrasing, intros/outros, and
// energy, not harmonic adjacency. So the engine does NOT imitate him: it computes the
// well-defined clean-mixability objective, the weights are versioned product config
// (never a fit), and this test exists so no future session re-invents the rejected
// weight-fit against these sets.
//
// MEASURED at build time (2026-07-10, off the live public archive — re-run
// `scripts/generate-mixability-ground-truth.ts` to refresh): 16/17 keyed, 14 scorable
// consecutive transitions, real-transition mean 0.30 vs the all-pairs random baseline
// 0.36. (The RFC snapshot had 14/17 keyed / mean 0.36; the archive has since enriched,
// and the verdict — key at chance — holds.)

type Row = { bpm: number | null; i: number; key: string | null; logId: string };
const rows = groundTruth as Row[];

function camelotOf(key: string | null) {
  const parsed = parseKey(key);

  return parsed ? toCamelot(parsed) : null;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// The real, ordered transitions (consecutive pairs) that carry a key on both sides.
const realTransitionScores = rows.flatMap((row, index) => {
  const next = rows[index + 1];

  if (!next) {
    return [];
  }

  const score = harmonicScore(camelotOf(row.key), camelotOf(next.key));

  return score === null ? [] : [score];
});

// The random baseline: the mean Camelot score over ALL ordered keyed pairs — the
// analytic expected value of a random pair (deterministic, no RNG, so CI-stable).
const baselineScores = rows.flatMap((left, i) =>
  rows.flatMap((right, j) => {
    if (i === j) {
      return [];
    }

    const score = harmonicScore(camelotOf(left.key), camelotOf(right.key));

    return score === null ? [] : [score];
  }),
);

describe("mixability floor check (the ground truth said key is at chance)", () => {
  it("keeps the committed extract at the fixture's 17-track set order", () => {
    expect(rows).toHaveLength(17);
    expect(rows.map((row) => row.i ?? null)).toEqual(Array.from({ length: 17 }, (_, i) => i));
  });

  it("scores enough real transitions + a baseline to characterize", () => {
    expect(realTransitionScores.length).toBeGreaterThanOrEqual(10);
    expect(baselineScores.length).toBeGreaterThan(0);
  });

  it("finds Fluncle's real transitions AT CHANCE on the harmonic axis (not above baseline)", () => {
    const realMean = mean(realTransitionScores);
    const baselineMean = mean(baselineScores);

    // The pin: the real transitions do NOT beat random key pairs by any meaningful
    // margin. If a future change made them suddenly discriminative, that is a
    // surprise worth failing on — the engine's premise (clean mixability, NOT
    // imitation) rests on this verdict.
    expect(
      realMean,
      `real-transition mean ${realMean.toFixed(4)} should be at/below the random baseline ${baselineMean.toFixed(4)} — Fluncle does not sequence harmonically`,
    ).toBeLessThanOrEqual(baselineMean + 0.05);
  });
});
