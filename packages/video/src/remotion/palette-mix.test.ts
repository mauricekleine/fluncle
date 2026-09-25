import { colors } from "@fluncle/tokens";
import { expect, test } from "bun:test";

import { luminance, saturation, warmth } from "./color";
import { paletteMix } from "./palette-mix";

const LOUD_COOL = "#1b5cff";

test("background stays warm + dark even with loud cool swatches", () => {
  const p = paletteMix([LOUD_COOL, "#0a0d12", "#dfe6ff"]);

  expect(luminance(p.background)).toBeLessThan(0.2);

  expect(warmth(p.background)).toBeGreaterThan(warmth(LOUD_COOL));
});

test("accent is the artwork's OWN most-chromatic swatch (no gold lean)", () => {
  const swatches = ["#3a3a3a", LOUD_COOL, "#6b7280"];
  const p = paletteMix(swatches);

  const mostChromatic = [...swatches].sort((a, b) => saturation(b) - saturation(a))[0];
  expect(p.accent).toBe(mostChromatic);
  expect(p.accent).toBe(LOUD_COOL);

  expect(p.accent).not.toBe(colors.eclipseGold);
  expect(warmth(p.accent)).toBeLessThan(0);
});

test("a warm sleeve yields a warm accent on its own (gold emerges, never forced)", () => {
  const p = paletteMix(["#2a1a0a", "#e8a33d", "#7a5a2a"]);
  expect(p.accent).toBe("#e8a33d");
  expect(warmth(p.accent)).toBeGreaterThan(0);
});

test("brand fallback when no usable swatches are supplied", () => {
  const expected = {
    accent: colors.eclipseGold,
    background: colors.deepField,
    glow: colors.eclipseGlow,
    ink: colors.starlightCream,
  };
  for (const input of [[], ["", "   "]]) {
    const p = paletteMix(input);
    expect(p.accent).toBe(expected.accent);
    expect(p.background).toBe(expected.background);
    expect(p.glow).toBe(expected.glow);
    expect(p.ink).toBe(expected.ink);
  }
});

test("ink stays a legible cream, and glow is lighter than the background", () => {
  const p = paletteMix([LOUD_COOL, "#0a0d12", "#dfe6ff"]);
  expect(luminance(p.ink)).toBeGreaterThan(0.6);
  expect(luminance(p.glow)).toBeGreaterThan(luminance(p.background));
});

test("backgroundDrift widens how far the background leans toward the darkest swatch", () => {
  const swatches = [LOUD_COOL, "#0a0d12", "#dfe6ff"];
  const tight = paletteMix(swatches, { backgroundDrift: 0 });
  const loose = paletteMix(swatches, { backgroundDrift: 0.5 });

  expect(tight.background).toBe(colors.deepField);
  expect(loose.background).not.toBe(colors.deepField);
});
