import { describe, expect, it } from "vitest";

import {
  type ArchiveAffinity,
  catalogueRankCorpusForTrack,
  capturePriorityFor,
  diversifyRanked,
  type DiversitySignals,
  DUPLICATE_CAPTURE_TIER,
  qualifiedArtistsDigest,
  rankCorpus,
} from "./catalogue";

const KRAKOTA_ID = "artist-krakota";

const archive: ArchiveAffinity = {
  disabledLabels: new Set(["anjunabeats"]),

  findingArtists: new Set(["krakota", "nu:tone"]),

  findingLabels: new Set(["anjunabeats", "atlantic-uk", "hospital-records"]),

  qualifiedArtists: new Set([KRAKOTA_ID]),

  seedLabels: new Set(["hospital-records", "critical-music"]),
};

describe("capturePriorityFor — authorization (the artist-driven gate)", () => {
  it("authorizes a track by a QUALIFIED artist (identity) and puts it at the top (3)", () => {
    expect(
      capturePriorityFor(
        { artistIds: [KRAKOTA_ID], artists: ["Krakota"], label: "Some Undecided Label" },
        archive,
      ),
    ).toEqual({ priority: 3, reason: { kind: "artist", name: "Krakota" } });
  });

  it("authorizes an EDGE-LESS track only via its enabled label (1)", () => {
    expect(
      capturePriorityFor({ artistIds: [], artists: ["Nobody"], label: "Critical Music" }, archive),
    ).toEqual({ priority: 1, reason: { kind: "seed-label", name: "Critical Music" } });
  });

  it("SINKS an edge-less name-match on an un-enabled label — identity-only, not name-fold", () => {
    expect(
      capturePriorityFor(
        { artistIds: [], artists: ["Krakota"], label: "Some Undecided Label" },
        archive,
      ),
    ).toEqual({ priority: -3, reason: { kind: "unauthorized", name: null } });
  });

  it("does NOT authorize label-mates off a finding on a NON-enabled label (the Atlantic-UK pin)", () => {
    expect(
      capturePriorityFor({ artistIds: [], artists: ["Nobody"], label: "Atlantic UK" }, archive),
    ).toEqual({ priority: -3, reason: { kind: "unauthorized", name: null } });
  });

  it("sinks an unqualified artist on an undecided label with no findings to `unauthorized`", () => {
    expect(
      capturePriorityFor(
        { artistIds: ["artist-unknown"], artists: ["Nobody"], label: "Some Trance Imprint" },
        archive,
      ),
    ).toEqual({ priority: -3, reason: { kind: "unauthorized", name: null } });
  });

  it("sinks a bare row (no artists, no label) to `unauthorized`", () => {
    expect(capturePriorityFor({ artistIds: [], artists: [], label: null }, archive)).toEqual({
      priority: -3,
      reason: { kind: "unauthorized", name: null },
    });
  });
});

describe("capturePriorityFor — the veto, checked first", () => {
  it("VETOES a disabled label even though it carries a finding (−1)", () => {
    expect(
      capturePriorityFor({ artistIds: [], artists: ["Nobody"], label: "Anjunabeats" }, archive),
    ).toEqual({ priority: -1, reason: { kind: "skipped-label", name: "Anjunabeats" } });
  });

  it("lets the veto beat even a QUALIFIED artist — the operator's ruling wins", () => {
    expect(
      capturePriorityFor(
        { artistIds: [KRAKOTA_ID], artists: ["Krakota"], label: "Anjunabeats" },
        archive,
      ),
    ).toEqual({ priority: -1, reason: { kind: "skipped-label", name: "Anjunabeats" } });
  });

  it("keeps the veto to ACQUISITION, never storage — the reason still NAMES the label", () => {
    const { reason } = capturePriorityFor(
      { artistIds: [KRAKOTA_ID], artists: ["Krakota"], label: "Anjunabeats" },
      archive,
    );

    expect(reason.name).toBe("Anjunabeats");
  });
});

describe("capturePriorityFor — priority ordering among AUTHORIZED rows", () => {
  it("falls to the label a finding sits on (2), but only once ENABLED-authorized, through the fold", () => {
    expect(
      capturePriorityFor(
        { artistIds: [], artists: ["Nobody"], label: "Hospital Records." },
        archive,
      ),
    ).toEqual({ priority: 2, reason: { kind: "label", name: "Hospital Records." } });
  });

  it("names a QUALIFIED artist by the row's own first credit when the spelling is not on a finding", () => {
    expect(
      capturePriorityFor(
        { artistIds: [KRAKOTA_ID], artists: ["Fresh Name"], label: null },
        archive,
      ),
    ).toEqual({ priority: 3, reason: { kind: "artist", name: "Fresh Name" } });
  });

  it("matches the finding-artist hint case-insensitively, naming the spelling the TRACK carries", () => {
    expect(
      capturePriorityFor(
        { artistIds: [], artists: ["Guest", "NU:TONE"], label: "Critical Music" },
        archive,
      ),
    ).toEqual({ priority: 3, reason: { kind: "artist", name: "NU:TONE" } });
  });

  it("prefers the strongest rung — a qualified artist beats a label hint", () => {
    expect(
      capturePriorityFor(
        { artistIds: [KRAKOTA_ID], artists: ["Krakota"], label: "Hospital Records" },
        archive,
      ).reason.kind,
    ).toBe("artist");
  });

  it("never lets a blank or all-punctuation label authorize an edge-less row", () => {
    for (const label of ["", "   ", "."]) {
      expect(capturePriorityFor({ artistIds: [], artists: ["Nobody"], label }, archive)).toEqual({
        priority: -3,
        reason: { kind: "unauthorized", name: null },
      });
    }
  });
});

describe("capturePriorityFor — the negative band is distinct and ordered", () => {
  it("gives `unauthorized` its own tier, below the veto and the duplicate", () => {
    const unauthorized = capturePriorityFor(
      { artistIds: [], artists: ["Nobody"], label: "Some Trance Imprint" },
      archive,
    );
    const vetoed = capturePriorityFor(
      { artistIds: [], artists: ["Nobody"], label: "Anjunabeats" },
      archive,
    );

    expect(vetoed.priority).toBe(-1);
    expect(DUPLICATE_CAPTURE_TIER).toBe(-2);
    expect(unauthorized.priority).toBe(-3);
    expect(unauthorized.priority).toBeLessThan(DUPLICATE_CAPTURE_TIER);
    expect(DUPLICATE_CAPTURE_TIER).toBeLessThan(vetoed.priority);
  });
});

describe("rankCorpus — the staleness fingerprint", () => {
  const digest = qualifiedArtistsDigest(["a", "b"]);

  it("moves when a finding is logged, and when one is embedded", () => {
    expect(rankCorpus(60, 60, 0, "d", "initial")).toMatch(/^v6:60:60:0:d:[0-9a-f]{16}$/);

    expect(rankCorpus(61, 60, 0, "d", "initial")).not.toBe(rankCorpus(60, 60, 0, "d", "initial"));

    expect(rankCorpus(61, 61, 0, "d", "initial")).not.toBe(rankCorpus(61, 60, 0, "d", "initial"));
  });

  it("moves when the QUALIFIED-ARTIST SET changes — the second-order authorization signal (v5)", () => {
    expect(rankCorpus(60, 60, 42, "d", "initial")).not.toBe(rankCorpus(60, 60, 41, "d", "initial"));
  });

  it("moves on a same-size MEMBERSHIP SWAP — the batch-ruling money-bug hole the size alone left open", () => {
    const swapped = qualifiedArtistsDigest(["a", "c"]);
    expect(swapped).not.toBe(digest);
    expect(rankCorpus(60, 60, 2, swapped, "initial")).not.toBe(
      rankCorpus(60, 60, 2, digest, "initial"),
    );
  });

  it("catches a DELETED finding, because it is compared for INEQUALITY and not order", () => {
    expect(rankCorpus(59, 59, 0, "d", "initial")).not.toBe(rankCorpus(60, 60, 0, "d", "initial"));
  });

  it("is a no-op fingerprint on an unchanged archive", () => {
    expect(rankCorpus(60, 60, 42, digest, "initial")).toBe(
      rankCorpus(60, 60, 42, digest, "initial"),
    );
  });

  it("moves when finding vector content is replaced without changing corpus counts", () => {
    expect(rankCorpus(60, 60, 42, digest, "track-update:a")).not.toBe(
      rankCorpus(60, 60, 42, digest, "track-update:b"),
    );
  });

  it("keeps pre-audio rows stable across finding-vector-only revisions", () => {
    expect(catalogueRankCorpusForTrack(rankCorpus(60, 60, 42, digest, "a"), false)).toBe(
      catalogueRankCorpusForTrack(rankCorpus(60, 60, 42, digest, "b"), false),
    );
    expect(catalogueRankCorpusForTrack(rankCorpus(60, 60, 42, digest, "a"), true)).not.toBe(
      catalogueRankCorpusForTrack(rankCorpus(60, 60, 42, digest, "b"), true),
    );
  });
});

describe("diversifyRanked — the greedy decay page", () => {
  type Row = DiversitySignals & { id: string };

  const signalsOf = (r: Row): DiversitySignals => ({
    artist: r.artist,
    key: r.key,
    score: r.score,
    year: r.year,
  });

  const bare = (id: string, score: number): Row => ({
    artist: null,
    id,
    key: null,
    score,
    year: null,
  });

  it("with no shared signals, holds pure score-descending order", () => {
    const pool = [bare("a", 0.8), bare("b", 1), bare("c", 0.9)];

    expect(diversifyRanked(pool, 3, signalsOf).map((r) => r.id)).toEqual(["b", "c", "a"]);
  });

  it("lets a lower-scoring DIFFERENT artist leapfrog a same-artist runner-up", () => {
    const pool: Row[] = [
      { artist: "x", id: "A", key: null, score: 1, year: null },
      { artist: "x", id: "B", key: null, score: 0.99, year: null },
      { artist: "y", id: "C", key: null, score: 0.98, year: null },
    ];

    expect(diversifyRanked(pool, 3, signalsOf).map((r) => r.id)).toEqual(["A", "C", "B"]);
  });

  it("does NOT reorder that same pool when every row reads as a distinct artist", () => {
    const pool: Row[] = [
      { artist: "x", id: "A", key: null, score: 1, year: null },
      { artist: "x", id: "B", key: null, score: 0.99, year: null },
      { artist: "y", id: "C", key: null, score: 0.98, year: null },
    ];
    const distinct = (r: Row): DiversitySignals => ({
      artist: r.id,
      key: r.key,
      score: r.score,
      year: r.year,
    });

    expect(diversifyRanked(pool, 3, distinct).map((r) => r.id)).toEqual(["A", "B", "C"]);
  });

  it("decays on year too (the milder 0.985 knob)", () => {
    const pool: Row[] = [
      { artist: null, id: "A", key: null, score: 1, year: "2020" },
      { artist: null, id: "B", key: null, score: 0.99, year: "2020" },
      { artist: null, id: "C", key: null, score: 0.98, year: "2021" },
    ];

    expect(diversifyRanked(pool, 3, signalsOf).map((r) => r.id)).toEqual(["A", "C", "B"]);
  });

  it("stacks decay across repeats — a third same-artist row sinks below a fresh one", () => {
    const pool: Row[] = [
      { artist: "x", id: "A", key: null, score: 1, year: null },
      { artist: "x", id: "B", key: null, score: 0.99, year: null },
      { artist: "x", id: "C", key: null, score: 0.985, year: null },
      { artist: "y", id: "D", key: null, score: 0.96, year: null },
    ];

    expect(diversifyRanked(pool, 4, signalsOf).map((r) => r.id)).toEqual(["A", "B", "D", "C"]);
  });

  it("returns at most `page` items, and never more than the pool holds", () => {
    const pool = [bare("a", 1), bare("b", 0.9), bare("c", 0.8)];

    expect(diversifyRanked(pool, 2, signalsOf).map((r) => r.id)).toEqual(["a", "b"]);
    expect(diversifyRanked(pool, 10, signalsOf)).toHaveLength(3);
    expect(diversifyRanked([], 5, signalsOf)).toEqual([]);
  });
});
