import { colors } from "@fluncle/tokens";
import { type CSSProperties } from "react";
import { AbsoluteFill } from "remotion";
import { withAlpha } from "../color";
import { useBass, useBeat } from "../hooks";
import { type CosmosPalette } from "../types";
import { GLSL } from "./glsl";
import { ShaderLayer } from "./shader-layer";
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
   * Surface rendered inside the clipped disc. When provided, this is composited
   * inside the disc clip and the GPU surface shader is NOT used — this is the
   * plate path (sampled artwork, a kaleido passage, a dither field, retinted
   * content). When omitted, the orb renders its rendered-grade GPU surface: an
   * SDF disc with an fbm-textured body, a hot fresnel limb, soft outer glow, and
   * grain baked INTO the material (the grain IS the surface, per the moodboard).
   */
  children?: React.ReactNode;
  /**
   * Palette for the GPU surface (and the rim glow fallback when children are
   * provided). Maps to the shader's u_palette ramp: background -> accent -> glow
   * -> ink, dark to light. Defaults to the brand palette.
   */
  palette?: Partial<CosmosPalette>;
  /**
   * Eclipse variant for the GPU surface: "limb" (a lit crescent / planet limb,
   * the body mostly in shadow with one burning edge) or "sun" (the full burning
   * disc lit across its face). Ignored when `children` is provided. Default
   * "sun" (the travelling orb reads as the approaching hero sun).
   */
  variant?: "limb" | "sun";
  /**
   * Rim glow color around the disc. Defaults to Eclipse Gold (the One Sun Rule:
   * the orb is the single light source; keep this gold unless the artwork demands
   * a retint to Re-entry Red heat).
   */
  rimColor?: string;
  /**
   * Rim glow intensity 0..1: spread and opacity of the burning halo, and the
   * brightness of the shader's fresnel limb. Feed from useBass/useBeat upstream
   * for a swelling sun, or leave to the built-in bassBreath. Default 0.85.
   */
  rimIntensity?: number;
  /**
   * Scale kick on each beat: peak extra scale added on the beat, decaying before
   * the next. 0 disables. Needs `beatGrid`. Default 0.06 (a subtle pulse). Also
   * feeds the GPU surface as a rim flare on the beat.
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
  /**
   * Light direction for the GPU surface's limb, in screen-space radians (0 =
   * light from the right, PI/2 = from below, etc.). The "limb" variant lights
   * the edge facing this direction; "sun" uses it for a subtle face gradient.
   * Default -2.2 (light from the upper-left, the founding image's sun). Only used
   * by the GPU surface (no children).
   */
  lightAngle?: number;
  /**
   * Grain baked into the GPU surface, 0..1: how strongly emulsion grain modulates
   * the orb body. This is the material grain (the grain IS the surface), separate
   * from the global <Grain /> overlay. Default 0.5. Only used by the GPU surface.
   */
  surfaceGrain?: number;
  /**
   * Surface texture detail for the GPU surface: fbm frequency of the body
   * texture. Higher = finer mottling (cratered moon); lower = broad soft
   * gradients (gas giant). Default 3.2. Only used by the GPU surface.
   */
  surfaceDetail?: number;
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

// The orb surface shader. Renders a rendered-grade celestial body into the
// (square) layer that wraps it: an SDF disc whose body is an fbm-textured
// material, a hot fresnel-style limb (a thin bright burning edge, exactly like a
// solar eclipse / planet limb), a soft outer glow with physical falloff, and
// emulsion grain baked INTO the surface so the grain reads as the material, not
// an overlay (the moodboard's "grain that IS the surface"). The disc sits in the
// center; everything outside it is transparent so the layer composites cleanly.
//
// Custom uniforms (declared below, fed from JourneyOrb):
//   u_rim      bright-limb intensity (0..~1.4), swells with bass/beat
//   u_lightAng light direction in radians for the limb
//   u_isSun    1.0 = full sun (face lit), 0.0 = limb (mostly shadow, one edge)
//   u_grainAmt baked surface-grain strength
//   u_detail   fbm frequency of the body texture
//   u_aspect   layer width/height, to keep the disc circular
const ORB_FRAG = /* glsl */ `
uniform float u_rim;
uniform float u_lightAng;
uniform float u_isSun;
uniform float u_grainAmt;
uniform float u_detail;
uniform float u_aspect;

${GLSL.hash}
${GLSL.valueNoise}
${GLSL.fbm}
${GLSL.paletteRamp}
${GLSL.filmGrain}

void main() {
  // Aspect-correct, centered coords: p in roughly [-1,1] across the shorter
  // axis, origin at the disc center. The disc has radius ~0.82 so the glow has
  // room to fall off inside the (square) layer before the edge.
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = (uv - 0.5) * 2.0;
  p.x *= u_aspect;

  float r = length(p);
  float radius = 0.78;

  // Light direction (screen space). The limb burns on the edge facing the light.
  vec2 L = vec2(cos(u_lightAng), sin(u_lightAng));
  // Surface-normal proxy for a sphere: the unit vector from center, used both for
  // the day/night terminator and the fresnel rim.
  vec2 n = r > 1e-4 ? p / r : vec2(0.0);
  float ndl = dot(n, L); // -1 (away from light) .. 1 (toward light)

  // --- Body texture: fbm IS the material -----------------------------------
  // Two domain-warped fbm layers give cratered/mottled relief; this is sampled
  // in the disc's local space and lit, so the texture reads as surface, not a
  // flat gradient. A slow time drift keeps it alive without strobing.
  vec2 sp = p * u_detail;
  float warp = fbm(sp * 0.7 + vec2(u_seed, u_time * 0.02), 4);
  float relief = fbm(sp + warp * 0.8 + vec2(u_time * 0.015, u_seed * 1.7), 6);
  // Center the relief around 0 so it both darkens and brightens the body.
  float mott = (relief - 0.5);

  // --- Shading the body -----------------------------------------------------
  // Spherical falloff: the body dims toward the limb (limb darkening) and, for
  // the "limb" variant, the unlit side falls into shadow along the terminator.
  float sphere = sqrt(max(0.0, 1.0 - min(r / radius, 1.0) * (r / radius)));
  // Day side strength: full across the face for a sun, terminator-shaped for a
  // limb. smoothstep gives a soft terminator instead of a hard line.
  float day = mix(smoothstep(-0.35, 0.55, ndl), 1.0, u_isSun);

  // Map the lit, mottled body through the palette ramp. The base sits warm-dark;
  // the lit face climbs into accent (Re-entry Red heat) up toward glow (Eclipse
  // Gold) but is CAPPED below the cream stop so the disc reads as a burning,
  // grainy body (the founding sun) rather than a washed-out white ball — only the
  // limb is allowed to reach the brightest stop. Mottling pushes the local tone
  // up/down so craters and seas read as the grain of the material itself.
  float lit = day * (0.42 + sphere * 0.22);
  float bodyT = clamp(
    0.30 + lit * 0.52 + mott * (0.40 + u_grainAmt * 0.40),
    0.0, 0.88
  );
  vec3 body = paletteRamp(bodyT);
  // A hot core bloom: the very center of the lit face glows a touch brighter,
  // additive toward glow, kept tight so it doesn't flatten into a disc of cream.
  float core = smoothstep(0.55, 0.0, r / radius) * day;
  body += (u_palette[2] - u_palette[1]) * core * 0.18;

  // --- The hot fresnel limb (the burning edge) ------------------------------
  // A thin bright ring hugging the disc edge: fresnel-style, narrow, and gated
  // to the lit side so it reads as a solar-eclipse / planet limb rather than a
  // uniform outline. Width tightens as the orb fills; brightness rides u_rim.
  float edge = smoothstep(radius, radius - 0.05, r) * smoothstep(radius - 0.16, radius - 0.04, r);
  float fres = pow(clamp(r / radius, 0.0, 1.0), 6.0);
  float limbGate = mix(smoothstep(-0.1, 0.7, ndl), 1.0, u_isSun * 0.55);
  float limb = edge * fres * limbGate;
  // The limb burns toward the brightest palette stops (glow -> ink), scaled by
  // u_rim so it swells on the bass/beat.
  vec3 limbCol = mix(u_palette[2], u_palette[3], 0.55);
  float rimAmt = limb * (0.9 + u_rim * 1.6);

  // --- Soft outer glow with falloff -----------------------------------------
  // Outside the disc, a physical-ish inverse glow: bright at the limb, falling
  // off smoothly into transparency. Tinted to the warm glow stop, swelling with
  // the rim. This is the One Sun halo, drawn in-shader so it grains and dithers
  // with the body instead of reading as a flat CSS gradient.
  float outside = smoothstep(radius - 0.02, radius + 0.02, r);
  float glowFall = exp(-max(0.0, r - radius) * 6.5);
  float glow = outside * glowFall * (0.55 + u_rim * 0.9);
  vec3 glowCol = mix(u_palette[2], u_palette[1], 0.35);

  // --- Composite ------------------------------------------------------------
  // Body inside the disc, glow outside, limb added on top everywhere it lands.
  float inside = 1.0 - outside;
  vec3 col = body * inside + glowCol * glow;
  col += limbCol * rimAmt;

  // Grain baked into the MATERIAL: modulate the body grain by the surface, so it
  // pools in the mottling like emulsion on a print. Heavier inside the disc
  // (it's the surface), lighter in the glow.
  float grainShape = mix(0.35, 1.0, inside);
  col = filmGrain(col, uv, u_time, u_grainAmt * 0.7 * grainShape);

  // Alpha: opaque disc, falling-off glow halo, transparent beyond.
  float alpha = clamp(inside + glow * 1.2, 0.0, 1.0);

  gl_FragColor = vec4(dither8(col, uv), alpha);
}
`;

/**
 * The orb vehicle: a disc that travels across the clip along the journey arc,
 * scaling as it approaches and arrives. Its surface is rendered-grade GPU light:
 * an SDF disc with an fbm-textured body, a hot fresnel limb, a soft outer glow,
 * and grain baked into the material (the grain IS the surface, per the
 * moodboard) — not flat CSS rects/gradients. Owns GEOMETRY (the disc, the path),
 * MOTION (arc travel, beatPulse, bassBreath), and BRAND LAW (Eclipse Gold rim
 * default, baked grain, determinism). The consuming agent owns the path function
 * and, via `children`, an optional plate surface.
 *
 * Render-slot modes:
 *   - no children  -> the GPU surface shader (ORB_FRAG) is drawn into the disc.
 *   - children     -> the plate path: children are composited inside the disc
 *                     clip and the shader is skipped, so sampled artwork / a
 *                     kaleido passage / a dither field can ride inside the orb.
 *
 * Moodboard: the founding image's grainy sun, posted/rainy-days.jpg's gold moon
 * (grain that IS the surface, lit rim against deep noise). The One Sun Rule: this
 * is the single light source; keep the rim gold.
 *
 * Pure and deterministic: position and scale derive from the journey clock and
 * the audio hooks only; the surface shader's u_time/u_seed derive from the frame
 * and the seed via ShaderLayer.
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
  lightAngle = -2.2,
  surfaceGrain = 0.5,
  surfaceDetail = 3.2,
  style,
}) => {
  const { arc } = useJourney(journey);

  // Audio-reactive scale + rim modifiers, each gated on its source being present.
  const { pulse } = useBeat(beatGrid ?? []);
  const hasBeat = beatGrid !== undefined && beatGrid.length > 0;
  const beatKick = hasBeat ? pulse * beatPulse : 0;

  const bass = useBass(bassCurve ?? []);
  const hasBass = bassCurve !== undefined && bassCurve.length > 0;
  const breath = hasBass ? bass * bassBreath : 0;

  const placement = resolvePlacement(path, arc);
  const effectiveScale = placement.scale * (1 + beatKick + breath);
  const px = size * effectiveScale;

  // The rim/limb heats with bass + beat when curves are present, else stays put.
  const glowStrength = hasBass
    ? Math.min(1.4, rimIntensity * (0.7 + bass * 0.6) + (hasBeat ? pulse * 0.25 : 0))
    : rimIntensity;

  // The GPU surface layer is square (px by px), centered on the disc, with the
  // glow halo bleeding past the disc edge. Oversize the layer past the disc so
  // the in-shader glow has room to fall off before the canvas edge clips it.
  const layer = px * 1.9;

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
      {children ? (
        <>
          {/* Plate path: keep a soft CSS rim halo behind the clipped surface so
              even sampled artwork carries the One Sun glow. */}
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
            {children}
          </div>
        </>
      ) : (
        // GPU surface: the disc + limb + glow + baked grain, drawn in one shader
        // into a square layer centered on the orb. No CSS rects; rendered light.
        <div
          style={{
            height: layer,
            left: "50%",
            position: "absolute",
            top: "50%",
            transform: "translate(-50%, -50%)",
            width: layer,
          }}
        >
          <AbsoluteFill>
            <ShaderLayer
              fragmentShader={ORB_FRAG}
              palette={palette}
              seed={(size % 9973) + 1}
              uniforms={{
                u_aspect: 1,
                u_detail: surfaceDetail,
                u_grainAmt: surfaceGrain,
                u_isSun: variant === "sun" ? 1 : 0,
                u_lightAng: lightAngle,
                u_rim: glowStrength,
              }}
            />
          </AbsoluteFill>
        </div>
      )}
    </div>
  );
};
