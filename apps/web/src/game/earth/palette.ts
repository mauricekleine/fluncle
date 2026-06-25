// The overworld palette — the canon 8-bit ramp (galaxy game / DESIGN.md) plus a
// minimal warm-dark SOIL band a top-down ground surface needs and the star map
// never did: three tones bridging Tape Black (#171611) and Cream Dim (#6e6657),
// all on the Warm-Dark axis (DESIGN.md: "every black and neutral leans warm").
//
// Canon note (Retint Rule): there is NO green-phosphor token. Cool hues survive
// only as minor counter-accents, never a field — so the CRT screen and the SSH
// terminal use the canon `coolTeal` as a dim ghost, and the recovered-CRT feel
// comes from scanlines + cream ink + a gold prompt, not a green wash. Everything
// else samples the shared `palette`, so the overworld and the galaxy read as one
// cosmos.

import { palette } from "../palette";

export const earthPalette = {
  ...palette,
  /** Overworld soil — the body of the walkable ground (warm-dark, between tapeBlack + creamDim). */
  ground: "#2b2a22",
  /** Soil shadow / dither well. */
  groundDim: "#1d1c16",
  /** A lit speck of soil — sparse texture so the ground isn't flat. */
  groundLit: "#3b3930",
} as const;

export type EarthInk = keyof typeof earthPalette;
