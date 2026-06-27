// The factory palette — the canon 8-bit ramp (galaxy/earth/DESIGN.md) plus a
// minimal warm-dark METAL band the works need and the surface map didn't: a few
// tones for steel machinery and the conveyor belt, all on the Warm-Dark axis
// (DESIGN.md: "every black and neutral leans warm"). The factory is the
// underworld — the works under the ground — so it runs darker than Earth's soil,
// lit by the same one sun (gold marks only a station that is actively working).
//
// Canon note (One Sun Rule): gold is the light source, never a field. A station
// glows gold only while it is processing a finding; idle machines sit in warm
// steel. Cool hues (coolBlue/coolTeal) survive only as a sparing instrument
// glint, never a wash (Retint Rule).

import { palette } from "../palette";

export const factoryPalette = {
  ...palette,
  /** The conveyor tread — the dark band findings ride along. */
  belt: "#201f19",
  /** The lit lip of the belt, catching the overhead light. */
  beltLit: "#34322a",
  /** A belt slat / cleat marker, so the tread reads as moving. */
  beltSlat: "#15140f",
  /** Machine steel — the body of an idle station (warm-dark, a step below soil). */
  steel: "#262420",
  /** Steel in shadow / panel seams. */
  steelDim: "#181712",
  /** A lit steel edge under the overhead light. */
  steelLit: "#39362d",
} as const;

export type FactoryInk = keyof typeof factoryPalette;
