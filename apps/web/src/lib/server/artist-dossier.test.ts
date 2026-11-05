import { describe, expect, it } from "vitest";
import {
  artistCentroidFingerprint,
  meanEmbedding,
  summarizeArtistSignature,
} from "./artist-dossier";

describe("meanEmbedding — the artist centroid", () => {
  it("returns null for an empty set (an artist with no embedded finding)", () => {
    expect(meanEmbedding([])).toBeNull();
  });

  it("returns the single vector unchanged", () => {
    expect(meanEmbedding([[1, 2, 3]])).toEqual([1, 2, 3]);
  });

  it("averages component-wise across the findings", () => {
    expect(
      meanEmbedding([
        [0, 0, 4],
        [2, 4, 0],
      ]),
    ).toEqual([1, 2, 2]);
  });

  it("treats a missing component in a ragged vector as zero", () => {
    expect(
      meanEmbedding([
        [4, 4, 6],
        [4, 4],
      ]),
    ).toEqual([4, 4, 3]);
  });
});

describe("artistCentroidFingerprint — the per-artist staleness fingerprint", () => {
  it("folds the ranking-logic version and the artist's own embedded-track count into one string", () => {
    expect(artistCentroidFingerprint(5)).toBe("v1:5");
  });

  it("moves when the artist's embedded-track count moves (an embed, a re-link, a deletion)", () => {
    const base = artistCentroidFingerprint(5);

    expect(artistCentroidFingerprint(6)).not.toBe(base);
    expect(artistCentroidFingerprint(4)).not.toBe(base);
  });
});

describe("summarizeArtistSignature — the fingerprint", () => {
  it("is empty for an artist with no findings", () => {
    expect(summarizeArtistSignature([])).toEqual({ firstFoundAt: undefined });
  });

  it("takes the earliest addedAt as the first-found date", () => {
    const signature = summarizeArtistSignature([
      { addedAt: "2026-03-01T00:00:00.000Z" },
      { addedAt: "2026-01-01T00:00:00.000Z" },
      { addedAt: "2026-02-01T00:00:00.000Z" },
    ]);

    expect(signature.firstFoundAt).toBe("2026-01-01T00:00:00.000Z");
  });
});
