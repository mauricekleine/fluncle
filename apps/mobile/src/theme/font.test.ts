// Self-running checks for the font role→family map — no framework, mirroring
// submit-fault.test.ts's node:assert-free style (the Expo tsconfig has no
// @types/node). Run via `bun test` (reports "0 pass" — no describe/it blocks — but
// throws and fails the process on any failed assertion) or `bun src/theme/font.test.ts`.
//
// This pins the DESIGN.md typography canon as mobile mirrors it: Oxanium speaks for
// the brand (display) + numerals (numeric); Space Grotesk carries the reading
// (body/title/label). It also guards the two RN traps this swap turns on:
//  1. RN synthesizes no weights — a role naming a family the app never loaded in
//     _layout.tsx silently falls back to the system font. Every family named here
//     MUST be one of the four cuts useFonts loads.
//  2. 700 is Space Grotesk's ceiling (DESIGN.md) — a reading role asking for the
//     old system-font 800 would resolve to no real face. So the reading roles carry
//     NO fontWeight: the weight-specific family name IS the weight.

import { font } from "@/theme/tokens";

function assertEqual<T>(actual: T, expected: T, message = "assertion failed"): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

// The exact set of families loaded by useFonts in app/_layout.tsx. A role naming
// anything outside this set would fall back to the system font at runtime.
const LOADED_FAMILIES = new Set([
  "Oxanium_400Regular",
  "Oxanium_800ExtraBold",
  "SpaceGrotesk_400Regular",
  "SpaceGrotesk_700Bold",
]);

// 1. The role→family map is exactly the DESIGN.md assignment.
assertEqual(font.display.fontFamily, "Oxanium_800ExtraBold", "display is Oxanium (brand)");
assertEqual(font.numeric.fontFamily, "Oxanium_400Regular", "numeric is Oxanium (numerals)");
assertEqual(font.body.fontFamily, "SpaceGrotesk_400Regular", "body reads in Space Grotesk 400");
assertEqual(font.title.fontFamily, "SpaceGrotesk_700Bold", "title reads in Space Grotesk 700");
assertEqual(font.label.fontFamily, "SpaceGrotesk_700Bold", "label reads in Space Grotesk 700");

// 2. Every role names a family the app actually loads (no silent system fallback).
for (const [role, style] of Object.entries(font)) {
  assertEqual(
    LOADED_FAMILIES.has(String(style.fontFamily)),
    true,
    `${role} names a loaded font family (${String(style.fontFamily)})`,
  );
}

// 3. No reading role carries a fontWeight — RN would honour the weight-specific
//    family, and an 800 would name a cut Space Grotesk does not ship (700 is its
//    ceiling). The family name is the weight. (`in` keeps this type-safe: the token
//    literal types omit fontWeight by construction, which is exactly the guarantee.)
for (const role of ["body", "title", "label"] as const) {
  assertEqual(
    "fontWeight" in font[role],
    false,
    `${role} sets no fontWeight (family is the weight)`,
  );
}
