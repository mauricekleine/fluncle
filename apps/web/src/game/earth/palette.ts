// The overworld palette — the canon 8-bit ramp (galaxy game / DESIGN.md) plus a
// few overworld-derived tones a top-down ground surface needs and the star map
// never did: a warm-dark SOIL band bridging the gap between Tape Black (#171611)
// and Cream Dim (#6e6657), and a single sparing green PHOSPHOR for the CRT
// screen (the Retint Rule sanctions a dim cool accent used as a detail, never a
// field — the CRT is the only place it appears). Everything else samples the
// shared `palette`, so the overworld and the galaxy read as one cosmos.

import { palette } from "../palette";

export const earthPalette = {
  ...palette,
  /** Overworld soil — the body of the walkable ground (warm-dark, between tapeBlack + creamDim). */
  ground: "#2b2a22",
  /** Soil shadow / dither well. */
  groundDim: "#1d1c16",
  /** A lit speck of soil — sparse texture so the ground isn't flat. */
  groundLit: "#3b3930",
  /** CRT green-phosphor glow — the one off-ramp accent, CRT screen only. */
  phosphor: "#74e0a8",
  /** Its scanline shadow. */
  phosphorDim: "#2f6f54",
} as const;

export type EarthInk = keyof typeof earthPalette;
