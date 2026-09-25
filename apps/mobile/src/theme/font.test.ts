import { font } from "@/theme/tokens";

function assertEqual<T>(actual: T, expected: T, message = "assertion failed"): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

const LOADED_FAMILIES = new Set([
  "Oxanium_400Regular",
  "Oxanium_800ExtraBold",
  "SpaceGrotesk_400Regular",
  "SpaceGrotesk_700Bold",
]);

assertEqual(font.display.fontFamily, "Oxanium_800ExtraBold", "display is Oxanium (brand)");
assertEqual(font.numeric.fontFamily, "Oxanium_400Regular", "numeric is Oxanium (numerals)");
assertEqual(font.body.fontFamily, "SpaceGrotesk_400Regular", "body reads in Space Grotesk 400");
assertEqual(font.title.fontFamily, "SpaceGrotesk_700Bold", "title reads in Space Grotesk 700");
assertEqual(font.label.fontFamily, "SpaceGrotesk_700Bold", "label reads in Space Grotesk 700");

for (const [role, style] of Object.entries(font)) {
  assertEqual(
    LOADED_FAMILIES.has(String(style.fontFamily)),
    true,
    `${role} names a loaded font family (${String(style.fontFamily)})`,
  );
}

for (const role of ["body", "title", "label"] as const) {
  assertEqual(
    "fontWeight" in font[role],
    false,
    `${role} sets no fontWeight (family is the weight)`,
  );
}
