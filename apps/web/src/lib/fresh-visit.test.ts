// "New since your last visit", as pure logic: what the stored record parses to, and one page view's
// transition from the stored record to what the page shows and what it stores next.

import { describe, expect, it } from "vitest";
import {
  FRESH_VISIT_SITTING_MS,
  type FreshVisitRecord,
  nextFreshVisit,
  parseFreshVisit,
} from "./fresh-visit";

const T0 = Date.parse("2026-09-25T12:00:00.000Z");
const MINUTE = 60 * 1000;

function newKeys(state: ReturnType<typeof nextFreshVisit>["state"]): string[] {
  return state.kind === "returning" ? [...state.newKeys].sort() : [];
}

describe("nextFreshVisit", () => {
  it("shows nothing on a first visit, and stores the releases on the page", () => {
    const next = nextFreshVisit(undefined, ["album:a", "track:b"], T0);

    expect(next.state).toEqual({ kind: "first" });
    expect(next.record).toEqual({ at: T0, first: true, seen: ["album:a", "track:b"] });
  });

  it("marks the keys a returning listener has not been shown", () => {
    const stored: FreshVisitRecord = { at: T0, seen: ["album:a"] };
    const next = nextFreshVisit(stored, ["album:a", "track:b"], T0 + 2 * 60 * MINUTE);

    expect(newKeys(next.state)).toEqual(["track:b"]);
    expect(next.record).toEqual({
      at: T0 + 2 * 60 * MINUTE,
      baseline: ["album:a"],
      seen: ["album:a", "track:b"],
    });
  });

  it("keeps the baseline through one sitting, so the markers survive a reload", () => {
    const stored: FreshVisitRecord = {
      at: T0,
      baseline: ["album:a"],
      seen: ["album:a", "track:b"],
    };
    const next = nextFreshVisit(stored, ["album:a", "track:b", "track:c"], T0 + 10 * MINUTE);

    expect(newKeys(next.state)).toEqual(["track:b", "track:c"]);
    expect(next.record.baseline).toEqual(["album:a"]);
    expect(next.record.seen).toEqual(["album:a", "track:b", "track:c"]);
  });

  it("keeps a first visit a first visit for its whole sitting", () => {
    const first = nextFreshVisit(undefined, ["album:a", "track:b"], T0);
    const reload = nextFreshVisit(first.record, ["album:a", "track:b", "track:c"], T0 + MINUTE);

    expect(reload.state).toEqual({ kind: "first" });
    expect(reload.record).toEqual({
      at: T0 + MINUTE,
      first: true,
      seen: ["album:a", "track:b", "track:c"],
    });
  });

  it("compares a first visit's next sitting against what that visit was shown", () => {
    const first = nextFreshVisit(undefined, ["album:a", "track:b"], T0);
    const later = nextFreshVisit(
      first.record,
      ["album:a", "track:b", "track:c"],
      T0 + FRESH_VISIT_SITTING_MS,
    );

    expect(newKeys(later.state)).toEqual(["track:c"]);
    expect(later.record.first).toBeUndefined();
    expect(later.record.baseline).toEqual(["album:a", "track:b"]);
  });

  it("takes the last sitting's keys as the baseline once the sitting has passed", () => {
    const stored: FreshVisitRecord = {
      at: T0,
      baseline: ["album:a"],
      seen: ["album:a", "track:b"],
    };
    const next = nextFreshVisit(
      stored,
      ["album:a", "track:b", "track:c"],
      T0 + FRESH_VISIT_SITTING_MS,
    );

    expect(newKeys(next.state)).toEqual(["track:c"]);
    expect(next.record.baseline).toEqual(["album:a", "track:b"]);
  });

  it("stores at most the key ceiling", () => {
    const keys = Array.from({ length: 2500 }, (_, index) => `track:${index}`);

    expect(nextFreshVisit(undefined, keys, T0).record.seen).toHaveLength(2000);
    const returning = nextFreshVisit({ at: T0, seen: keys }, keys, T0 + 60 * MINUTE);
    expect(returning.record.seen).toHaveLength(2000);
    expect(returning.record.baseline).toHaveLength(2000);
  });
});

describe("parseFreshVisit", () => {
  it("reads a well-formed record", () => {
    expect(parseFreshVisit(JSON.stringify({ at: T0, baseline: ["a"], seen: ["a", "b"] }))).toEqual({
      at: T0,
      baseline: ["a"],
      seen: ["a", "b"],
    });
    expect(parseFreshVisit(JSON.stringify({ at: T0, first: true, seen: ["a"] }))).toEqual({
      at: T0,
      baseline: undefined,
      first: true,
      seen: ["a"],
    });
  });

  it("reads the first-visit flag only when it is literally true", () => {
    for (const first of [false, "true", 1]) {
      expect(
        parseFreshVisit(JSON.stringify({ at: T0, first, seen: ["a"] }))?.first,
      ).toBeUndefined();
    }
  });

  it("reads anything malformed as no record at all", () => {
    for (const raw of [
      null,
      "",
      "not json",
      "null",
      "42",
      '"text"',
      JSON.stringify({ seen: ["a"] }),
      JSON.stringify({ at: "yesterday", seen: ["a"] }),
      JSON.stringify({ at: T0 }),
      JSON.stringify({ at: T0, seen: "a" }),
      JSON.stringify({ at: T0, seen: ["a", 7] }),
    ]) {
      expect(parseFreshVisit(raw)).toBeUndefined();
    }
  });

  it("drops a malformed baseline and keeps the rest", () => {
    expect(parseFreshVisit(JSON.stringify({ at: T0, baseline: [1], seen: ["a"] }))).toEqual({
      at: T0,
      baseline: undefined,
      first: undefined,
      seen: ["a"],
    });
  });

  it("caps a stored key list at the ceiling", () => {
    const seen = Array.from({ length: 2500 }, (_, index) => `track:${index}`);

    expect(parseFreshVisit(JSON.stringify({ at: T0, seen }))?.seen).toHaveLength(2000);
  });
});

describe("a stored time from the future", () => {
  it("is never the same sitting: it holds neither a first visit nor a baseline", () => {
    const now = Date.parse("2026-09-25T12:00:00Z");
    const future = now + 60 * 60 * 1000;

    const first = nextFreshVisit({ at: future, first: true, seen: ["a"] }, ["a", "b"], now);

    expect(first.state).toEqual({ kind: "returning", newKeys: new Set(["b"]) });
    expect(first.record.at).toBe(now);

    const baseline = nextFreshVisit(
      { at: future, baseline: ["a", "b", "c"], seen: ["a"] },
      ["a", "b", "c"],
      now,
    );

    // The last sitting's own keys are the baseline, not the one the future record carried.
    expect(baseline.state).toEqual({ kind: "returning", newKeys: new Set(["b", "c"]) });
  });
});
