import { describe, expect, it } from "vitest";
import { assertHttpUrl, InvalidArtistSocialError, parseArtistsJson, toArtistSlug } from "./artists";

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
