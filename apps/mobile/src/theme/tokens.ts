// The native Nostalgic Cosmos token adapter (RFC Unit 4).
// @fluncle/tokens is the canon (mirrors DESIGN.md). Web units don't port:
// - alpha-baked hex (#RRGGBBAA) → rgba() (RN cross-platform parsing is unreliable)
// - rem → px (×16); "Npx" passes through
// NativeWind classes read the hardcoded mirror in tailwind.config.js; inline +
// Reanimated styles read this typed adapter. Keep the two in sync.
import { colors as raw, radii as rawRadii, typography } from "@fluncle/tokens";
import { type TextStyle } from "react-native";

const REM = 16;

function size(value: string): number {
  return value.endsWith("px") ? parseFloat(value) : Math.round(parseFloat(value) * REM);
}

/** #RRGGBBAA → "rgba(r, g, b, a)"; plain #RRGGBB passes through. */
function toRgba(hex: string): string {
  const h = hex.replace("#", "");
  if (h.length !== 8) {
    return hex;
  }
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = parseInt(h.slice(6, 8), 16) / 255;
  return `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`;
}

export const color = {
  deepField: raw.deepField,
  dustLine: toRgba(raw.dustLine),
  dustVeil: toRgba(raw.dustVeil),
  eclipseGlow: raw.eclipseGlow,
  eclipseGold: raw.eclipseGold,
  goldVeil: toRgba(raw.goldVeil),
  inkOnGold: raw.inkOnGold,
  reentryRed: raw.reentryRed,
  ruleDark: raw.ruleDark,
  sleeveBlack: raw.sleeveBlack,
  stardust: raw.stardust,
  starlightCream: raw.starlightCream,
  tapeBlack: raw.tapeBlack,
  // Translucent Tape Black at 30% — DESIGN.md's Outline-button fill (the web canon
  // bakes it as #1716114d). Derived from the canonical tapeBlack so it can't drift.
  tapeBlackFill: toRgba(`${raw.tapeBlack}4d`),
} as const;

export const radius = {
  artwork: size(rawRadii.artwork),
  lg: size(rawRadii.lg),
  md: size(rawRadii.md),
  sm: size(rawRadii.sm),
} as const;

// Oxanium speaks for the brand + numerals; the system sans does the reading.
// NOTE (RFC Unit 0): fontVariant:['tabular-nums'] is a no-op on custom fonts on
// iOS (expo/expo#20048) — the Tabular Rule's real fix is a tnum-baked Oxanium
// subset. Until then, Android gets tabular figures; iOS falls back to default.
export const font = {
  body: {
    fontSize: size(typography.body.fontSize),
    fontWeight: "400",
    lineHeight: size(typography.body.fontSize) * typography.body.lineHeight,
  } satisfies TextStyle,
  display: {
    fontFamily: "Oxanium_800ExtraBold",
    letterSpacing: parseFloat(typography.display.letterSpacing) * REM,
  } satisfies TextStyle,
  label: {
    fontSize: size(typography.label.fontSize),
    fontWeight: "800",
  } satisfies TextStyle,
  numeric: {
    fontFamily: "Oxanium_400Regular",
    fontSize: size(typography.numeric.fontSize),
    fontVariant: ["tabular-nums"],
    letterSpacing: parseFloat(typography.numeric.letterSpacing) * REM,
  } satisfies TextStyle,
  title: {
    fontSize: size(typography.title.fontSize),
    fontWeight: "800",
    letterSpacing: parseFloat(typography.title.letterSpacing) * REM,
    lineHeight: size(typography.title.fontSize) * typography.title.lineHeight,
  } satisfies TextStyle,
} as const;

// The four galaxies (canon: @fluncle/contracts Galaxy union). Display names +
// the gold-tinted accent each gets in the archive lens.
export const galaxies = [
  { key: "astral", name: "Astral" },
  { key: "lunar", name: "Lunar" },
  { key: "nebular", name: "Nebular" },
  { key: "solar", name: "Solar" },
] as const;
