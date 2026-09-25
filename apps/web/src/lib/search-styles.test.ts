import { describe, expect, it } from "vitest";
import {
  anchorNames,
  normaliseStyleQuery,
  parseStyleQuery,
  SEARCH_STYLES,
  STYLE_ANCHORS_MAX,
  STYLE_ANCHORS_MIN,
  styleBySlug,
  styleMentionedIn,
  styleTracksPath,
} from "./search-styles";
import { slugify } from "@fluncle/contracts/util/galaxy-slug";

describe("the style lexicon", () => {
  it("keeps every slug unique and URL-safe", () => {
    const slugs = SEARCH_STYLES.map((style) => style.slug);

    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) {
      expect(slug).toMatch(/^[a-z][a-z-]*$/);
    }
  });

  it("gives every style 3–8 distinct anchors, each a real artist slug shape", () => {
    for (const style of SEARCH_STYLES) {
      expect(style.anchors.length).toBeGreaterThanOrEqual(STYLE_ANCHORS_MIN);
      expect(style.anchors.length).toBeLessThanOrEqual(STYLE_ANCHORS_MAX);
      expect(new Set(style.anchors).size).toBe(style.anchors.length);
      for (const anchor of style.anchors) {
        expect(slugify(anchor)).toBe(anchor);
      }
    }
  });

  it("never lets one alias name two styles, and every alias parses back to its own style", () => {
    const owner = new Map<string, string>();

    for (const style of SEARCH_STYLES) {
      for (const alias of style.aliases) {
        expect(owner.get(alias), alias).toBeUndefined();
        owner.set(alias, style.slug);
        expect(normaliseStyleQuery(alias)).toBe(alias);
        expect(parseStyleQuery(alias)?.slug).toBe(style.slug);
      }
    }
  });

  it("reads a style through case, punctuation and the filler around it", () => {
    expect(parseStyleQuery("Liquid")?.slug).toBe("liquid");
    expect(parseStyleQuery("  liquid   D&B ")?.slug).toBe("liquid");
    expect(parseStyleQuery("some liquid drum 'n' bass tunes")?.slug).toBe("liquid");
    expect(parseStyleQuery("NEURO")?.slug).toBe("neurofunk");
    expect(parseStyleQuery("neurofunk tracks")?.slug).toBe("neurofunk");
  });

  it("leaves sentences and mood words to the tiers that read sentences", () => {
    expect(parseStyleQuery("dark liquid with vocals")).toBeUndefined();
    expect(parseStyleQuery("liquid sky")).toBeUndefined();
    expect(parseStyleQuery("chilled")).toBeUndefined();
    expect(parseStyleQuery("dnb")).toBeUndefined();
  });

  it("finds a style mentioned anywhere, whole words only, for the empty state's nearest sound", () => {
    expect(styleMentionedIn("chilled liquid 174")?.slug).toBe("liquid");
    expect(styleMentionedIn("liquidity")).toBeUndefined();
  });

  it("looks a style up by its slug and builds its /tracks destination", () => {
    expect(styleBySlug(" Liquid ")?.label).toBe("Liquid");
    expect(styleBySlug("polka")).toBeUndefined();
    expect(styleTracksPath("neurofunk")).toBe("/tracks?sound=neurofunk");
  });
});

describe("anchorNames — the anchors a ranking went by, as a sentence reads them", () => {
  it("joins a short list and counts the rest by their noun", () => {
    expect(anchorNames(["Calibre"])).toBe("Calibre");
    expect(anchorNames(["Calibre", "LSB"])).toBe("Calibre and LSB");
    expect(anchorNames(["A", "B", "C", "D"])).toBe("A, B, C and D");
    expect(anchorNames(["A", "B", "C", "D", "E"])).toBe("A, B, C, D and 1 other artist");
    expect(anchorNames(["A", "B", "C", "D", "E", "F"])).toBe("A, B, C, D and 2 other artists");
  });
});
