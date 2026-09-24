// The artist-review queue's pure predicates (lib/artist-review.ts): "needs a look" is a per-link
// fact — a link is fresh iff its `reviewedAt` is null — and the /admin/artists board splits the
// fresh links into the high-priority and everything-else queues. Client-safe, so no DB.
import { describe, expect, it } from "vitest";
import {
  artistNeedsLook,
  type ArtistOverviewItem,
  type ArtistSocial,
  partitionFreshLinks,
  unreviewedSocials,
} from "./artist-review";

describe("artistNeedsLook", () => {
  const link = (reviewedAt: string | null) => ({ reviewedAt });

  it("is false when the artist has no links (nothing to look at)", () => {
    expect(artistNeedsLook([])).toBe(false);
  });

  it("is false when every link has been reviewed", () => {
    expect(
      artistNeedsLook([link("2026-07-01T00:00:00.000Z"), link("2026-07-08T12:00:00.000Z")]),
    ).toBe(false);
  });

  it("is true when any link is still unreviewed (reviewedAt null)", () => {
    expect(artistNeedsLook([link("2026-07-01T00:00:00.000Z"), link(null)])).toBe(true);
  });
});

describe("unreviewedSocials", () => {
  it("returns only the unreviewed links, oldest-first", () => {
    const fresh = { createdAt: "2026-07-05T00:00:00.000Z", id: "b", reviewedAt: null };
    const alsoFresh = { createdAt: "2026-07-01T00:00:00.000Z", id: "a", reviewedAt: null };
    const seen = { createdAt: "2026-07-09T00:00:00.000Z", id: "c", reviewedAt: "2026-07-09" };

    expect(unreviewedSocials([fresh, alsoFresh, seen])).toEqual([alsoFresh, fresh]);
  });

  it("is empty when nothing is fresh", () => {
    expect(
      unreviewedSocials([
        { createdAt: "2026-07-01T00:00:00.000Z", id: "a", reviewedAt: "2026-07-02" },
      ]),
    ).toEqual([]);
  });
});

describe("partitionFreshLinks", () => {
  // Small builders so each case reads as data, not boilerplate.
  function social(over: Partial<ArtistSocial> & { id: string }): ArtistSocial {
    return {
      artistId: "artist",
      createdAt: "2026-01-01T00:00:00.000Z",
      platform: "instagram",
      reviewedAt: null,
      source: "firecrawl",
      status: "candidate",
      url: `https://example.com/${over.id}`,
      ...over,
    };
  }

  function artist(
    over: Partial<ArtistOverviewItem> & { id: string; name: string; socials: ArtistSocial[] },
  ): ArtistOverviewItem {
    return {
      findingCount: 0,
      slug: over.name.toLowerCase().replace(/\s+/g, "-"),
      spotifyUrl: null,
      ...over,
    };
  }

  it("routes a fresh link to high-priority iff its artist has a finding", () => {
    const withFinding = artist({
      findingCount: 2,
      id: "a1",
      name: "Alix Perez",
      socials: [social({ id: "s1", platform: "instagram" })],
    });
    const catalogueOnly = artist({
      findingCount: 0,
      id: "a2",
      name: "Monty",
      socials: [social({ artistId: "a2", id: "s2", platform: "instagram" })],
    });

    const { everythingElse, highPriority } = partitionFreshLinks([withFinding, catalogueOnly]);

    expect(highPriority.map((e) => e.social.id)).toEqual(["s1"]);
    expect(everythingElse.map((e) => e.social.id)).toEqual(["s2"]);
  });

  it("leads high-priority with the mention-loop platforms (tiktok, youtube), then artist name", () => {
    // One findings-artist with a non-mention link that sorts BEFORE a mention link by name, to prove
    // the platform key beats the name key: the tiktok/youtube links must still come first.
    const aardvark = artist({
      findingCount: 1,
      id: "a1",
      name: "Aardvark", // sorts first by name
      socials: [social({ artistId: "a1", id: "insta", platform: "instagram" })],
    });
    const zomby = artist({
      findingCount: 1,
      id: "a2",
      name: "Zomby", // sorts last by name
      socials: [
        social({ artistId: "a2", id: "tik", platform: "tiktok" }),
        social({ artistId: "a2", id: "yt", platform: "youtube" }),
      ],
    });

    const { highPriority } = partitionFreshLinks([aardvark, zomby]);

    // Mention-loop platforms lead (tiktok + youtube, both from Zomby), THEN the instagram row —
    // even though Aardvark sorts first by name, its non-mention platform ranks it after.
    expect(highPriority.map((e) => e.social.id)).toEqual(["tik", "yt", "insta"]);
  });

  it("orders same-rank high-priority links by artist name, then oldest-first", () => {
    const beta = artist({
      findingCount: 1,
      id: "a1",
      name: "Beta",
      socials: [
        social({ artistId: "a1", createdAt: "2026-02-01", id: "b-new", platform: "tiktok" }),
        social({ artistId: "a1", createdAt: "2026-01-01", id: "b-old", platform: "tiktok" }),
      ],
    });
    const alpha = artist({
      findingCount: 1,
      id: "a2",
      name: "Alpha",
      socials: [social({ artistId: "a2", id: "a-tik", platform: "tiktok" })],
    });

    const { highPriority } = partitionFreshLinks([beta, alpha]);

    // All tiktok (same platform rank) → by artist name (Alpha < Beta), then oldest-first within Beta.
    expect(highPriority.map((e) => e.social.id)).toEqual(["a-tik", "b-old", "b-new"]);
  });

  it("includes only unreviewed links, and never drops a fresh non-candidate row", () => {
    const subject = artist({
      findingCount: 1,
      id: "a1",
      name: "Calibre",
      socials: [
        social({ id: "reviewed", reviewedAt: "2026-01-02T00:00:00.000Z" }),
        // A fresh AUTO link (not a candidate) still belongs in the queue — the split partitions, it
        // does not filter by status.
        social({ id: "fresh-auto", platform: "tiktok", source: "musicbrainz", status: "auto" }),
      ],
    });

    const { highPriority } = partitionFreshLinks([subject]);

    expect(highPriority.map((e) => e.social.id)).toEqual(["fresh-auto"]);
  });

  it("returns two empty buckets when nothing is fresh", () => {
    const settled = artist({
      findingCount: 5,
      id: "a1",
      name: "Fresh-free",
      socials: [social({ id: "s1", reviewedAt: "2026-01-02T00:00:00.000Z" })],
    });

    expect(partitionFreshLinks([settled])).toEqual({ everythingElse: [], highPriority: [] });
  });
});
