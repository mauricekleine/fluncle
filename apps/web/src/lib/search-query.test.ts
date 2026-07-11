import { describe, expect, it } from "vitest";
import { parseKey } from "./key-camelot";
import {
  isBareToken,
  keySpellings,
  parseCoordinate,
  parseSonicPhrase,
  toFtsMatch,
  tokenize,
} from "./search-query";

describe("parseCoordinate — tier 1, the jump", () => {
  it("reads a bare coordinate", () => {
    expect(parseCoordinate("004.7.2I")).toBe("004.7.2I");
  });

  it("reads the fluncle:// form the coordinate is quoted with everywhere else", () => {
    expect(parseCoordinate("fluncle://004.7.2I")).toBe("004.7.2I");
  });

  it("normalises case to the stored form", () => {
    expect(parseCoordinate("  004.7.2i ")).toBe("004.7.2I");
  });

  it("reads a mixtape coordinate (the F orbit)", () => {
    expect(parseCoordinate("012.F.03")).toBe("012.F.03");
  });

  it("declines anything that is not shaped like a coordinate", () => {
    for (const query of ["netsky", "004", "004.7", "4.7.2I", "004.7.2II", "a.b.c", ""]) {
      expect(parseCoordinate(query), query).toBeNull();
    }
  });
});

describe("tokenize / isBareToken — tier 3's gate", () => {
  it("splits on punctuation the way FTS5's unicode61 tokenizer does", () => {
    expect(tokenize("Nu:Tone")).toEqual(["nu", "tone"]);
    expect(tokenize('["Netsky","Montell2099"]')).toEqual(["netsky", "montell2099"]);
  });

  it("calls one word a bare token, and a sentence not", () => {
    expect(isBareToken("netsky")).toBe(true);
    expect(isBareToken("  Netsky  ")).toBe(true);
    expect(isBareToken("Andromedik tracks in A minor")).toBe(false);
  });
});

describe("parseSonicPhrase — the headline query, with no model in front of it", () => {
  it("reads every ordinary way of asking for neighbours", () => {
    for (const query of [
      "sounds like Nine Clouds",
      "tracks that sound like Nine Clouds",
      "songs like Nine Clouds",
      "similar to Nine Clouds",
      "anything that sounds like Nine Clouds",
      "like Nine Clouds",
    ]) {
      expect(parseSonicPhrase(query), query).toBe("Nine Clouds");
    }
  });

  // A compound query is two questions, and the second one is a FILTER. The regex declines it
  // so tier 4 can compile that half into columns — which is what puts a btree pre-filter in
  // front of the vector scan.
  it("declines a compound query and leaves it for the model", () => {
    for (const query of [
      "sounds like Nine Clouds but on Hospital Records",
      "similar to Nine Clouds in A minor",
      "like Nine Clouds under 172 bpm",
    ]) {
      expect(parseSonicPhrase(query), query).toBeNull();
    }
  });

  it("declines a query that is not asking for neighbours at all", () => {
    expect(parseSonicPhrase("netsky")).toBeNull();
    expect(parseSonicPhrase("Andromedik tracks in A minor")).toBeNull();
  });
});

describe("toFtsMatch — the injection boundary", () => {
  it("quotes every token and prefix-matches the last (the type-ahead affordance)", () => {
    expect(toFtsMatch("nine clouds")).toBe('"nine" "clouds"*');
  });

  // The degraded path drops the scaffolding words, because under OR a document matching two
  // throwaway words out-scores one matching the single word the query was about.
  it("ORs for the degraded path, and keeps only the words the query is ABOUT", () => {
    expect(toFtsMatch("Andromedik tracks in A minor", "or")).toBe('"andromedik" OR "minor"*');
  });

  it("keeps every token on the AND path — there, each word is a constraint", () => {
    expect(toFtsMatch("the fall")).toBe('"the" "fall"*');
  });

  it("keeps the tokens when a query is NOTHING but scaffolding", () => {
    expect(toFtsMatch("the the", "or")).toBe('"the" OR "the"*');
  });

  // THE ONE THAT MATTERS. FTS5's MATCH argument is a query LANGUAGE — a bind slot does not
  // make its operators inert, it just delivers them to the parser. So the expression is
  // rebuilt from scrubbed tokens, and there is no path from user text to an operator.
  it("neutralises every FTS5 operator a hostile query could reach for", () => {
    expect(toFtsMatch('netsky" OR title:x NEAR/2 (a b) -c ^d *')).toBe(
      '"netsky" "or" "title" "x" "near" "2" "a" "b" "c" "d"*',
    );
  });

  it("returns null when nothing survives (punctuation only) rather than an empty MATCH", () => {
    expect(toFtsMatch("!!! ---")).toBeNull();
  });
});

describe("keySpellings — one question, however it is spelled", () => {
  it("covers the enharmonics and the shorthand for a minor key", () => {
    const parsed = parseKey("A# minor");

    expect(parsed).not.toBeNull();
    expect(parsed && keySpellings(parsed).sort()).toEqual([
      "a# min",
      "a# minor",
      "bb min",
      "bb minor",
    ]);
  });

  it("asks the same question for Bb minor as for A# minor (they are one key)", () => {
    const sharp = parseKey("A# minor");
    const flat = parseKey("Bb minor");

    expect(sharp).not.toBeNull();
    expect(flat).not.toBeNull();
    expect(sharp && keySpellings(sharp).sort()).toEqual(flat && keySpellings(flat).sort());
  });

  it("keeps major and minor apart", () => {
    const major = parseKey("A major");

    expect(major).not.toBeNull();
    expect(major && keySpellings(major)).toContain("a major");
    expect(major && keySpellings(major)).not.toContain("a minor");
  });
});
