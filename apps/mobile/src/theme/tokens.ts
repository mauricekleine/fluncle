import { colors as raw, radii as rawRadii, typography } from "@fluncle/tokens";
import { type TextStyle } from "react-native";

const REM = 16;

function size(value: string): number {
  return value.endsWith("px") ? parseFloat(value) : Math.round(parseFloat(value) * REM);
}

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

  tapeBlackFill: toRgba(`${raw.tapeBlack}4d`),
} as const;

export const radius = {
  artwork: size(rawRadii.artwork),
  lg: size(rawRadii.lg),
  md: size(rawRadii.md),
  sm: size(rawRadii.sm),
} as const;

export const font = {
  body: {
    fontFamily: "SpaceGrotesk_400Regular",
    fontSize: size(typography.body.fontSize),
    lineHeight: size(typography.body.fontSize) * typography.body.lineHeight,
  } satisfies TextStyle,
  display: {
    fontFamily: "Oxanium_800ExtraBold",
    letterSpacing: parseFloat(typography.display.letterSpacing) * REM,
  } satisfies TextStyle,
  label: {
    fontFamily: "SpaceGrotesk_700Bold",
    fontSize: size(typography.label.fontSize),
  } satisfies TextStyle,
  numeric: {
    fontFamily: "Oxanium_400Regular",
    fontSize: size(typography.numeric.fontSize),
    fontVariant: ["tabular-nums"],
    letterSpacing: parseFloat(typography.numeric.letterSpacing) * REM,
  } satisfies TextStyle,
  title: {
    fontFamily: "SpaceGrotesk_700Bold",
    fontSize: size(typography.title.fontSize),
    letterSpacing: parseFloat(typography.title.letterSpacing) * REM,
    lineHeight: size(typography.title.fontSize) * typography.title.lineHeight,
  } satisfies TextStyle,
} as const;
