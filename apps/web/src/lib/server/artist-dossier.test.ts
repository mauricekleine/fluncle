import { describe, expect, it } from "vitest";
import {
  type ArtistEmbeddingGroup,
  meanEmbedding,
  rankSimilarArtists,
  summarizeArtistSignature,
} from "./artist-dossier";

// The pure core of the artist dossier: the artist-level mean embedding + cosine
// ranking that powers the "same sector" similar-artists row, and the signature
// summary (first-found date, tempo band, key spread). Small fixture vectors only —
// the math is dimension-agnostic (cosine over the shared width), so 2-D vectors
// exercise it exactly like the real 1024-D MuQ space, with no DB or network.

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
    // [4, 4] widened to width 3 contributes 0 to the third slot.
    expect(
      meanEmbedding([
        [4, 4, 6],
        [4, 4],
      ]),
    ).toEqual([4, 4, 3]);
  });
});

describe("rankSimilarArtists — the same-sector ranking", () => {
  // Drift points along +x. Echo hugs +x (nearest), Pulse is diagonal (further),
  // Void is orthogonal (furthest). Cosine of the means, so direction is all that
  // matters — magnitude is normalized away.
  const groups: ArtistEmbeddingGroup[] = [
    { artistId: "drift", name: "Drift", slug: "drift", vectors: [[1, 0]] },
    {
      artistId: "echo",
      name: "Echo",
      slug: "echo",
      vectors: [
        [2, 0],
        [4, 1],
      ],
    },
    { artistId: "pulse", name: "Pulse", slug: "pulse", vectors: [[1, 1]] },
    { artistId: "void", name: "Void", slug: "void", vectors: [[0, 1]] },
  ];

  it("ranks the other artists by mean-embedding cosine, nearest first, self excluded", () => {
    const neighbours = rankSimilarArtists("drift", groups, 4);

    expect(neighbours.map((n) => n.slug)).toEqual(["echo", "pulse", "void"]);
    // The target never appears in its own neighbours.
    expect(neighbours.some((n) => n.slug === "drift")).toBe(false);
  });

  it("honours the limit", () => {
    expect(rankSimilarArtists("drift", groups, 1).map((n) => n.slug)).toEqual(["echo"]);
    expect(rankSimilarArtists("drift", groups, 0)).toEqual([]);
  });

  it("returns nothing when the target artist is absent from the corpus", () => {
    expect(rankSimilarArtists("nobody", groups, 4)).toEqual([]);
  });

  it("returns nothing when the target has no embedded finding to rank from", () => {
    const withEmptyTarget: ArtistEmbeddingGroup[] = [
      { artistId: "drift", name: "Drift", slug: "drift", vectors: [] },
      { artistId: "echo", name: "Echo", slug: "echo", vectors: [[1, 0]] },
    ];

    expect(rankSimilarArtists("drift", withEmptyTarget, 4)).toEqual([]);
  });

  it("skips candidates that have no vectors (they can't be positioned)", () => {
    const withEmptyCandidate: ArtistEmbeddingGroup[] = [
      { artistId: "drift", name: "Drift", slug: "drift", vectors: [[1, 0]] },
      { artistId: "ghost", name: "Ghost", slug: "ghost", vectors: [] },
      { artistId: "echo", name: "Echo", slug: "echo", vectors: [[1, 0]] },
    ];

    expect(rankSimilarArtists("drift", withEmptyCandidate, 4).map((n) => n.slug)).toEqual(["echo"]);
  });
});

describe("summarizeArtistSignature — the fingerprint", () => {
  it("is all-empty for an artist with no findings", () => {
    expect(summarizeArtistSignature([])).toEqual({
      bpm: undefined,
      firstFoundAt: undefined,
      keys: [],
    });
  });

  it("takes the earliest addedAt as the first-found date", () => {
    const signature = summarizeArtistSignature([
      { addedAt: "2026-03-01T00:00:00.000Z", bpm: undefined, key: undefined },
      { addedAt: "2026-01-01T00:00:00.000Z", bpm: undefined, key: undefined },
      { addedAt: "2026-02-01T00:00:00.000Z", bpm: undefined, key: undefined },
    ]);

    expect(signature.firstFoundAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("computes the tempo band with an odd-count median", () => {
    const signature = summarizeArtistSignature([
      { addedAt: "2026-01-01T00:00:00.000Z", bpm: 174, key: undefined },
      { addedAt: "2026-01-02T00:00:00.000Z", bpm: 172, key: undefined },
      { addedAt: "2026-01-03T00:00:00.000Z", bpm: 176, key: undefined },
    ]);

    expect(signature.bpm).toEqual({ max: 176, median: 174, min: 172 });
  });

  it("averages the two middle values for an even-count median", () => {
    const signature = summarizeArtistSignature([
      { addedAt: "2026-01-01T00:00:00.000Z", bpm: 170, key: undefined },
      { addedAt: "2026-01-02T00:00:00.000Z", bpm: 174, key: undefined },
      { addedAt: "2026-01-03T00:00:00.000Z", bpm: 176, key: undefined },
      { addedAt: "2026-01-04T00:00:00.000Z", bpm: 172, key: undefined },
    ]);

    // Sorted 170,172,174,176 → median = (172 + 174) / 2 = 173.
    expect(signature.bpm).toEqual({ max: 176, median: 173, min: 170 });
  });

  it("ignores non-finite BPMs and yields no band when none are present", () => {
    const signature = summarizeArtistSignature([
      { addedAt: "2026-01-01T00:00:00.000Z", bpm: undefined, key: undefined },
      { addedAt: "2026-01-02T00:00:00.000Z", bpm: Number.NaN, key: undefined },
    ]);

    expect(signature.bpm).toBeUndefined();
  });

  it("de-duplicates and sorts the key spread, trimming blanks", () => {
    const signature = summarizeArtistSignature([
      { addedAt: "2026-01-01T00:00:00.000Z", bpm: undefined, key: "F minor" },
      { addedAt: "2026-01-02T00:00:00.000Z", bpm: undefined, key: "A minor" },
      { addedAt: "2026-01-03T00:00:00.000Z", bpm: undefined, key: "  " },
      { addedAt: "2026-01-04T00:00:00.000Z", bpm: undefined, key: "A minor" },
    ]);

    expect(signature.keys).toEqual(["A minor", "F minor"]);
  });
});
