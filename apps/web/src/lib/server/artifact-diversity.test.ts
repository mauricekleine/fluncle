import { describe, expect, it } from "vitest";

import {
  type Artifact,
  meanPairwiseOverlap,
  measureFamily,
  measureRegisters,
  nearestNeighbourLifts,
  stripLogbookProse,
  topPhrases,
  topWords,
} from "./artifact-diversity";

// The corpus-wide sameness harness — the family-scale sibling of the note echo gate.
// These pin the three measures on small synthetic corpora whose answers are hand-checkable,
// plus the logbook prose cleaner. The primitives underneath (echoWords / contentOverlap /
// scoreNoteEcho) are already pinned by note.test.ts; this pins the AGGREGATION on top.

const A = (id: string, text: string): Artifact => ({ id, text });

describe("meanPairwiseOverlap", () => {
  it("is 0 when every artifact shares no content words", () => {
    const { mean, max } = meanPairwiseOverlap([
      A("1", "rolling menace patient halfstep"),
      A("2", "bright liquid summer vocal"),
      A("3", "jungle amen breakbeat ragga"),
    ]);

    expect(mean).toBe(0);
    expect(max).toBe(0);
  });

  it("is 1 when the corpus is one text repeated", () => {
    const line = "the bass sits heavy in the chest and stays there all night";
    const { mean, max, maxPair } = meanPairwiseOverlap([A("1", line), A("2", line), A("3", line)]);

    expect(mean).toBeCloseTo(1, 5);
    expect(max).toBeCloseTo(1, 5);
    expect(maxPair).toHaveLength(2);
  });

  it("returns a zeroed reading for a corpus too small to have a pair", () => {
    expect(meanPairwiseOverlap([A("1", "solitary banger rolling")])).toEqual({
      max: 0,
      maxPair: [],
      mean: 0,
    });
  });

  it("names the single most-alike pair as maxPair", () => {
    const { maxPair } = meanPairwiseOverlap([
      A("twinA", "nocturnal liquid roller depth drums"),
      A("twinB", "nocturnal liquid roller depth drums patience"),
      A("odd", "bright euphoric vocal sunrise anthem"),
    ]);

    expect(new Set(maxPair)).toEqual(new Set(["twinA", "twinB"]));
  });
});

describe("topPhrases", () => {
  it("surfaces a phrase repeated across multiple artifacts with the right docFreq", () => {
    const corpus = [
      A("1", "that drop has a weight to it, like something shifting."),
      A("2", "the drop has a weight to it and it does not let go."),
      A("3", "honestly the drop has a weight to it that stays with you."),
      A("4", "a bright and airy roller, nothing like the others here."),
    ];

    const phrases = topPhrases(corpus, { maxN: 6, minDocFreq: 2, minN: 3, topK: 10 });
    const top = phrases[0];

    expect(top?.phrase).toContain("drop has a weight to it");
    expect(top?.docFreq).toBe(3);
  });

  it("ignores a phrase that only repeats WITHIN a single artifact (docFreq 1)", () => {
    const corpus = [
      A("1", "roll and roll and roll and roll it rolls forever downward"),
      A("2", "a completely different line about airy euphoric summer vocals"),
    ];

    // "and roll" repeats four times but in ONE artifact — not a family stock move.
    const phrases = topPhrases(corpus, { maxN: 6, minDocFreq: 2, minN: 3, topK: 10 });

    expect(phrases).toHaveLength(0);
  });

  it("suppresses a nested sub-phrase that never occurs outside its longer parent", () => {
    const line = "my shoulders dropped before the break even settled properly";
    const corpus = [A("1", line), A("2", line), A("3", `${line} tonight`)];

    const phrases = topPhrases(corpus, { maxN: 6, minDocFreq: 2, minN: 3, topK: 10 });

    // The long shared run is kept; the bare "my shoulders dropped" sub-run — which only
    // ever appears inside it — is not separately listed.
    expect(phrases.some((phrase) => phrase.n >= 5)).toBe(true);
    expect(phrases.some((phrase) => phrase.phrase === "my shoulders dropped")).toBe(false);
  });

  it("returns nothing when no phrase is shared across artifacts", () => {
    const corpus = [
      A("1", "rolling menace patient halfstep tune"),
      A("2", "bright liquid summer vocal anthem"),
    ];

    expect(topPhrases(corpus, { maxN: 6, minDocFreq: 2, minN: 3, topK: 10 })).toEqual([]);
  });
});

describe("topWords", () => {
  it("ranks the content words that recur across the most artifacts, ignoring one-offs", () => {
    const corpus = [
      A("1", "my shoulders dropped hard on the break"),
      A("2", "the break hit my shoulders again tonight"),
      A("3", "shoulders and chest, the whole thing rolls"),
      A("4", "a bright euphoric vocal, nothing bodily about it"),
    ];

    const words = topWords(corpus);
    const shoulders = words.find((entry) => entry.word === "shoulders");

    expect(shoulders?.docFreq).toBe(3);
    // A word appearing in only one artifact ("euphoric") is not a family stock word.
    expect(words.some((entry) => entry.word === "euphoric")).toBe(false);
  });
});

describe("nearestNeighbourLifts", () => {
  const CORPUS = [
    A("027.2.8R", "My shoulders dropped before the break even settled; Eternity earns it."),
    A("012.2.4L", "Liquid roller with nocturnal depth; I've been rewinding this since 2018."),
    A("clean", "The piano loops into your chest and the vocal keeps you there, 2025."),
    // Lifts a four-word run straight from 027.2.8R.
    A("echoer", "My shoulders dropped before I even knew the tune had turned over."),
  ];

  it("flags the artifact that lifts a phrase from a sibling, naming the neighbour", () => {
    const lifts = nearestNeighbourLifts(CORPUS);
    // A lift is symmetric — both ends of a shared phrase echo each other — so BOTH twins
    // are flagged; the clean one is not. The point is that `echoer` is caught and its
    // echo names the sibling it shares the run with.
    const echoer = lifts.find((lift) => lift.id === "echoer");

    expect(echoer).toBeDefined();
    expect(echoer?.echo.logId).toBe("027.2.8R");
    expect(echoer?.echo.phrase).toBe("my shoulders dropped before");
  });

  it("does not flag the artifact that says something else entirely", () => {
    const lifts = nearestNeighbourLifts(CORPUS);

    expect(lifts.some((lift) => lift.id === "clean")).toBe(false);
  });
});

describe("measureFamily", () => {
  it("bundles size, mean overlap, top phrases, and neighbour lifts", () => {
    const corpus = [
      A("1", "that drop has a weight to it, shifting beneath the surface."),
      A("2", "the drop has a weight to it, moving under the floor."),
      A("3", "a bright airy roller with a vocal that lifts the whole room."),
      A("empty", "   "),
    ];

    const reading = measureFamily("observations", corpus);

    expect(reading.family).toBe("observations");
    // The blank artifact is excluded from the denominator.
    expect(reading.size).toBe(3);
    expect(reading.meanPairwiseOverlap).toBeGreaterThan(0);
    expect(reading.topPhrases[0]?.phrase).toContain("drop has a weight to it");
    expect(reading.topWords.some((word) => word.word === "drop")).toBe(true);
    expect(reading.echoingCount).toBeGreaterThanOrEqual(1);
  });

  it("gives a clean zeroed reading for a family with a single artifact", () => {
    const reading = measureFamily("logbook", [A("1", "a lone entry with nothing to echo yet")]);

    expect(reading.size).toBe(1);
    expect(reading.meanPairwiseOverlap).toBe(0);
    expect(reading.maxPair).toEqual([]);
    expect(reading.topPhrases).toEqual([]);
    expect(reading.topWords).toEqual([]);
    expect(reading.echoingCount).toBe(0);
  });
});

describe("measureRegisters", () => {
  // The register cut is what makes the observations' worst homogenisation legible: the
  // formulaic closer, the "I…" opener, the "hope" crutch (the 2026-07-14 audit's hand-made
  // numbers, as a function). These pin it on a corpus whose answers are hand-checkable.
  const CORPUS = [
    A(
      "1",
      "I landed hard on this one and my knees went. Hope the crew rinses it. Enjoy, cosmonauts.",
    ),
    A(
      "2",
      "I clocked the drop late and it threw me sideways. Hope you rinse it. Enjoy, cosmonauts.",
    ),
    A("3", "The bass walked in on its own two feet. Tune in when you are ready, junglist."),
  ];

  it("counts the shared closer and opener runs by distinct artifact", () => {
    const registers = measureRegisters(CORPUS, { crutchWords: ["hope", "enjoy", "cosmonauts"] });

    expect(registers.size).toBe(3);
    // Two of three close on the exact formula — the "…enjoy cosmonauts" cut. The closer is
    // the LAST 3 words, so the shared run must be exact ("it enjoy cosmonauts" in both).
    expect(registers.closers[0]).toEqual({ docFreq: 2, phrase: "it enjoy cosmonauts" });
    // Two of three open on "I …" — the opening-word histogram catches the register.
    expect(registers.openingWords[0]).toEqual({ docFreq: 2, word: "i" });
  });

  it("reports each tracked crutch word's document frequency, in the order asked", () => {
    const registers = measureRegisters(CORPUS, { crutchWords: ["hope", "enjoy", "shoulders"] });

    expect(registers.crutches).toEqual([
      { docFreq: 2, word: "hope" },
      { docFreq: 2, word: "enjoy" },
      { docFreq: 0, word: "shoulders" },
    ]);
  });

  it("drops edge phrases that recur in only one artifact (a cadence is not a family tic)", () => {
    const registers = measureRegisters([
      A("1", "one of a kind opener here and a one of a kind closer here"),
      A("2", "another entirely different read that shares no edges with anything"),
    ]);

    expect(registers.openers).toEqual([]);
    expect(registers.closers).toEqual([]);
  });

  it("gives a clean zeroed reading for an empty family", () => {
    const registers = measureRegisters([]);

    expect(registers.size).toBe(0);
    expect(registers.openers).toEqual([]);
    expect(registers.closers).toEqual([]);
    expect(registers.openingWords).toEqual([]);
    expect(registers.crutches).toEqual([]);
  });
});

describe("stripLogbookProse", () => {
  it("drops [[logId]] figure tokens and markdown, keeping the prose", () => {
    const body = "Landed on *Sudden Change* early.\n\n[[004.6.8K]]\n\nThe drop has a weight to it.";
    const cleaned = stripLogbookProse(body);

    expect(cleaned).not.toContain("004.6.8K");
    expect(cleaned).not.toContain("[[");
    expect(cleaned).not.toContain("*");
    expect(cleaned).toContain("Sudden Change");
    expect(cleaned).toContain("The drop has a weight to it");
  });
});
