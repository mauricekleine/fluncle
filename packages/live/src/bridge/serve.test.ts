// The plan-arg contract: `run show` passes `--plan <id>`, but the bridge can also be
// driven with a bare positional id or `FLUNCLE_PLAN_MIXTAPE`. parsePlanArg is the one
// place that reconciles all three — regressing it is how a requested plan silently
// became the literal "--plan" (and fell to the fixture). Pure, so it tests directly.

import { describe, expect, test } from "bun:test";

import { type PlanEntry } from "../contract";
import { type AdminAuth } from "./plan";
import { parsePlanArg, selectVjIndex, shouldFingerprintFullSong } from "./serve";
import { type ShuffleBag, type VjTransition } from "./vj";

describe("parsePlanArg", () => {
  test("flag form — `--plan <id>` (the shape run show passes)", () => {
    expect(parsePlanArg(["--plan", "019.F.1A"])).toBe("019.F.1A");
  });

  test("positional form — a bare id", () => {
    expect(parsePlanArg(["019.F.1A"])).toBe("019.F.1A");
  });

  test("env form — nothing on the argv falls back to FLUNCLE_PLAN_MIXTAPE", () => {
    expect(parsePlanArg([], "019.F.1A")).toBe("019.F.1A");
  });

  test("absent — no argv, no env → undefined (buildPlan then serves the fixture floor)", () => {
    expect(parsePlanArg([], undefined)).toBeUndefined();
  });

  test("the flag wins over the env fallback", () => {
    expect(parsePlanArg(["--plan", "020.F.2B"], "019.F.1A")).toBe("020.F.2B");
  });

  test("a dangling `--plan` with no value falls through to the env, not the literal flag", () => {
    expect(parsePlanArg(["--plan"], "019.F.1A")).toBe("019.F.1A");
  });

  test("an unrelated flag is skipped; a later positional id still resolves", () => {
    expect(parsePlanArg(["--one-mac", "019.F.1A"])).toBe("019.F.1A");
  });

  test("the RANDOM-VJ sentinel resolves through both forms (`--plan all` / bare `all`)", () => {
    expect(parsePlanArg(["--plan", "all"])).toBe("all");
    expect(parsePlanArg(["all"])).toBe("all");
  });
});

describe("shouldFingerprintFullSong", () => {
  // The Tier-A swap is gated: full song ONLY when a token AND the flag are both present.
  // This keeps merging Tier-A a live-path no-op until the operator flips the flag after
  // the M5 accuracy re-tune — a token alone (which the M5 always has) must NOT flip it.
  const auth: AdminAuth = { base: "https://www.fluncle.com", token: "t" };

  test("token + flag on → full song", () => {
    expect(shouldFingerprintFullSong(auth, "1")).toBe(true);
    expect(shouldFingerprintFullSong(auth, "true")).toBe(true);
    expect(shouldFingerprintFullSong(auth, "TRUE")).toBe(true); // case-insensitive
  });

  test("token + no flag → preview (the default, the merge no-op)", () => {
    expect(shouldFingerprintFullSong(auth, undefined)).toBe(false);
    expect(shouldFingerprintFullSong(auth, "")).toBe(false);
    expect(shouldFingerprintFullSong(auth, "0")).toBe(false);
    expect(shouldFingerprintFullSong(auth, "yes")).toBe(false); // only 1/true count as on
  });

  test("no token + flag on → preview (no credential to authorize the private fetch)", () => {
    expect(shouldFingerprintFullSong(null, "1")).toBe(false);
    expect(shouldFingerprintFullSong(null, "true")).toBe(false);
  });

  test("neither → preview", () => {
    expect(shouldFingerprintFullSong(null, undefined)).toBe(false);
  });
});

describe("selectVjIndex (the closed-loop match-vs-fallback decision)", () => {
  // A tiny fake plan (structurally Finding[]) — the two live ground-truth findings plus a
  // decoy, with the ARCHIVE-side bpm/key (which read ~1.5 low vs Rekordbox — the resolver's
  // guards cope). PlanEntry carries bpm/key, so it's a Finding.
  const plan: PlanEntry[] = [
    { artists: ["Some One"], bpm: 140, key: "A minor", logId: "000.1.0A", title: "A Decoy" },
    { artists: ["Technimatic"], bpm: 172.56, key: "G major", logId: "019.1.7X", title: "Strength" },
    {
      artists: ["Netsky"],
      bpm: 171.09,
      key: "C minor",
      logId: "011.1.6E",
      title: "I See The Future In Your Eyes",
    },
  ];

  /** A fake bag that records `next`/`take` so the decision is observed without randomness. */
  function fakeBag(nextValue: number): {
    bag: ShuffleBag;
    calls: { next: number; taken: number[] };
  } {
    const calls = { next: 0, taken: [] as number[] };
    const bag: ShuffleBag = {
      next: () => {
        calls.next++;
        return nextValue;
      },
      size: plan.length,
      take: (i: number) => {
        calls.taken.push(i);
        return true;
      },
    };
    return { bag, calls };
  }

  test("identity that resolves → its plan index, via MATCH, and the index is taken from the bag", () => {
    const { bag, calls } = fakeBag(0);
    const msg: VjTransition = {
      deck: 1,
      identity: { artist: "Technimatic", bpm: 174, key: "6A", title: "Strength (Original Mix)" },
    };
    const sel = selectVjIndex(msg, plan, bag);
    expect(sel).toEqual({
      index: 1,
      logId: "019.1.7X",
      reason: expect.any(String),
      score: expect.any(Number),
      via: "match",
    });
    expect(calls.taken).toEqual([1]); // matched index removed from the cycle
    expect(calls.next).toBe(0); // no random draw on a match
  });

  test("the deck-2 ground truth resolves to 011.1.6E (truncated OCR title + Camelot key)", () => {
    const { bag } = fakeBag(0);
    const msg: VjTransition = {
      deck: 2,
      identity: { artist: "Netsky", bpm: 173, key: "5A", title: "I See The Future" },
    };
    const sel = selectVjIndex(msg, plan, bag);
    expect(sel.via).toBe("match");
    if (sel.via === "match") {
      expect(sel.logId).toBe("011.1.6E");
      expect(sel.index).toBe(2);
    }
  });

  test("no identity → the next shuffle draw, via FALLBACK (never a match)", () => {
    const { bag, calls } = fakeBag(2);
    const sel = selectVjIndex({ deck: 1 }, plan, bag);
    expect(sel).toEqual({ index: 2, reason: expect.any(String), via: "fallback" });
    expect(calls.next).toBe(1);
    expect(calls.taken).toEqual([]);
  });

  test("identity that resolves to nothing (not a finding) → FALLBACK draw, not the wrong finding", () => {
    const { bag, calls } = fakeBag(0);
    const msg: VjTransition = {
      deck: 2,
      identity: { artist: "Nobody At All", title: "A Track That Is Not In The Archive" },
    };
    const sel = selectVjIndex(msg, plan, bag);
    expect(sel.via).toBe("fallback");
    expect(calls.next).toBe(1);
    expect(calls.taken).toEqual([]);
  });

  test("a remix of a finding must NOT resolve to the original — FALLBACK, never the wrong finding", () => {
    const { bag } = fakeBag(0);
    const msg: VjTransition = {
      deck: 1,
      identity: { artist: "Technimatic", title: "Strength (Some Remix)" },
    };
    const sel = selectVjIndex(msg, plan, bag);
    expect(sel.via).toBe("fallback"); // the version-signature gate holds
  });
});
