import { describe, expect, it } from "vitest";

import { gateNoteText } from "./note";

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
