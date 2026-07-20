// The pure helpers of the artist entity module (lib/server/artists.ts): the JSON parse of the
// raw `artists_json` names, the canonical slug mint, the two review predicates the /admin board
// + attention count share, and the write-path URL guard.
// These carry no DB — they are exercised directly, no libSQL engine needed. The DB-backed paths
// (upsert/link/queue) mock `./db` against the real schema like labels.test.ts and are out of
// scope here; this file closes the pure-unit gap flagged by the coverage audit.
import { describe, expect, it } from "vitest";
import {
  artistNeedsLook,
  type ArtistOverviewItem,
  type ArtistSocial,
  assertHttpUrl,
  InvalidArtistSocialError,
  parseArtistsJson,
  partitionFreshLinks,
  toArtistSlug,
  unreviewedSocials,
} from "./artists";

describe("parseArtistsJson", () => {
  it("returns the string members of a JSON array", () => {
    expect(parseArtistsJson('["Alix Perez", "Monty"]')).toEqual(["Alix Perez", "Monty"]);
  });

  it("drops non-string members but keeps the strings", () => {
    expect(parseArtistsJson('["Alix Perez", 42, null, {"a":1}, "Monty"]')).toEqual([
      "Alix Perez",
      "Monty",
    ]);
  });

  it("returns an empty array for a non-array JSON value", () => {
    expect(parseArtistsJson('{"name":"Monty"}')).toEqual([]);
    expect(parseArtistsJson('"Monty"')).toEqual([]);
  });

  it("returns an empty array for malformed JSON (never throws)", () => {
    expect(parseArtistsJson("not json")).toEqual([]);
    expect(parseArtistsJson("")).toEqual([]);
  });
});

describe("toArtistSlug", () => {
  it("kebab-cases a plain name", () => {
    expect(toArtistSlug("Alix Perez")).toBe("alix-perez");
  });

  it("strips diacritics", () => {
    expect(toArtistSlug("Café Del Mar")).toBe("cafe-del-mar");
    expect(toArtistSlug("Röyksopp")).toBe("royksopp");
  });

  it("collapses any run of non-alphanumerics into a single hyphen", () => {
    expect(toArtistSlug("A.M.C")).toBe("a-m-c");
    expect(toArtistSlug("dBridge  &   Instra:mental")).toBe("dbridge-instra-mental");
  });

  it("trims leading and trailing hyphens", () => {
    expect(toArtistSlug("  !Distance!  ")).toBe("distance");
    expect(toArtistSlug("+++")).toBe("");
  });

  it("returns an empty string when nothing survives (caller supplies the id fallback)", () => {
    expect(toArtistSlug("！！！")).toBe("");
  });
});

describe("artistNeedsLook", () => {
  it("is true when any link is unreviewed (reviewedAt === null)", () => {
    expect(artistNeedsLook([{ reviewedAt: "2026-01-01" }, { reviewedAt: null }])).toBe(true);
  });

  it("is false when every link has been reviewed", () => {
    expect(artistNeedsLook([{ reviewedAt: "2026-01-01" }, { reviewedAt: "2026-02-02" }])).toBe(
      false,
    );
  });

  it("is false for an artist with no links at all", () => {
    expect(artistNeedsLook([])).toBe(false);
  });
});

describe("unreviewedSocials", () => {
  it("keeps only the unreviewed links, oldest-first by createdAt", () => {
    const rows = [
      { createdAt: "2026-03-01", reviewedAt: "2026-03-02", url: "reviewed" },
      { createdAt: "2026-02-01", reviewedAt: null, url: "b" },
      { createdAt: "2026-01-01", reviewedAt: null, url: "a" },
    ];

    expect(unreviewedSocials(rows).map((r) => r.url)).toEqual(["a", "b"]);
  });

  it("returns an empty array when nothing is fresh", () => {
    expect(unreviewedSocials([{ createdAt: "2026-01-01", reviewedAt: "2026-01-02" }])).toEqual([]);
  });
});

describe("assertHttpUrl", () => {
  it("returns the trimmed URL when it is a valid http(s) URL", () => {
    expect(assertHttpUrl("  https://example.com/artist  ")).toBe("https://example.com/artist");
    expect(assertHttpUrl("http://example.com")).toBe("http://example.com");
  });

  it("throws on an empty (or whitespace-only) URL", () => {
    expect(() => assertHttpUrl("   ")).toThrow(InvalidArtistSocialError);
  });

  it("throws on an unparseable URL", () => {
    expect(() => assertHttpUrl("not a url")).toThrow(InvalidArtistSocialError);
  });

  it("throws on an unsupported scheme", () => {
    expect(() => assertHttpUrl("ftp://example.com")).toThrow(InvalidArtistSocialError);
    expect(() => assertHttpUrl("javascript:alert(1)")).toThrow(InvalidArtistSocialError);
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
