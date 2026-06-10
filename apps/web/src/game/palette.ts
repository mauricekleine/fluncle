// The canon-anchored 8-bit ramp (docs/galaxy-game.md, "Look & sound").
//
// A small NES-style palette built from DESIGN.md: warm blacks, a Starlight
// Cream ramp, an Eclipse Gold ramp, Re-entry Red heat, and two dim cool
// counter-accents sanctioned by the Retint Rule (minor accents, never a
// field). Everything on screen samples from this object — no ad hoc colors.

export const palette = {
  /** Retint counter-accent: Earth's seas, the rare cold detail. */
  coolBlue: "#46527a",
  /** Retint counter-accent: dim teal for special entities, used sparingly. */
  coolTeal: "#3a5f5c",
  cream: "#f4ead7",
  creamBright: "#fffbf2",
  creamDim: "#6e6657",
  creamMuted: "#b7ab95",
  /** The night sky; the body of every frame. */
  deepField: "#090a0b",
  dustLine: "#d0b99029",
  dustVeil: "#d0b9901a",
  gold: "#f5b800",
  goldBright: "#ffd057",
  goldDeep: "#7a5c00",
  goldDim: "#b88a00",
  inkOnGold: "#151006",
  red: "#ff6b57",
  redBright: "#ffa18f",
  redDeep: "#7a2418",
  redDim: "#b23c2e",
  sleeveBlack: "#10100d",
  tapeBlack: "#171611",
} as const;

export type PaletteColor = (typeof palette)[keyof typeof palette];
