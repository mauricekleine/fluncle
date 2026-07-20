import { describe, expect, it } from "vitest";
import {
  type ArtistEmbeddingGroup,
  artistCentroidFingerprint,
  meanEmbedding,
  rankSimilarArtists,
  rankSimilarToArtists,
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

describe("rankSimilarToArtists — the multi-artist 'sounds like these' probe math", () => {
  // The same fixture as rankSimilarArtists: drift is +x, echo hugs +x, pulse is the diagonal, void
  // is +y. The probe is the mean OF the selected artists' means, so it aims between them.
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

  it("ranks by cosine to the AVERAGE of the selected artists, both selected excluded", () => {
    // drift (+x) and void (+y) average to the diagonal — pulse sits exactly on it, echo is off toward
    // +x. So pulse leads echo, and neither selected artist appears in its own results.
    const results = rankSimilarToArtists(["drift", "void"], groups, 4);

    expect(results.map((artist) => artist.slug)).toEqual(["pulse", "echo"]);
    expect(results.some((artist) => artist.slug === "drift" || artist.slug === "void")).toBe(false);
  });

  it("with a SINGLE selected artist, equals the one-target rankSimilarArtists (the degenerate case)", () => {
    expect(rankSimilarToArtists(["drift"], groups, 4)).toEqual(
      rankSimilarArtists("drift", groups, 4),
    );
  });

  it("weighs each selected artist equally regardless of catalogue depth (mean of means)", () => {
    // echo carries TWO vectors, drift one; the probe is mean(mean(echo), mean(drift)), so echo's
    // extra track does not tilt the probe toward it — the two selected weigh 1:1.
    const results = rankSimilarToArtists(["drift", "echo"], groups, 4);

    // Both selected are excluded; the remaining pulse (diagonal) and void (+y) rank by the probe.
    expect(results.map((artist) => artist.slug)).toEqual(["pulse", "void"]);
  });

  it("honours the limit and returns [] for a non-positive one", () => {
    expect(rankSimilarToArtists(["drift", "void"], groups, 1).map((a) => a.slug)).toEqual([
      "pulse",
    ]);
    expect(rankSimilarToArtists(["drift", "void"], groups, 0)).toEqual([]);
  });

  it("returns [] when no selected artist has a vector to position from", () => {
    expect(rankSimilarToArtists(["nobody"], groups, 4)).toEqual([]);

    const withEmptySelected: ArtistEmbeddingGroup[] = [
      { artistId: "drift", imageUrl: undefined, name: "Drift", slug: "drift", vectors: [] },
      { artistId: "echo", imageUrl: undefined, name: "Echo", slug: "echo", vectors: [[1, 0]] },
    ];
    expect(rankSimilarToArtists(["drift"], withEmptySelected, 4)).toEqual([]);
  });

  it("carries each neighbour's avatar through", () => {
    const results = rankSimilarToArtists(["drift", "void"], groups, 4);

    expect(results.find((artist) => artist.slug === "echo")?.imageUrl).toBe(
      "https://i.scdn.co/image/echo",
    );
    expect(results.find((artist) => artist.slug === "pulse")?.imageUrl).toBeUndefined();
  });
});

describe("artistCentroidFingerprint — the per-artist staleness fingerprint", () => {
  it("folds the ranking-logic version and the artist's own embedded-track count into one string", () => {
    expect(artistCentroidFingerprint(5)).toBe("v1:5");
  });

  it("moves when the artist's embedded-track count moves (an embed, a re-link, a deletion)", () => {
    const base = artistCentroidFingerprint(5);

    // The count is PER-ARTIST, so only an artist whose OWN discography changed goes stale — not the
    // whole archive on any global change. A gain and a loss both diverge (compared with `<>`).
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
