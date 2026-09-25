import { describe, expect, test } from "bun:test";

import { decide, summarize, type TriageLabel } from "./label-triage-sweep";

const NOW = Date.parse("2026-09-25T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function label(slug: string, checkedDaysAgo?: number, verdict = "unclear"): TriageLabel {
  return {
    name: slug,
    seedState: "undecided",
    slug,
    triageCheckedAt:
      checkedDaysAgo === undefined ? null : new Date(NOW - checkedDaysAgo * DAY).toISOString(),
    triageVerdict: checkedDaysAgo === undefined ? null : verdict,
  };
}

function neverLooked(count: number): TriageLabel[] {
  return Array.from({ length: count }, (_, index) => label(`new-${index}`));
}

describe("the gate decision", () => {
  test("holds below the threshold", () => {
    const verdict = decide(neverLooked(39), { now: NOW, threshold: 40 });

    expect(verdict.fire).toBe(false);
    expect(verdict.neverLooked).toBe(39);
    expect(verdict.reason).toContain("below the threshold");
  });

  test("fires at exactly the threshold", () => {
    expect(decide(neverLooked(40), { now: NOW, threshold: 40 }).fire).toBe(true);
  });

  test("counts ONLY never-looked labels toward the threshold", () => {
    const pile = [
      ...neverLooked(5),
      ...Array.from({ length: 100 }, (_, i) => label(`old-${i}`, 1)),
    ];
    const verdict = decide(pile, { now: NOW, threshold: 40 });

    expect(verdict.undecided).toBe(105);
    expect(verdict.fire).toBe(false);
  });

  test("a pile of only recently-looked labels never fires by itself", () => {
    const verdict = decide(
      Array.from({ length: 500 }, (_, i) => label(`stuck-${i}`, 2)),
      { now: NOW, threshold: 40 },
    );

    expect(verdict.fire).toBe(false);
    expect(verdict.candidates).toEqual([]);
  });

  test("a label past the staleness window rides along once a round fires", () => {
    const pile = [...neverLooked(40), label("stale", 31), label("fresh", 2)];
    const verdict = decide(pile, { now: NOW, staleDays: 30, threshold: 40 });

    expect(verdict.fire).toBe(true);
    expect(verdict.stale).toBe(1);
    expect(verdict.candidates.map((row) => row.slug)).toContain("stale");
    expect(verdict.candidates.map((row) => row.slug)).not.toContain("fresh");
  });

  test("the staleness boundary is inclusive, so a label cannot sit one hour short forever", () => {
    const pile = [label("exactly", 30)];

    expect(decide(pile, { now: NOW, staleDays: 30, threshold: 1 }).stale).toBe(1);
    expect(decide(pile, { now: NOW, staleDays: 31, threshold: 1 }).stale).toBe(0);
  });

  test("orders candidates never-looked first, then stalest", () => {
    const pile = [label("recent", 40), label("ancient", 200), label("fresh-eyes")];
    const verdict = decide(pile, { now: NOW, staleDays: 30, threshold: 1 });

    expect(verdict.candidates.map((row) => row.slug)).toEqual(["fresh-eyes", "ancient", "recent"]);
  });

  test("treats an unparseable cursor as never-looked rather than skipping the label", () => {
    const pile: TriageLabel[] = [{ ...label("broken"), triageCheckedAt: "not-a-date" }];
    const verdict = decide(pile, { now: NOW, threshold: 1 });

    expect(verdict.candidates.map((row) => row.slug)).toEqual(["broken"]);
  });

  test("an empty pile holds and names no candidates", () => {
    const verdict = decide([], { now: NOW, threshold: 40 });

    expect(verdict.fire).toBe(false);
    expect(verdict.undecided).toBe(0);
    expect(verdict.candidates).toEqual([]);
  });
});

describe("the run summary", () => {
  test("leads with the verdict and carries every count the operator reads", () => {
    const line = summarize(decide([...neverLooked(41), label("stale", 40)], { now: NOW }));

    expect(line).toStartWith("LABEL TRIAGE GATE: FIRE");
    expect(line).toContain("undecided=42");
    expect(line).toContain("never-looked=41");
    expect(line).toContain("stale=1");
    expect(line).toContain("candidates=42");
  });

  test("says HOLD when it held, so a quiet run is not mistaken for a broken one", () => {
    expect(summarize(decide(neverLooked(1), { now: NOW }))).toStartWith("LABEL TRIAGE GATE: HOLD");
  });
});
