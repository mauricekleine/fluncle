import { describe, expect, it } from "vitest";

import {
  betterKey,
  type MatchKey,
  planInserts,
  statusForKey,
} from "./backfill-artist-socials-from-mb-dump";

// PURE coverage for the MB-dump backfill's join/plan logic. The dump stream + prod write
// are exercised by running the script; this pins the trust rule (which key → which status)
// and the net-new planner (never re-inserts a platform the artist already has).

describe("statusForKey — ID-exact match is public, wikidata-only is a candidate", () => {
  it("spotify and mbid matches are born auto", () => {
    expect(statusForKey("spotify")).toBe("auto");
    expect(statusForKey("mbid")).toBe("auto");
  });
  it("a wikidata-qid-only match is born candidate", () => {
    expect(statusForKey("qid")).toBe("candidate");
  });
});

describe("betterKey — higher-trust key wins", () => {
  it("prefers spotify over mbid over qid", () => {
    expect(betterKey("mbid", "spotify")).toBe("spotify");
    expect(betterKey("qid", "mbid")).toBe("mbid");
    expect(betterKey("qid", "spotify")).toBe("spotify");
  });
  it("is order-independent", () => {
    expect(betterKey("spotify", "mbid")).toBe("spotify");
    expect(betterKey("mbid", "qid")).toBe("mbid");
  });
});

describe("planInserts — net-new only, correct status", () => {
  let n = 0;
  const seq = () => `id${++n}`;

  it("plans a link only for a platform the artist does not already have", () => {
    n = 0;
    const matches = new Map<string, { key: MatchKey; socials: Map<string, string> }>([
      [
        "a1",
        {
          key: "spotify",
          socials: new Map([
            ["instagram", "https://instagram.com/x"],
            ["tiktok", "https://tiktok.com/@x"],
          ]),
        },
      ],
    ]);
    const existing = new Map<string, Set<string>>([["a1", new Set(["instagram"])]]);
    const plan = planInserts(matches, existing, seq);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ artistId: "a1", platform: "tiktok", status: "auto" });
  });

  it("skips every platform when the artist already has them all", () => {
    const matches = new Map([
      ["a1", { key: "mbid" as MatchKey, socials: new Map([["youtube", "u"]]) }],
    ]);
    const existing = new Map([["a1", new Set(["youtube"])]]);
    expect(planInserts(matches, existing, seq)).toHaveLength(0);
  });

  it("marks a qid-only match candidate and plans all platforms for a fresh artist", () => {
    n = 0;
    const matches = new Map([
      [
        "a2",
        {
          key: "qid" as MatchKey,
          socials: new Map([
            ["soundcloud", "s"],
            ["bandcamp", "b"],
          ]),
        },
      ],
    ]);
    const plan = planInserts(matches, new Map(), seq);
    expect(plan).toHaveLength(2);
    expect(plan.every((p) => p.status === "candidate")).toBe(true);
    expect(new Set(plan.map((p) => p.id)).size).toBe(2); // unique ids
  });
});
