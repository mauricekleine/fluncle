import { describe, expect, test } from "bun:test";

import { parseDeriveCuesOutput, toReplaceCuesPayload } from "./cues";

// A realistic `rekordbox-derive-cues.py --json` payload: a matched cue (findingId
// set), a fuzzy match (flagged), an ambiguous one (findingId null), an unmatched
// one (findingId null), and a non-consecutive repeat (flagged). Shaped exactly as
// the script's json.dumps emits it (indent=2), including the flag metadata the
// board reads and the attach path strips.
const DERIVE_JSON = `${JSON.stringify(
  {
    applied: {},
    counts: { ambiguous: 1, fuzzy: 1, matched: 2, repeats: 1, unmatched: 1 },
    cues: [
      {
        artistsText: "Alix Perez, Monty",
        findingId: "007.8.1B",
        flagDetail: null,
        flaggedReason: null,
        fuzzy: false,
        matchBucket: "matched",
        position: 1,
        titleText: "Nova",
      },
      {
        artistsText: "Kanine",
        findingId: "018.5.7Y",
        flagDetail: null,
        flaggedReason: null,
        fuzzy: true,
        matchBucket: "matched",
        position: 2,
        titleText: "Feel It (Remix)",
      },
      {
        artistsText: "Unknown Artist",
        flagDetail: "011.2.3A, 011.2.3B",
        flaggedReason: null,
        fuzzy: false,
        matchBucket: "ambiguous",
        position: 3,
        titleText: "Two Versions",
      },
      {
        artistsText: "Some Dubplate",
        flagDetail: null,
        flaggedReason: null,
        fuzzy: false,
        matchBucket: "unmatched",
        position: 4,
        titleText: "No Finding Yet",
      },
      {
        artistsText: "Alix Perez, Monty",
        findingId: "007.8.1B",
        flagDetail: null,
        flaggedReason: "repeat",
        fuzzy: false,
        matchBucket: "matched",
        position: 5,
        titleText: "Nova",
      },
    ],
    inputRows: 7,
    mode: "dry-run",
    prunedConsecutive: 2,
    session: "2026-07-05 rave",
  },
  null,
  2,
)}`;

describe("parseDeriveCuesOutput", () => {
  test("parses the session, counts, and every cue with its provenance", () => {
    const parsed = parseDeriveCuesOutput(DERIVE_JSON);

    expect(parsed.session).toBe("2026-07-05 rave");
    expect(parsed.mode).toBe("dry-run");
    expect(parsed.inputRows).toBe(7);
    expect(parsed.prunedConsecutive).toBe(2);
    expect(parsed.cues).toHaveLength(5);
    expect(parsed.counts).toEqual({ ambiguous: 1, fuzzy: 1, matched: 2, repeats: 1, unmatched: 1 });
  });

  test("keeps findingId only on matched cues; ambiguous/unmatched carry none", () => {
    const parsed = parseDeriveCuesOutput(DERIVE_JSON);

    expect(parsed.cues[0]?.findingId).toBe("007.8.1B");
    expect(parsed.cues[1]?.fuzzy).toBe(true);
    expect(parsed.cues[2]?.findingId).toBeUndefined();
    expect(parsed.cues[2]?.matchBucket).toBe("ambiguous");
    expect(parsed.cues[3]?.findingId).toBeUndefined();
    expect(parsed.cues[3]?.matchBucket).toBe("unmatched");
    expect(parsed.cues[4]?.flaggedReason).toBe("repeat");
  });

  test("tolerates a stray leading/trailing line around the JSON object", () => {
    const noisy = `warming up the matcher…\n${DERIVE_JSON}\n`;

    expect(parseDeriveCuesOutput(noisy).cues).toHaveLength(5);
  });

  test("throws when the run printed no JSON object (a failed/empty derivation)", () => {
    expect(() => parseDeriveCuesOutput("error: the Rekordbox database is locked")).toThrow();
    expect(() => parseDeriveCuesOutput("")).toThrow();
  });

  test("throws when the object carries no cues array", () => {
    expect(() => parseDeriveCuesOutput('{"session":"x"}')).toThrow(/no cues/);
  });
});

describe("toReplaceCuesPayload (the round-trip to replace_recording_cues)", () => {
  test("keeps the honest write fields, strips provenance, and drops startMs", () => {
    const payload = toReplaceCuesPayload(parseDeriveCuesOutput(DERIVE_JSON));

    expect(payload).toHaveLength(5);
    expect(payload[0]).toEqual({
      artistsText: "Alix Perez, Monty",
      findingId: "007.8.1B",
      position: 1,
      titleText: "Nova",
    });
    // No provenance leaks into the write body.
    expect(payload[0]).not.toHaveProperty("matchBucket");
    expect(payload[0]).not.toHaveProperty("fuzzy");
    // startMs is absent — the operator marks each mix-in on the Studio cue rail.
    expect(payload[0]).not.toHaveProperty("startMs");
  });

  test("omits findingId on unmatched/ambiguous cues (a non-finding cue stays honest)", () => {
    const payload = toReplaceCuesPayload(parseDeriveCuesOutput(DERIVE_JSON));

    expect(payload[2]).not.toHaveProperty("findingId");
    expect(payload[3]).not.toHaveProperty("findingId");
  });

  test("reindexes positions 1..n so a preview always writes a gapless order", () => {
    const payload = toReplaceCuesPayload({
      cues: [
        {
          artistsText: "A",
          flagDetail: null,
          flaggedReason: null,
          fuzzy: false,
          matchBucket: "matched",
          position: 9,
          titleText: "one",
        },
        {
          artistsText: "B",
          flagDetail: null,
          flaggedReason: null,
          fuzzy: false,
          matchBucket: "matched",
          position: 40,
          titleText: "two",
        },
      ],
    });

    expect(payload.map((cue) => cue.position)).toEqual([1, 2]);
  });
});
