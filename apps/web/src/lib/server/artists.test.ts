// The pure helpers of the artist entity module (lib/server/artists.ts): the JSON parse of the
// raw `artists_json` names, the canonical slug mint, the certified-finding EXISTS fragment, the
// two review predicates the /admin board + attention count share, and the write-path URL guard.
// These carry no DB — they are exercised directly, no libSQL engine needed. The DB-backed paths
// (upsert/link/queue) mock `./db` against the real schema like labels.test.ts and are out of
// scope here; this file closes the pure-unit gap flagged by the coverage audit.
import { describe, expect, it } from "vitest";
import {
  artistHasCertifiedFindingSql,
  artistNeedsLook,
  assertHttpUrl,
  InvalidArtistSocialError,
  parseArtistsJson,
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

describe("artistHasCertifiedFindingSql", () => {
  it("interpolates the artist-id expression and requires a coordinate-bearing finding", () => {
    const sql = artistHasCertifiedFindingSql("a.artist_id");

    expect(sql).toContain("cta.artist_id = a.artist_id");
    expect(sql).toContain("cf.log_id is not null");
    expect(sql.trimStart().startsWith("exists (")).toBe(true);
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
