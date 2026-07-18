import { describe, expect, it } from "vitest";

import { anchorSearchQuery, pickIsrcCandidate, pickVerifiedCandidate } from "./anchor";

// The verification rungs are pure, so they are unit-tested here without a database — the exact
// title fold, artist set, ±2s duration window, and ISRC equality that decide whether a candidate
// is genuinely the same recording. The `anchorTrack` write path (rails + stamping) is exercised
// against the real schema in anchor.integration.test.ts.

describe("anchorSearchQuery", () => {
  it("joins the row's artists then its title, trimmed", () => {
    expect(anchorSearchQuery(["Etherwood"], "Weightless")).toBe("Etherwood Weightless");
    expect(anchorSearchQuery(["Nu:Tone", "Logistics"], "Roller")).toBe("Nu:Tone Logistics Roller");
  });

  it("handles a row with no artists", () => {
    expect(anchorSearchQuery([], "Amen Break")).toBe("Amen Break");
  });
});

describe("pickIsrcCandidate — the exact rung", () => {
  it("picks the candidate whose ISRC equals the row's (case-insensitive, trimmed)", () => {
    const candidates = [
      { durationMs: 240_000, isrc: "USAAA0000001", spotifyTrackId: "wrong" },
      { durationMs: 240_000, isrc: "gbcjy1300173", spotifyTrackId: "right" },
    ];

    expect(pickIsrcCandidate("  GBCJY1300173 ", 240_000, candidates)?.spotifyTrackId).toBe("right");
  });

  it("when several candidates share the ISRC (a re-press), the closest duration wins", () => {
    // The pilot4 case: one ISRC resolves several Spotify track ids (different pressings). The row's
    // duration is the tiebreak — a wrong-length pressing must not win over the true recording.
    const candidates = [
      { durationMs: 200_000, isrc: "GBCJY1300173", spotifyTrackId: "long-press" },
      { durationMs: 261_500, isrc: "GBCJY1300173", spotifyTrackId: "true-press" },
    ];

    expect(pickIsrcCandidate("GBCJY1300173", 261_901, candidates)?.spotifyTrackId).toBe(
      "true-press",
    );
  });

  it("returns undefined when no candidate carries the row's ISRC", () => {
    const candidates = [{ durationMs: 240_000, isrc: "USAAA0000001", spotifyTrackId: "x" }];

    expect(pickIsrcCandidate("GBCJY1300173", 240_000, candidates)).toBeUndefined();
  });

  it("returns undefined for an empty row ISRC (never anchors on a blank key)", () => {
    const candidates = [{ durationMs: 240_000, isrc: "", spotifyTrackId: "x" }];

    expect(pickIsrcCandidate("   ", 240_000, candidates)).toBeUndefined();
  });
});

describe("pickVerifiedCandidate — the verified search triple", () => {
  const base = { spotifyTrackId: "hit" };

  it("anchors a candidate that clears folded artist + title + ±2s duration", () => {
    const candidates = [{ ...base, artists: ["Muffler"], durationMs: 201_000, title: "Dribble" }];

    expect(pickVerifiedCandidate(["Muffler"], "Dribble", 200_000, candidates)?.spotifyTrackId).toBe(
      "hit",
    );
  });

  it("does NOT anchor when the duration is off by more than 2s", () => {
    const candidates = [{ ...base, artists: ["Hold Tight"], durationMs: 203_001, title: "Lounge" }];

    expect(pickVerifiedCandidate(["Hold Tight"], "Lounge", 200_000, candidates)).toBeUndefined();
  });

  it("does NOT anchor a '- VIP' to a plain-title row (the fold keeps descriptors distinct)", () => {
    const candidates = [
      { ...base, artists: ["DJ Fresh"], durationMs: 200_000, title: "Bad Company - VIP" },
    ];

    expect(pickVerifiedCandidate(["DJ Fresh"], "Bad Company", 200_000, candidates)).toBeUndefined();
  });

  it("does NOT anchor when the artist set differs", () => {
    const candidates = [
      { ...base, artists: ["Someone Else"], durationMs: 200_000, title: "Dribble" },
    ];

    expect(pickVerifiedCandidate(["Muffler"], "Dribble", 200_000, candidates)).toBeUndefined();
  });

  it("drops a candidate with no duration (unverifiable), and picks the closest of those that clear", () => {
    const candidates = [
      {
        ...base,
        artists: ["Muffler"],
        durationMs: null,
        spotifyTrackId: "no-dur",
        title: "Dribble",
      },
      {
        ...base,
        artists: ["Muffler"],
        durationMs: 201_800,
        spotifyTrackId: "far",
        title: "Dribble",
      },
      {
        ...base,
        artists: ["Muffler"],
        durationMs: 200_200,
        spotifyTrackId: "near",
        title: "Dribble",
      },
    ];

    expect(pickVerifiedCandidate(["Muffler"], "Dribble", 200_000, candidates)?.spotifyTrackId).toBe(
      "near",
    );
  });
});
