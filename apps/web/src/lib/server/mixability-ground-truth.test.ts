import { describe, expect, it } from "vitest";
import groundTruth from "./__fixtures__/mixability-ground-truth.json";
import { parseKey, toCamelot } from "../key-camelot";
import { harmonicScore } from "./mixability";

type Row = { bpm: number | null; i: number; key: string | null; logId: string };
const rows = groundTruth as Row[];

function camelotOf(key: string | null) {
  const parsed = parseKey(key);

  return parsed ? toCamelot(parsed) : null;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

const realTransitionScores = rows.flatMap((row, index) => {
  const next = rows[index + 1];

  if (!next) {
    return [];
  }

  const score = harmonicScore(camelotOf(row.key), camelotOf(next.key));

  return score === null ? [] : [score];
});

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

    expect(
      realMean,
      `real-transition mean ${realMean.toFixed(4)} should be at/below the random baseline ${baselineMean.toFixed(4)} — Fluncle does not sequence harmonically`,
    ).toBeLessThanOrEqual(baselineMean + 0.05);
  });
});
