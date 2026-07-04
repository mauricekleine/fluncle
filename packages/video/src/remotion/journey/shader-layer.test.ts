// Unit tests for the ShaderLayer backing-store sizing (the resolutionScale lever).
// Pure function — no Remotion/GL context needed.

import { expect, test } from "bun:test";

import { backingStoreSize } from "./shader-layer";

test("default (undefined) is byte-identical to the composition size", () => {
  expect(backingStoreSize(1080, 1920, undefined)).toEqual({ height: 1920, width: 1080 });
});

test("scale 1 is byte-identical (the zero-behaviour-change guarantee)", () => {
  expect(backingStoreSize(1080, 1920, 1)).toEqual({ height: 1920, width: 1080 });
});

test("scale 0.5 halves each dimension (≈4× fewer fragments)", () => {
  expect(backingStoreSize(1080, 1920, 0.5)).toEqual({ height: 960, width: 540 });
});

test("dimensions are rounded to positive integers", () => {
  const { width, height } = backingStoreSize(1081, 1921, 0.5);
  expect(Number.isInteger(width)).toBe(true);
  expect(Number.isInteger(height)).toBe(true);
  expect(width).toBe(541); // round(540.5)
  expect(height).toBe(961); // round(960.5)
});

test("out-of-range / invalid scales fall back to 1 (never a zero/negative backing store)", () => {
  expect(backingStoreSize(1080, 1920, 0)).toEqual({ height: 1920, width: 1080 });
  expect(backingStoreSize(1080, 1920, -0.5)).toEqual({ height: 1920, width: 1080 });
  expect(backingStoreSize(1080, 1920, Number.NaN)).toEqual({ height: 1920, width: 1080 });
  expect(backingStoreSize(1080, 1920, Infinity)).toEqual({ height: 1920, width: 1080 });
});

test("scale > 1 is clamped to 1 (no accidental supersampling blowup)", () => {
  expect(backingStoreSize(1080, 1920, 2)).toEqual({ height: 1920, width: 1080 });
});

test("a tiny scale never collapses a dimension below 1px", () => {
  expect(backingStoreSize(10, 10, 0.01)).toEqual({ height: 1, width: 1 });
});
