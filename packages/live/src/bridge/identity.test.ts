import { describe, expect, test } from "bun:test";

import { type Finding, keyTonicPitchClass, normalizeText, resolveDeck } from "./identity.ts";

const ARCHIVE: Finding[] = [
  { artists: ["Technimatic"], bpm: 172.56, key: "G major", logId: "019.1.7X", title: "Strength" },
  {
    artists: ["Netsky"],
    bpm: 171.09,
    key: "C minor",
    logId: "011.1.6E",
    title: "I See The Future In Your Eyes",
  },
  { artists: ["Alix Perez"], bpm: 172.0, key: "A minor", logId: "007.2.3B", title: "Tinman" },
  { artists: ["Break"], bpm: 174.0, key: "F# minor", logId: "022.4.9K", title: "Heaven" },

  { artists: ["LSB"], bpm: null, key: null, logId: "031.5.2C", title: "Wilderness" },

  { artists: ["Etherwood"], bpm: 170.0, key: "D minor", logId: "040.6.1A", title: "Deadweight" },
];

describe("keyTonicPitchClass — Camelot map verified against the live decks", () => {
  test("5A resolves to C (Netsky deck)", () => {
    expect(keyTonicPitchClass("5A")).toBe(keyTonicPitchClass("C minor"));
    expect(keyTonicPitchClass("5A")).toBe(0);
  });

  test("6A resolves to G (Technimatic deck), tonic only — mode ignored", () => {
    expect(keyTonicPitchClass("6A")).toBe(7);

    expect(keyTonicPitchClass("6A")).toBe(keyTonicPitchClass("G major"));
  });

  test("accepts Classic notation and Fluncle scale text and enharmonics", () => {
    expect(keyTonicPitchClass("Gm")).toBe(7);
    expect(keyTonicPitchClass("A# minor")).toBe(keyTonicPitchClass("Bb minor"));
    expect(keyTonicPitchClass("F#")).toBe(keyTonicPitchClass("Gb major"));
  });

  test("a homoglyph key still parses (Cyrillic А in 5А)", () => {
    expect(keyTonicPitchClass("5А")).toBe(keyTonicPitchClass("5A"));
  });

  test("null / junk yields null", () => {
    expect(keyTonicPitchClass(null)).toBeNull();
    expect(keyTonicPitchClass("")).toBeNull();
    expect(keyTonicPitchClass("13A")).toBeNull();
  });
});

describe("normalizeText — OCR gotchas + descriptor rules", () => {
  test("drops a NEUTRAL descriptor (Original Mix)", () => {
    expect(normalizeText("Strength (Original Mix)")).toBe("strength");
  });

  test("PRESERVES a real descriptor (Remix / VIP) as identity", () => {
    expect(normalizeText("Deadweight (Some DJ Remix)")).toContain("remix");
    expect(normalizeText("Strength VIP")).toContain("vip");
  });

  test("strips a leading deck-badge punctuation bleed", () => {
    expect(normalizeText("- I See The Future In Your Eyes")).toBe("i see the future in your eyes");
  });

  test("folds accents and & <-> and, drops feat.", () => {
    expect(normalizeText("Déjà Vu")).toBe("deja vu");
    expect(normalizeText("You & Me")).toBe("you and me");
    expect(normalizeText("Strength feat. Someone")).toBe("strength");
  });
});

describe("resolveDeck — the two live decks", () => {
  test("Technimatic / Strength (Original Mix) / 174.00 / 6A -> 019.1.7X", () => {
    const m = resolveDeck(
      { artist: "Technimatic", bpm: 174.0, key: "6A", title: "Strength (Original Mix)" },
      ARCHIVE,
    );
    expect(m).not.toBeNull();
    expect(ARCHIVE[m?.index ?? -1]?.logId).toBe("019.1.7X");
  });

  test("Netsky / I See The Future… / 173.00 / homoglyph 5А -> 011.1.6E", () => {
    const m = resolveDeck(
      {
        artist: "Netsky",
        bpm: 173.0,
        key: "5А",
        title: "- I See The Future In Your Eyes (Original Mix)",
      },
      ARCHIVE,
    );
    expect(m).not.toBeNull();
    expect(ARCHIVE[m?.index ?? -1]?.logId).toBe("011.1.6E");
  });
});

describe("resolveDeck — the null rail", () => {
  test("a track absent from the archive resolves to null", () => {
    const m = resolveDeck(
      { artist: "Unknown Artist", bpm: 140, key: "8B", title: "Some Track That Is Not A Finding" },
      ARCHIVE,
    );
    expect(m).toBeNull();
  });

  test("empty title resolves to null", () => {
    expect(resolveDeck({ artist: "Netsky", title: "" }, ARCHIVE)).toBeNull();
  });
});

describe("resolveDeck — guards are optional (nullable archive)", () => {
  test("a finding with null bpm still matches on title+artist", () => {
    const m = resolveDeck({ artist: "LSB", bpm: 172.0, key: "9A", title: "Wilderness" }, ARCHIVE);
    expect(m).not.toBeNull();
    expect(ARCHIVE[m?.index ?? -1]?.logId).toBe("031.5.2C");
  });

  test("a finding with null key still matches on title+artist", () => {
    const m = resolveDeck({ artist: "LSB", title: "Wilderness" }, ARCHIVE);
    expect(m).not.toBeNull();
    expect(ARCHIVE[m?.index ?? -1]?.logId).toBe("031.5.2C");
  });

  test("bpm alone never rejects a strong title+artist match", () => {
    const m = resolveDeck(
      { artist: "Technimatic", bpm: 90.0, key: "6A", title: "Strength" },
      ARCHIVE,
    );
    expect(m).not.toBeNull();
    expect(ARCHIVE[m?.index ?? -1]?.logId).toBe("019.1.7X");
  });
});

describe("resolveDeck — a remix does NOT match the original", () => {
  test("Deadweight (Some DJ Remix) does not resolve to the original Deadweight", () => {
    const m = resolveDeck(
      { artist: "Etherwood", bpm: 170.0, key: "D minor", title: "Deadweight (Some DJ Remix)" },
      ARCHIVE,
    );

    if (m !== null) {
      expect(ARCHIVE[m.index]?.logId).not.toBe("040.6.1A");
    }
    expect(m).toBeNull();
  });

  test("the bare original still matches itself", () => {
    const m = resolveDeck(
      { artist: "Etherwood", bpm: 170.0, key: "D minor", title: "Deadweight" },
      ARCHIVE,
    );
    expect(m).not.toBeNull();
    expect(ARCHIVE[m?.index ?? -1]?.logId).toBe("040.6.1A");
  });
});
