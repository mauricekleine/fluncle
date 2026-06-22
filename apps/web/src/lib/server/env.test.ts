import { describe, expect, it } from "vitest";

import { constantTimeEqual } from "./env";

// constantTimeEqual guards the admin Bearer comparison (adminRole, line ~190/196)
// and the OAuth-state signature check (verifySignedState, line ~299). Node's
// crypto.timingSafeEqual THROWS when the two buffers differ in length — a classic
// footgun that would turn an intended 401 into an unhandled 500. The wrapper's
// length guard must make every length-mismatch a clean `false`, never a throw and
// never a bypass.
describe("constantTimeEqual — length-mismatch safety", () => {
  const expected = "the-real-operator-token";

  it("returns false for an empty token (length mismatch, must not throw)", () => {
    expect(() => constantTimeEqual("", expected)).not.toThrow();
    expect(constantTimeEqual("", expected)).toBe(false);
  });

  it("returns false for a shorter-than-expected token (must not throw)", () => {
    const shorter = expected.slice(0, expected.length - 5);

    expect(() => constantTimeEqual(shorter, expected)).not.toThrow();
    expect(constantTimeEqual(shorter, expected)).toBe(false);
  });

  it("returns false for a longer-than-expected token (must not throw)", () => {
    const longer = `${expected}-with-extra-suffix`;

    expect(() => constantTimeEqual(longer, expected)).not.toThrow();
    expect(constantTimeEqual(longer, expected)).toBe(false);
  });

  it("returns false for an exact-length-but-wrong token (no bypass)", () => {
    const wrong = `${"x".repeat(expected.length - 1)}y`;

    expect(wrong.length).toBe(expected.length);
    expect(constantTimeEqual(wrong, expected)).toBe(false);
  });

  it("returns true only for an exact match", () => {
    expect(constantTimeEqual(expected, expected)).toBe(true);
  });

  it("treats two empty strings as equal (zero-length pair is not a mismatch)", () => {
    expect(() => constantTimeEqual("", "")).not.toThrow();
    expect(constantTimeEqual("", "")).toBe(true);
  });

  it("handles multibyte tokens whose char-length matches but byte-length differs", () => {
    // "é" is 2 bytes in UTF-8; "ee" is 2 bytes. A naive String.length guard would
    // see equal lengths and hand mismatched-byte-length buffers to timingSafeEqual
    // (a throw). The byte-buffer guard keeps it a clean false.
    expect(() => constantTimeEqual("é", "ee")).not.toThrow();
    expect(constantTimeEqual("é", "ee")).toBe(false);
  });
});
