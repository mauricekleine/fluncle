import { describe, expect, it } from "vitest";

import {
  anchorSearchQuery,
  detectVersionMismatch,
  parseAnchorReview,
  pickIsrcCandidate,
  pickVerifiedCandidate,
} from "./anchor";

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

  // RETRIEVAL, not verification: the gate forgives these spellings, but only on a candidate we were
  // handed — and the platform hands back nothing when asked in the row's own spelling. Both rows are
  // measured misses (2026-07-27), retrievable under the canonical spelling.
  it("asks in the spelling the platforms index", () => {
    expect(anchorSearchQuery(["Minos"], "Feels Like Before (Air.K & Cephei rmx)")).toBe(
      "Minos Feels Like Before (Air.K & Cephei Remix)",
    );
    expect(anchorSearchQuery(["Klute"], "Part of Me (instrumental mix)")).toBe(
      "Klute Part of Me (instrumental)",
    );
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

  it("does NOT anchor when the duration is off by more than the 3s window", () => {
    const candidates = [{ ...base, artists: ["Hold Tight"], durationMs: 203_001, title: "Lounge" }];

    expect(pickVerifiedCandidate(["Hold Tight"], "Lounge", 200_000, candidates)).toBeUndefined();
  });

  it("anchors at 2.6s off — the calibrated window (same-recording drift P99 ≈ 5s, wrong-recording ≥21s)", () => {
    // The measured 2026-07-26 false-miss: compilation master vs single master, Δ2.6s.
    const candidates = [
      { ...base, artists: ["Donnie Dubson"], durationMs: 320_000, title: "Monday" },
    ];

    expect(
      pickVerifiedCandidate(["Donnie Dubson"], "Monday", 322_600, candidates)?.spotifyTrackId,
    ).toBe("hit");
  });

  it("does NOT anchor a '- VIP' to a plain-title row (the fold keeps descriptors distinct)", () => {
    const candidates = [
      { ...base, artists: ["DJ Fresh"], durationMs: 200_000, title: "Bad Company - VIP" },
    ];

    expect(pickVerifiedCandidate(["DJ Fresh"], "Bad Company", 200_000, candidates)).toBeUndefined();
  });

  it("does NOT anchor when the artist set differs (disjoint is never a subset)", () => {
    const candidates = [
      { ...base, artists: ["Someone Else"], durationMs: 200_000, title: "Dribble" },
    ];

    expect(pickVerifiedCandidate(["Muffler"], "Dribble", 200_000, candidates)).toBeUndefined();
  });

  it("SUBSET fallback: a primary-only credit anchors when the duration is within the tight 1s window", () => {
    // The measured class (~9% of stable misses): "LSB & DRS — Could Be" listed under "LSB" alone.
    const candidates = [{ ...base, artists: ["LSB"], durationMs: 340_400, title: "Could Be" }];

    expect(
      pickVerifiedCandidate(["LSB", "DRS"], "Could Be", 340_000, candidates)?.spotifyTrackId,
    ).toBe("hit");
  });

  it("SUBSET fallback refuses outside the tight window, even inside the full gate's 3s", () => {
    const candidates = [{ ...base, artists: ["LSB"], durationMs: 342_000, title: "Could Be" }];

    expect(pickVerifiedCandidate(["LSB", "DRS"], "Could Be", 340_000, candidates)).toBeUndefined();
  });

  it("SUBSET fallback is one-way: a candidate crediting MORE artists than the row never matches", () => {
    const candidates = [
      { ...base, artists: ["LSB", "DRS"], durationMs: 340_000, title: "Could Be" },
    ];

    expect(pickVerifiedCandidate(["LSB"], "Could Be", 340_000, candidates)).toBeUndefined();
  });

  it("SUBSET fallback still enforces the version descriptor", () => {
    const candidates = [
      { ...base, artists: ["LSB"], durationMs: 340_000, title: "Could Be (Anile Remix)" },
    ];

    expect(pickVerifiedCandidate(["LSB", "DRS"], "Could Be", 340_000, candidates)).toBeUndefined();
  });

  it("SUBSET fallback drops a candidate with no artists at all", () => {
    const candidates = [{ ...base, artists: [], durationMs: 340_000, title: "Could Be" }];

    expect(pickVerifiedCandidate(["LSB", "DRS"], "Could Be", 340_000, candidates)).toBeUndefined();
  });

  it("the FULL gate wins over a closer-duration subset candidate", () => {
    const candidates = [
      {
        ...base,
        artists: ["LSB"],
        durationMs: 340_000,
        spotifyTrackId: "subset",
        title: "Could Be",
      },
      {
        ...base,
        artists: ["LSB", "DRS"],
        durationMs: 341_500,
        spotifyTrackId: "full",
        title: "Could Be",
      },
    ];

    expect(
      pickVerifiedCandidate(["LSB", "DRS"], "Could Be", 340_000, candidates)?.spotifyTrackId,
    ).toBe("full");
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

describe("detectVersionMismatch — the one miss worth writing down", () => {
  const base = { spotifyTrackId: "suspect" };

  it("fires on the measured shape: same artists + base title + duration, DIFFERENT descriptor", () => {
    // The real case (2026-07-26): a comp track whose MusicBrainz title omits the version. Our row
    // says plain "Typical Description" at 394s; streaming has plain at 313s and the remix at 394s.
    const candidates = [
      {
        ...base,
        artists: ["Calibre"],
        durationMs: 394_000,
        title: "Typical Description (Calibre Remix)",
      },
    ];

    expect(
      detectVersionMismatch(["Calibre"], "Typical Description", 394_000, candidates)
        ?.spotifyTrackId,
    ).toBe("suspect");
  });

  it("fires the other way too: OUR row is the labelled one and the candidate is plain", () => {
    const candidates = [
      { ...base, artists: ["Calibre"], durationMs: 394_000, title: "Typical Description" },
    ];

    expect(
      detectVersionMismatch(["Calibre"], "Typical Description (Calibre Remix)", 394_000, candidates)
        ?.spotifyTrackId,
    ).toBe("suspect");
  });

  it("does NOT fire on a plain full-gate miss — a different base title is a different track", () => {
    const candidates = [
      {
        ...base,
        artists: ["Calibre"],
        durationMs: 394_000,
        title: "Something Else (Calibre Remix)",
      },
    ];

    expect(
      detectVersionMismatch(["Calibre"], "Typical Description", 394_000, candidates),
    ).toBeUndefined();
  });

  it("does NOT fire when the descriptors AGREE (that candidate is a plain duration/identity miss)", () => {
    const candidates = [
      { ...base, artists: ["Calibre"], durationMs: 394_000, title: "Typical Description" },
    ];

    expect(
      detectVersionMismatch(["Calibre"], "Typical Description", 394_000, candidates),
    ).toBeUndefined();
  });

  it("does NOT fire outside the TIGHT 1s window, even inside the gate's own 3s", () => {
    // Past a second the duration stops doing the identifying, so a descriptor disagreement is just
    // two different recordings again — exactly the case the gate is right to refuse silently.
    const candidates = [
      {
        ...base,
        artists: ["Calibre"],
        durationMs: 396_000,
        title: "Typical Description (Calibre Remix)",
      },
    ];

    expect(
      detectVersionMismatch(["Calibre"], "Typical Description", 394_000, candidates),
    ).toBeUndefined();
  });

  it("fires on a SUBSET artist credit (the primary-only collab billing)", () => {
    const candidates = [
      { ...base, artists: ["LSB"], durationMs: 340_000, title: "Could Be (Anile Remix)" },
    ];

    expect(
      detectVersionMismatch(["LSB", "DRS"], "Could Be", 340_000, candidates)?.spotifyTrackId,
    ).toBe("suspect");
  });

  it("is one-way on artists: a candidate crediting MORE than the row is a different credit", () => {
    const candidates = [
      { ...base, artists: ["LSB", "DRS"], durationMs: 340_000, title: "Could Be (Anile Remix)" },
    ];

    expect(detectVersionMismatch(["LSB"], "Could Be", 340_000, candidates)).toBeUndefined();
  });

  it("does NOT fire on a disjoint artist set, however close the duration", () => {
    const candidates = [
      { ...base, artists: ["Someone Else"], durationMs: 340_000, title: "Could Be (Anile Remix)" },
    ];

    expect(detectVersionMismatch(["LSB", "DRS"], "Could Be", 340_000, candidates)).toBeUndefined();
  });

  it("drops a candidate with no duration, and picks the closest of those that qualify", () => {
    const candidates = [
      { artists: ["Calibre"], durationMs: null, spotifyTrackId: "no-dur", title: "Roll (VIP)" },
      { artists: ["Calibre"], durationMs: 394_900, spotifyTrackId: "far", title: "Roll (VIP)" },
      { artists: ["Calibre"], durationMs: 394_100, spotifyTrackId: "near", title: "Roll (VIP)" },
    ];

    expect(detectVersionMismatch(["Calibre"], "Roll", 394_000, candidates)?.spotifyTrackId).toBe(
      "near",
    );
  });

  it("refuses to suspect anything about a row with no duration, artists, or title", () => {
    const candidates = [
      { ...base, artists: ["Calibre"], durationMs: 394_000, title: "Roll (VIP)" },
    ];

    expect(detectVersionMismatch(["Calibre"], "Roll", 0, candidates)).toBeUndefined();
    expect(detectVersionMismatch([], "Roll", 394_000, candidates)).toBeUndefined();
    expect(detectVersionMismatch(["Calibre"], "   ", 394_000, candidates)).toBeUndefined();
  });
});

describe("parseAnchorReview — a corrupt note reads as NO note, never a throw", () => {
  it("round-trips a stored review", () => {
    const stored = JSON.stringify({
      at: "2026-07-26T00:00:00.000Z",
      candidate: {
        artists: [{ id: "sp-calibre", name: "Calibre" }],
        durationMs: 394_000,
        isrc: "GBCJY1300173",
        source: "listenbrainz",
        spotifyTrackId: "spot001",
        title: "Typical Description (Calibre Remix)",
      },
      reason: "version_mismatch",
      title: "Typical Description",
    });

    expect(parseAnchorReview(stored)?.candidate.spotifyTrackId).toBe("spot001");
    expect(parseAnchorReview(stored)?.title).toBe("Typical Description");
  });

  it("reads absent, blank, malformed, and wrong-shaped values as no review", () => {
    expect(parseAnchorReview(null)).toBeUndefined();
    expect(parseAnchorReview("   ")).toBeUndefined();
    expect(parseAnchorReview("{not json")).toBeUndefined();
    expect(parseAnchorReview("[]")).toBeUndefined();
    // A shape from some other feature, or a half-written row: no candidate, no reason.
    expect(parseAnchorReview(JSON.stringify({ at: "x", title: "y" }))).toBeUndefined();
  });
});
