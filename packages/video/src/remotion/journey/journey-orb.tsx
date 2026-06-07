import { colors } from "@fluncle/tokens";
import { type CSSProperties } from "react";
import { withAlpha } from "../color";
import { useBass, useBeat } from "../hooks";
import { Eclipse } from "../primitives";
import { type CosmosPalette } from "../types";
import { useJourney, type UseJourneyOptions } from "./use-journey";

/**
 * A position + scale along the journey arc, in screen fractions. `x`/`y` are
 * 0..1 of the frame's width/height (0,0 is top-left, 1,1 is bottom-right);
 * `scale` multiplies the orb's base `size`. This is what a custom path function
 * returns and what the {from,to} preset interpolates between.
 */
export type OrbPlacement = {
  /** Horizontal center, 0..1 of frame width. */
  x: number;
  /** Vertical center, 0..1 of frame height. */
  y: number;
  /** Scale multiplier applied to `size`. */
  scale: number;
};

/**
 * A straight-line travel preset: the orb interpolates from `from` to `to` along
 * the eased journey arc, scaling from `scaleFrom` to `scaleTo`. The semi-headless
 * default; pass a custom `path` function instead for curved or audio-driven motion.
 */
export type OrbPath = {
  /** Start placement coordinates (scale comes from `scaleFrom`). */
  from: { x: number; y: number };
  /** End placement coordinates (scale comes from `scaleTo`). */
  to: { x: number; y: number };
  /** Scale at the start of the arc. Default 0.6 (approaching from afar). */
  scaleFrom?: number;
  /** Scale at the end of the arc. Default 1 (arrived, full size). */
  scaleTo?: number;
};

export type JourneyOrbProps = {
  /**
   * Base diameter of the orb in px before `scale` is applied. The clipping disc
   * and the default Eclipse surface both size to this. Default 520.
   */
  size?: number;
  /**
   * How the orb travels across the clip. Either a {from,to} fractional preset
   * (the orb crosses the frame along the eased arc) OR a custom function mapping
   * the eased arc (0..1) to an explicit {x, y, scale}. The function form is the
   * creative slot for curved, looping, or audio-displaced paths.
   * Default: rises from lower-center to upper-center, scaling 0.6 -> 1.
   */
  path?: OrbPath | ((arc: number) => OrbPlacement);
  /**
   * Journey clock options (phase split, easing) forwarded to useJourney so the
   * orb shares the same arc as every other vehicle. Default phases 0.15/0.85.
   */
  journey?: UseJourneyOptions;
  /**
   * Surface rendered inside the clipped disc. The creative render slot: pass
   * artwork, a kaleido passage, a dither field, etc. Defaults to the canon
   * grainy Eclipse look (the One Sun) when omitted.
   */
  children?: React.ReactNode;
  /**
   * Palette for the default Eclipse surface and the rim glow fallback. Ignored
   * for `rimColor` if that is set explicitly. Defaults to the brand palette.
   */
  palette?: Partial<CosmosPalette>;
  /**
   * Eclipse variant for the default surface: "limb" (lit crescent) or "sun"
   * (full burning disc). Ignored when `children` is provided. Default "sun"
   * (the travelling orb reads as the approaching hero sun).
   */
  variant?: "limb" | "sun";
  /**
   * Rim glow color around the disc. Defaults to Eclipse Gold (the One Sun Rule:
   * the orb is the single light source; keep this gold unless the artwork demands
   * a retint to Re-entry Red heat).
   */
  rimColor?: string;
  /**
   * Rim glow intensity 0..1: spread and opacity of the burning halo. Feed from
   * useBass/useBeat upstream for a swelling sun, or leave to the built-in
   * bassBreath. Default 0.85.
   */
  rimIntensity?: number;
  /**
   * Scale kick on each beat: peak extra scale added on the beat, decaying before
   * the next. 0 disables. Needs `beatGrid`. Default 0.06 (a subtle pulse).
   */
  beatPulse?: number;
  /**
   * Beat grid (ms offsets relative to clip start) for `beatPulse`. Pass
   * audio.beatGrid. Omitted = no beat pulse regardless of `beatPulse`.
   */
  beatGrid?: number[];
  /**
   * Slow scale breath driven by low-end energy: peak extra scale at full bass.
   * 0 disables. Needs `bassCurve`. Default 0.04 (the sun inhales on the sub).
   */
  bassBreath?: number;
  /**
   * Bass curve for `bassBreath` (and the default rim swell). Pass audio.bassCurve.
   * Omitted = no bass breath and a static rim.
   */
  bassCurve?: { timeMs: number; energy: number }[];
  /** Extra styles merged onto the absolutely-positioned orb wrapper. */
  style?: CSSProperties;
};

const DEFAULT_PATH: OrbPath = {
  from: { x: 0.5, y: 0.66 },
  scaleFrom: 0.6,
  scaleTo: 1,
  to: { x: 0.5, y: 0.4 },
};

const resolvePlacement = (path: JourneyOrbProps["path"], arc: number): OrbPlacement => {
  if (typeof path === "function") {
    return path(arc);
  }
  const p = path ?? DEFAULT_PATH;
  const scaleFrom = p.scaleFrom ?? 0.6;
  const scaleTo = p.scaleTo ?? 1;
  return {
    scale: scaleFrom + (scaleTo - scaleFrom) * arc,
    x: p.from.x + (p.to.x - p.from.x) * arc,
    y: p.from.y + (p.to.y - p.from.y) * arc,
  };
};

/**
 * The orb vehicle: a clipped disc that travels across the clip along the journey
 * arc, scaling as it approaches and arrives. The surface inside the disc is a
 * render slot (default: the canon grainy Eclipse). Owns GEOMETRY (the disc, the
 * path), MOTION (arc travel, beatPulse, bassBreath), and BRAND LAW (Eclipse Gold
 * rim default, grain via Eclipse, determinism). The consuming agent owns the
 * surface (children) and the path function.
 *
 * Moodboard: posted/rainy-days.jpg (the gold moon), crt-mandala-burst (gold-core
 * radial burst), the founding sun. The One Sun Rule: this is the single light
 * source; keep the rim gold.
 *
 * Pure and deterministic: position and scale derive from the journey clock and
 * the audio hooks only; the only randomness is the Eclipse's seeded grain.
 */
export const JourneyOrb: React.FC<JourneyOrbProps> = ({
  size = 520,
  path,
  journey,
  children,
  palette,
  variant = "sun",
  rimColor = colors.eclipseGold,
  rimIntensity = 0.85,
  beatPulse = 0.06,
  beatGrid,
  bassBreath = 0.04,
  bassCurve,
  style,
}) => {
  const { arc } = useJourney(journey);

  // Audio-reactive scale modifiers, each gated on its source data being present.
  const { pulse } = useBeat(beatGrid ?? []);
  const beatKick = beatGrid && beatGrid.length > 0 ? pulse * beatPulse : 0;

  const bass = useBass(bassCurve ?? []);
  const breath = bassCurve && bassCurve.length > 0 ? bass * bassBreath : 0;

  const placement = resolvePlacement(path, arc);
  const effectiveScale = placement.scale * (1 + beatKick + breath);
  const px = size * effectiveScale;

  // The rim glow heats with bass when a curve is present, else stays at rimIntensity.
  const glowStrength =
    bassCurve && bassCurve.length > 0
      ? Math.min(1, rimIntensity * (0.7 + bass * 0.6))
      : rimIntensity;

  return (
    <div
      aria-hidden
      style={{
        height: px,
        left: `${placement.x * 100}%`,
        pointerEvents: "none",
        position: "absolute",
        top: `${placement.y * 100}%`,
        transform: "translate(-50%, -50%)",
        width: px,
        ...style,
      }}
    >
      {/* Burning rim halo around the disc (the One Sun glow), behind the surface. */}
      <div
        style={{
          background: `radial-gradient(circle at 50% 50%,
            ${withAlpha(rimColor, 0.45 * glowStrength)} 52%,
            ${withAlpha(rimColor, 0.22 * glowStrength)} 66%,
            ${withAlpha(rimColor, 0)} 80%)`,
          borderRadius: "50%",
          height: px * 1.9,
          left: "50%",
          position: "absolute",
          top: "50%",
          transform: "translate(-50%, -50%)",
          width: px * 1.9,
        }}
      />
      {/* The clipped disc: the surface render slot. */}
      <div
        style={{
          alignItems: "center",
          borderRadius: "50%",
          display: "flex",
          inset: 0,
          justifyContent: "center",
          overflow: "hidden",
          position: "absolute",
        }}
      >
        {children ?? (
          <Eclipse size={px} palette={palette} variant={variant} rimIntensity={glowStrength} />
        )}
      </div>
    </div>
  );
};
