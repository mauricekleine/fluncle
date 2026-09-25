import { describe, expect, it } from "vitest";

import { gateNoteEcho, gateNoteText, scoreNoteEcho } from "./note";

const GOOD = "Pure rolling menace, half-step and patient. That is why it is here.";

const NO_NAMES: readonly string[] = [];

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code ?? "(no code)";
  }

  return "(did not throw)";
}

describe("gateNoteText", () => {
  it("passes a clean, dry editorial note", () => {
    expect(gateNoteText(GOOD, NO_NAMES)).toBe(GOOD);
  });

  it("trims surrounding whitespace", () => {
    expect(gateNoteText(`  ${GOOD}  `, NO_NAMES)).toBe(GOOD);
  });

  it("throws no_note for a non-string", () => {
    expect(codeOf(() => gateNoteText(undefined, NO_NAMES))).toBe("no_note");
    expect(codeOf(() => gateNoteText(42, NO_NAMES))).toBe("no_note");
  });

  it("throws no_note for an empty / whitespace note", () => {
    expect(codeOf(() => gateNoteText("", NO_NAMES))).toBe("no_note");
    expect(codeOf(() => gateNoteText("   ", NO_NAMES))).toBe("no_note");
  });

  it("throws note_too_short below the floor", () => {
    expect(codeOf(() => gateNoteText("Banger.", NO_NAMES))).toBe("note_too_short");
  });

  it("throws note_too_long over the public budget", () => {
    expect(codeOf(() => gateNoteText("a ".repeat(200), NO_NAMES))).toBe("note_too_long");
  });

  it("rejects a banned identity word (voice_gate)", () => {
    expect(
      codeOf(() =>
        gateNoteText("A clean transmission of rolling menace. That is why it is here.", NO_NAMES),
      ),
    ).toBe("voice_gate");
  });

  it("rejects earthly geography — the cosmos replaces the map (voice_gate)", () => {
    expect(
      codeOf(() =>
        gateNoteText(
          "A proper British roller, all menace and patience. That is why it is here.",
          NO_NAMES,
        ),
      ),
    ).toBe("voice_gate");
  });

  it("rejects an exclamation mark — the Dry Rule (voice_gate)", () => {
    expect(
      codeOf(() => gateNoteText("Pure rolling menace, half-step and patient. Banger!", NO_NAMES)),
    ).toBe("voice_gate");
  });

  it('rejects "we"-as-company (voice_gate)', () => {
    expect(
      codeOf(() =>
        gateNoteText(
          "We logged this one because the half-step menace is undeniable here.",
          NO_NAMES,
        ),
      ),
    ).toBe("voice_gate");
  });

  it("does not false-positive on 'signature' (whole-word match)", () => {
    const note = "Pure Calibre, the Signature sound, patient and rolling all the way down.";
    expect(gateNoteText(note, NO_NAMES)).toBe(note);
  });
});

describe("gateNoteText — the name exemption", () => {
  const FUTURE_SIGNAL = ["Future Signal", "Fractals"];

  it("lets a note NAME an artist whose name carries a banned word", () => {
    const note = "Future Signal at their most patient, and the break still lands late enough.";

    expect(gateNoteText(note, FUTURE_SIGNAL)).toBe(note);
  });

  it("lets a note NAME a title whose name carries a banned word", () => {
    const note = "Anomaly Detected is the one that stuck; the drums arrive already sure of it.";

    expect(gateNoteText(note, ["Rockwell", "Anomaly Detected"])).toBe(note);
  });

  it("STILL rejects the same banned word used generically in the body", () => {
    expect(
      codeOf(() =>
        gateNoteText(
          "Future Signal at their most patient, and the signal underneath never lets up.",
          FUTURE_SIGNAL,
        ),
      ),
    ).toBe("voice_gate");
  });

  it("STILL rejects every other ban with the name exempt (geography, the Dry Rule, 'we')", () => {
    expect(
      codeOf(() =>
        gateNoteText("Future Signal doing what British rollers do, patient all the way.", [
          "Future Signal",
        ]),
      ),
    ).toBe("voice_gate");
    expect(
      codeOf(() =>
        gateNoteText("Future Signal at their most patient and it still knocks me sideways!", [
          "Future Signal",
        ]),
      ),
    ).toBe("voice_gate");
    expect(
      codeOf(() =>
        gateNoteText("We keep Future Signal close because the break lands late every time.", [
          "Future Signal",
        ]),
      ),
    ).toBe("voice_gate");
  });

  it("rejects a PARTIAL reference — the exemption is the FULL name, not the word in it", () => {
    expect(
      codeOf(() =>
        gateNoteText("Signal at their most patient, and the break still lands late enough.", [
          "Future Signal",
        ]),
      ),
    ).toBe("voice_gate");
  });

  it("does not let a SHORT name amnesty a longer banned word it sits inside", () => {
    expect(
      codeOf(() =>
        gateNoteText("Sign made this, and the signal underneath never lets up all the way.", [
          "Sign",
        ]),
      ),
    ).toBe("voice_gate");
  });

  it("REFUSES a name that is EXACTLY a banned word — that would be a total amnesty", () => {
    expect(
      codeOf(() =>
        gateNoteText("Signal made this one, and the signal underneath never lets up.", ["Signal"]),
      ),
    ).toBe("voice_gate");
    expect(
      codeOf(() =>
        gateNoteText("Every transmission after it sounds thinner than this one does.", [
          "Transmission",
        ]),
      ),
    ).toBe("voice_gate");
  });

  it("REFUSES a name that is EXACTLY a banned PLACE — the cosmos still replaces the map", () => {
    expect(
      codeOf(() =>
        gateNoteText("London is the tune, and the London air is all over the break.", ["London"]),
      ),
    ).toBe("voice_gate");
  });

  it("still exempts the multi-word names that carry their own context", () => {
    const note = "Future Signal made this one, and it still lands late enough to hurt.";

    expect(gateNoteText(note, ["Future Signal"])).toBe(note);
  });

  it("ignores a name with no word characters at all (it must not strip punctuation wholesale)", () => {
    expect(
      codeOf(() => gateNoteText("Pure rolling menace, half-step and patient. Banger!", ["!"])),
    ).toBe("voice_gate");
  });

  it("measures the LENGTH bounds on the whole note, name included", () => {
    expect(codeOf(() => gateNoteText(`${"a ".repeat(200)}Future Signal`, FUTURE_SIGNAL))).toBe(
      "note_too_long",
    );
  });
});

describe("scoreNoteEcho", () => {
  const NEIGHBORS = [
    {
      logId: "027.2.8R",
      note: "My shoulders dropped before the break even settled; Eternity earns it.",
    },
    {
      logId: "012.2.4L",
      note: "Liquid roller with nocturnal depth; I've been rewinding this Krakota banger since 2018.",
    },
  ];

  it("catches a LIFTED phrase — the borrowed move, verbatim", () => {
    const echo = scoreNoteEcho(
      "My shoulders dropped before I caught the title; that is Calibre doing what Calibre does.",
      NEIGHBORS,
    );

    expect(echo.echoes).toBe(true);
    expect(echo.logId).toBe("027.2.8R");
    expect(echo.phrase).toBe("my shoulders dropped before");
  });

  it("catches the RESHUFFLE — the same words in a new order (wholesale overlap)", () => {
    const echo = scoreNoteEcho(
      "Nocturnal, liquid, a roller with depth; rewinding this Krakota banger since 2018.",
      NEIGHBORS,
    );

    expect(echo.echoes).toBe(true);
    expect(echo.overlap).toBeGreaterThanOrEqual(0.3);
  });

  it("passes a note that says something else entirely", () => {
    const echo = scoreNoteEcho(
      "The bass sits in your chest before your brain catches up; Technimatic, 2025.",
      NEIGHBORS,
    );

    expect(echo.echoes).toBe(false);
  });

  it("does not fire on a shared run of pure function words (grammar is not an echo)", () => {
    const echo = scoreNoteEcho("This is one of the ones that stayed with me all winter.", [
      { logId: "011.1.3X", note: "This is one of the reasons S.P.Y still gets the first slot." },
    ]);

    expect(echo.echoes).toBe(false);
  });

  it("has nothing to echo in an empty neighbourhood (the first note in a region)", () => {
    const echo = scoreNoteEcho("Pure rolling menace, half-step and patient.", []);

    expect(echo).toEqual({ echoes: false, logId: null, note: "", overlap: 0, phrase: "" });
  });

  it("reports the WORST neighbour: a lift outranks every bare overlap", () => {
    const echo = scoreNoteEcho(
      "Liquid roller with nocturnal depth; the drums do the rest, 2019.",
      NEIGHBORS,
    );

    expect(echo.logId).toBe("012.2.4L");
    expect(echo.phrase).toBe("liquid roller with nocturnal depth");
  });
});

describe("gateNoteEcho", () => {
  it("throws `note_echoes_neighbours` on a lifted phrase, naming the neighbour", () => {
    let thrown: { code?: string; message?: string } = {};

    try {
      gateNoteEcho("I have been rewinding it since the first bar; this one stays.", [
        {
          logId: "004.5.6V",
          note: "Shoulders dropped on the first bar; Maya Randle rebuilt Wings in 2022 and I have been rewinding it since.",
        },
      ]);
    } catch (error) {
      thrown = error as { code?: string; message?: string };
    }

    expect(thrown.code).toBe("note_echoes_neighbours");
    expect(thrown.message).toContain("004.5.6V");
  });

  it("passes a distinct note straight through, returning its (clean) reading", () => {
    const echo = gateNoteEcho("Piano loops into your chest and the vocal keeps you there.", [
      { logId: "027.2.8R", note: "My shoulders dropped before the break even settled." },
    ]);

    expect(echo.echoes).toBe(false);
  });

  it("passes anything when there is no neighbourhood to echo (the layer is optional)", () => {
    expect(gateNoteEcho("Pure rolling menace, half-step and patient.", []).echoes).toBe(false);
  });
});

describe("the echo gate's tunable thresholds", () => {
  const NEIGHBORS = [
    { logId: "027.2.8R", note: "My shoulders dropped before the break even settled." },
  ];

  const LIFTS_FOUR = "My shoulders dropped before I knew the tune had turned.";

  it("rejects a four-word lift at the default, and lets it pass when the gate is loosened", () => {
    expect(scoreNoteEcho(LIFTS_FOUR, NEIGHBORS).echoes).toBe(true);

    const loosened = scoreNoteEcho(LIFTS_FOUR, NEIGHBORS, { maxOverlap: 1, minPhraseWords: 9 });

    expect(loosened.echoes).toBe(false);
  });

  it("tightening the overlap dial catches a note the default lets through", () => {
    const distinct = "Piano loops into your chest and the vocal keeps you there.";

    expect(scoreNoteEcho(distinct, NEIGHBORS).echoes).toBe(false);

    const tightened = scoreNoteEcho("The break settled and my shoulders dropped.", NEIGHBORS, {
      maxOverlap: 0.05,
      minPhraseWords: 20,
    });

    expect(tightened.echoes).toBe(true);
  });

  it("carries the echoed neighbour's own note, so a rejection can show the PAIR", () => {
    const echo = scoreNoteEcho(LIFTS_FOUR, NEIGHBORS);

    expect(echo.note).toBe("My shoulders dropped before the break even settled.");
    expect(echo.logId).toBe("027.2.8R");
    expect(echo.phrase).toBe("my shoulders dropped before");
  });
});
