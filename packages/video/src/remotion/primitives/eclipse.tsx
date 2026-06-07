import { colors } from "@fluncle/tokens";
import { type CosmosPalette } from "../types";
import { mix, withAlpha } from "../color";
import { Grain } from "./grain";

export type EclipseProps = {
  /** Diameter of the orb in px. Default 520. */
  size?: number;
  /**
   * Palette to draw from. The orb body uses accent/glow; the rim is the bright
   * limb. Defaults to the full brand palette (the one-sun moment).
   */
  palette?: Partial<CosmosPalette>;
  /**
   * Brightness of the bright rim / limb, 0..1. The signature "burning eclipse"
   * edge. Drive this with useBass/useBeat for a swelling sun. Default 0.85.
   */
  rimIntensity?: number;
  /** Grain opacity layered over the orb, 0..1. Default 0.1. */
  grainAmount?: number;
  /** Deterministic seed for the orb's grain. Default 7. */
  seed?: number;
  /**
   * Eclipse style. "limb" is a lit planet limb (bright crescent rim, dark body).
   * "sun" is a full burning disc (bright center bleeding to rim). Default "limb"
   * to match the cover's eclipse; "sun" is the brighter one-sun hero variant.
   */
  variant?: "limb" | "sun";
};

/**
 * The brand's signature grainy gradient orb: a radial gradient built from the
 * palette with a bright rim like a sun eclipse / planet limb.
 *
 * This is the single light source of the system (DESIGN.md, The One Sun Rule).
 * Compose exactly one per piece. Grain is baked over the orb so it sits in the
 * same texture as everything else.
 *
 * Pure: no randomness beyond the seeded grain, no wall clock. Animate it from
 * the outside by feeding rimIntensity from the audio hooks.
 */
export const Eclipse: React.FC<EclipseProps> = ({
  size = 520,
  palette,
  rimIntensity = 0.85,
  grainAmount = 0.1,
  seed = 7,
  variant = "limb",
}) => {
  const accent = palette?.accent ?? colors.eclipseGold;
  const glow = palette?.glow ?? colors.eclipseGlow;
  const background = palette?.background ?? colors.deepField;

  // The rim color heats from accent toward glow as rimIntensity rises.
  const rim = mix(accent, glow, Math.min(1, rimIntensity));
  const rimAlpha = 0.4 + rimIntensity * 0.6;

  // A warm dark body so the eclipse reads as an occluded disc, not a flat circle.
  const bodyDark = mix(background, accent, 0.08);

  const body =
    variant === "sun"
      ? // Burning disc: bright glow core bleeding outward to the rim.
        `radial-gradient(circle at 50% 50%,
          ${withAlpha(glow, 0.95)} 0%,
          ${withAlpha(accent, 0.9)} 28%,
          ${withAlpha(mix(accent, colors.reentryRed, 0.35), 0.75)} 62%,
          ${withAlpha(rim, rimAlpha)} 82%,
          ${withAlpha(rim, 0)} 100%)`
      : // Lit limb: dark body, bright crescent rim biased to the upper-left light.
        `radial-gradient(circle at 38% 36%,
          ${withAlpha(rim, rimAlpha)} 0%,
          ${withAlpha(rim, rimAlpha * 0.5)} 8%,
          ${withAlpha(bodyDark, 0.96)} 34%,
          ${withAlpha(bodyDark, 0.98)} 78%,
          ${withAlpha(mix(bodyDark, accent, 0.18), 0.9)} 100%)`;

  // Outer atmospheric glow bleed (the burning halo), sized beyond the disc.
  const halo = `radial-gradient(circle at 50% 50%,
    ${withAlpha(glow, 0.22 * rimIntensity)} 0%,
    ${withAlpha(accent, 0.12 * rimIntensity)} 40%,
    ${withAlpha(accent, 0)} 70%)`;

  return (
    <div
      aria-hidden
      style={{
        height: size,
        pointerEvents: "none",
        position: "relative",
        width: size,
      }}
    >
      {/* Atmospheric halo, larger than the disc. */}
      <div
        style={{
          background: halo,
          borderRadius: "50%",
          height: size * 1.9,
          left: "50%",
          position: "absolute",
          top: "50%",
          transform: "translate(-50%, -50%)",
          width: size * 1.9,
        }}
      />
      {/* The disc itself. */}
      <div
        style={{
          background: body,
          borderRadius: "50%",
          inset: 0,
          overflow: "hidden",
          position: "absolute",
        }}
      >
        <Grain opacity={grainAmount} seed={seed} intensity={1.1} blendMode="soft-light" />
      </div>
    </div>
  );
};
