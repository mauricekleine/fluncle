// Regression tests for the CloseCard reveal timing — pins the "arc trap" fix:
// the reveal is driven ONLY by `progress`; a legacy `arc` is accepted but ignored.

import { expect, test } from "bun:test";

import { closeCardProgress, closeCardReveal } from "./close-card-timing";

test("closeCardProgress honours progress and clamps to 0..1", () => {
  expect(closeCardProgress(0)).toBe(0);
  expect(closeCardProgress(0.5)).toBe(0.5);
  expect(closeCardProgress(1)).toBe(1);
  expect(closeCardProgress(-1)).toBe(0);
  expect(closeCardProgress(2)).toBe(1);
});

test("closeCardProgress IGNORES the legacy arc (the trap)", () => {
  // A caller passing the journey's global arc (already ~0.8 mid-clip) must NOT
  // reveal the card when progress says the close hasn't begun.
  expect(closeCardProgress(0, 0.8)).toBe(0);
  expect(closeCardProgress(undefined, 0.8)).toBe(0);
  // When progress IS given, arc never overrides it.
  expect(closeCardProgress(0.2, 0.9)).toBe(0.2);
});

test("closeCardProgress treats undefined/NaN as hidden (0)", () => {
  expect(closeCardProgress(undefined)).toBe(0);
  expect(closeCardProgress(Number.NaN)).toBe(0);
});

test("closeCardReveal staggers: tagline settles before the signature", () => {
  const early = closeCardReveal(0.2);
  // At p=0.2 the tagline is rising while the signature has not begun.
  expect(early.taglineP).toBeGreaterThan(0);
  expect(early.signatureP).toBe(0);
  expect(early.taglineP).toBeGreaterThan(early.signatureP);
});

test("closeCardReveal endpoints: hidden at 0, both fully revealed at 1", () => {
  expect(closeCardReveal(0)).toEqual({ signatureP: 0, taglineP: 0 });
  expect(closeCardReveal(1)).toEqual({ signatureP: 1, taglineP: 1 });
});

test("closeCardReveal tagline reaches full before the signature does", () => {
  // Tagline maps p/0.65 → full at p=0.65; signature (p-0.3)/0.7 → full at p=1.0.
  const mid = closeCardReveal(0.65);
  expect(mid.taglineP).toBe(1);
  expect(mid.signatureP).toBeLessThan(1);
});
