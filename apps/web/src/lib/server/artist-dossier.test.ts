import { describe, expect, it } from "vitest";
import {
  type ArtistEmbeddingGroup,
  meanEmbedding,
  rankSimilarArtists,
  summarizeArtistSignature,
} from "./artist-dossier";

// The pure core of the artist dossier: the artist-level mean embedding + cosine
// ranking that powers the "similar artists" row, and the signature summary (the
// first-found date). Small fixture vectors only — the math is dimension-agnostic
// (cosine over the shared width), so 2-D vectors exercise it exactly like the real
// 1024-D MuQ space, with no DB or network.

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

describe("rankSimilarArtists — the similar-artists ranking", () => {
  // Drift points along +x. Echo hugs +x (nearest), Pulse is diagonal (further),
  // Void is orthogonal (furthest). Cosine of the means, so direction is all that
  // matters — magnitude is normalized away.
  const groups: ArtistEmbeddingGroup[] = [
    { artistId: "drift", imageUrl: undefined, name: "Drift", slug: "drift", vectors: [[1, 0]] },
    {
      artistId: "echo",
      imageUrl: "https://i.scdn.co/image/echo",
      name: "Echo",
      slug: "echo",
      vectors: [
        [2, 0],
        [4, 1],
      ],
    },
    { artistId: "pulse", imageUrl: undefined, name: "Pulse", slug: "pulse", vectors: [[1, 1]] },
    { artistId: "void", imageUrl: undefined, name: "Void", slug: "void", vectors: [[0, 1]] },
  ];

  it("ranks the other artists by mean-embedding cosine, nearest first, self excluded", () => {
    const neighbours = rankSimilarArtists("drift", groups, 4);

    expect(neighbours.map((n) => n.slug)).toEqual(["echo", "pulse", "void"]);
    // The target never appears in its own neighbours.
    expect(neighbours.some((n) => n.slug === "drift")).toBe(false);
  });

  it("carries each neighbour's avatar through (undefined when the artist has none)", () => {
    const neighbours = rankSimilarArtists("drift", groups, 4);

    expect(neighbours).toContainEqual({
      imageUrl: "https://i.scdn.co/image/echo",
      name: "Echo",
      slug: "echo",
    });
    expect(neighbours.find((n) => n.slug === "pulse")?.imageUrl).toBeUndefined();
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
      { artistId: "drift", imageUrl: undefined, name: "Drift", slug: "drift", vectors: [] },
      { artistId: "echo", imageUrl: undefined, name: "Echo", slug: "echo", vectors: [[1, 0]] },
    ];

    expect(rankSimilarArtists("drift", withEmptyTarget, 4)).toEqual([]);
  });

  it("skips candidates that have no vectors (they can't be positioned)", () => {
    const withEmptyCandidate: ArtistEmbeddingGroup[] = [
      { artistId: "drift", imageUrl: undefined, name: "Drift", slug: "drift", vectors: [[1, 0]] },
      { artistId: "ghost", imageUrl: undefined, name: "Ghost", slug: "ghost", vectors: [] },
      { artistId: "echo", imageUrl: undefined, name: "Echo", slug: "echo", vectors: [[1, 0]] },
    ];

    expect(rankSimilarArtists("drift", withEmptyCandidate, 4).map((n) => n.slug)).toEqual(["echo"]);
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
