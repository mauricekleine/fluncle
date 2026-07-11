import { describe, expect, it } from "vitest";

import { gateNoteEcho, gateNoteText, scoreNoteEcho } from "./note";

// The WRITTEN-note voice gate (the sibling of gateObservationScript). It reuses the
// spoken gate's shared bans (banned identity words, earthly geography, the Dry
// Rule's no-exclamation-marks, no "we"-as-company) and adds the written note's own
// length bounds. A note lands straight on the public /log surface, so a violation
// hard-fails the store.

const GOOD = "Pure rolling menace, half-step and patient. That is why it is here.";

// gateNoteText throws an ApiError carrying the wire `code` on `.code` (the human
// message is separate). Capture the code so the assertions read against the same
// codes the handler reproduces.
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
    expect(gateNoteText(GOOD)).toBe(GOOD);
  });

  it("trims surrounding whitespace", () => {
    expect(gateNoteText(`  ${GOOD}  `)).toBe(GOOD);
  });

  it("throws no_note for a non-string", () => {
    expect(codeOf(() => gateNoteText(undefined))).toBe("no_note");
    expect(codeOf(() => gateNoteText(42))).toBe("no_note");
  });

  it("throws no_note for an empty / whitespace note", () => {
    expect(codeOf(() => gateNoteText(""))).toBe("no_note");
    expect(codeOf(() => gateNoteText("   "))).toBe("no_note");
  });

  it("throws note_too_short below the floor", () => {
    expect(codeOf(() => gateNoteText("Banger."))).toBe("note_too_short");
  });

  it("throws note_too_long over the public budget", () => {
    expect(codeOf(() => gateNoteText("a ".repeat(200)))).toBe("note_too_long");
  });

  it("rejects a banned identity word (voice_gate)", () => {
    expect(
      codeOf(() => gateNoteText("A clean transmission of rolling menace. That is why it is here.")),
    ).toBe("voice_gate");
  });

  it("rejects earthly geography — the cosmos replaces the map (voice_gate)", () => {
    expect(
      codeOf(() =>
        gateNoteText("A proper British roller, all menace and patience. That is why it is here."),
      ),
    ).toBe("voice_gate");
  });

  it("rejects an exclamation mark — the Dry Rule (voice_gate)", () => {
    expect(codeOf(() => gateNoteText("Pure rolling menace, half-step and patient. Banger!"))).toBe(
      "voice_gate",
    );
  });

  it('rejects "we"-as-company (voice_gate)', () => {
    expect(
      codeOf(() =>
        gateNoteText("We logged this one because the half-step menace is undeniable here."),
      ),
    ).toBe("voice_gate");
  });

  it("does not false-positive on 'signature' (whole-word match)", () => {
    const note = "Pure Calibre, the Signature sound, patient and rolling all the way down.";
    expect(gateNoteText(note)).toBe(note);
  });
});

// ── The ECHO gate — the anti-sameness rail on the vibe-neighbour layer ────────────
//
// The auto-note is authored with the notes of the finding's sonic neighbours in the
// prompt. That is the feature's whole risk: the neighbourhood is there to teach the
// region's register, NOT to be paraphrased, and a note that reads like every other note
// in its galaxy is worse than none. So the guardrail is mechanical.
//
// The neighbour notes below are REAL notes from the live archive (the ones the current
// corpus actually echoes each other with), and the candidates are the echo shapes that
// showed up when the layer was piloted.

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

    // "this is one of the" is five shared words and carries no editorial move.
    expect(echo.echoes).toBe(false);
  });

  it("has nothing to echo in an empty neighbourhood (the first note in a region)", () => {
    const echo = scoreNoteEcho("Pure rolling menace, half-step and patient.", []);

    expect(echo).toEqual({ echoes: false, logId: null, overlap: 0, phrase: "" });
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
