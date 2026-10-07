import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArtistsJson } from "./artist-names";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseArtistsJson", () => {
  it("returns the stored artists in order", () => {
    expect(parseArtistsJson('["Netsky","Camo & Krooked"]')).toEqual(["Netsky", "Camo & Krooked"]);
    expect(parseArtistsJson("[]")).toEqual([]);
  });

  it("drops entries that are not strings", () => {
    expect(parseArtistsJson('["Netsky",null,42,{"name":"x"},["y"],"Hybrid Minds"]')).toEqual([
      "Netsky",
      "Hybrid Minds",
    ]);
  });

  it("returns no artists for valid JSON that is not an array, without warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    for (const value of ['"Netsky"', "null", "42", '{"artists":["Netsky"]}']) {
      expect(parseArtistsJson(value), value).toEqual([]);
    }

    expect(warn).not.toHaveBeenCalled();
  });

  it("returns no artists for malformed JSON and logs the parse failure", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(parseArtistsJson('["Netsky"')).toEqual([]);
    expect(parseArtistsJson("")).toEqual([]);

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('"event":"artists.parse-artists-json-failed"'),
    );
  });
});
