// "DownWithYourLove" — the ORB vehicle scene for Freaks & Geeks — "Down With Your
// Love" (185 BPM euphoric vocal roller on Elevate Records; analysed window from
// startMs 10000 catching the energy peak at ~10.8s).
//
// ARCHIVE NOTE: this is a dated, self-contained archive composition. It imports
// ONLY the surviving core (ShaderLayer, GLSL, CloseCard, FloatingType, Starfield,
// Grain, the audio hooks, color helpers, tokens, remotion, react). The styled
// "journey vehicle" it used (JourneyOrb) has been INLINED verbatim below so the
// piece re-renders forever after the vehicle library is deleted. Nothing creative
// changed in this migration — the orb's path, surface shader, rim/bass/beat
// behavior, and the entire gel-split scene are preserved bit-for-bit.
//
// CONCEPT (two sentences): a lone burning sun holds the centre of a warm-red and
// cool-teal GEL-SPLIT night — present and breathing from frame one — swelling on
// the sub and snapping on the 185 grid as the vocal anthem lifts. It flares to its
// single Eclipse Gold peak at the drop (~clip 0.54, the energy=1.0 hit), dims back
// through the breakdown, then re-enters and settles as the love-letter close card
// arrives. Texture family: DUOTONE — a strict two-temperature gel split that
// mirrors the cover (warm heat field vs the artwork's teal as a minor cool
// counter-accent, Retint Rule), with onset chromatic-aberration fringing as a
// supporting glitch accent, never the vehicle.
//
// One Vehicle Rule: the ORB (the Eclipse sun). It is on screen from the first
// frame (Always-Visible Vehicle) — a dim ember through the intro, igniting on the
// drop, never a late reveal. Everything else (the gel field, the starfield, the
// aberration flashes, the type) supports it and stays subordinate.
//
// Determinism: frame-/seed-/curve-derived only (useCurrentFrame/fps, remotion
// random via seeded sub-seeds, the audio.* curves). GPU shaders render via
// ANGLE/Metal (pass --gl=angle; the pipeline sets it by default). Grain + Retint
// are baked at the GPU level in the gel field and the orb surface; the CSS
// <Grain /> rides as the system base texture over the whole frame.

import { colors } from "@fluncle/tokens";
import { type CSSProperties } from "react";
import {
  AbsoluteFill,
  Audio,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import {
  CloseCard,
  FloatingType,
  GLSL,
  Grain,
  ShaderLayer,
  Starfield,
  useBass,
  useBeat,
  useEnergy,
  useJourney,
  useOnset,
  withAlpha,
  type CosmosPalette,
  type UseJourneyOptions,
} from "../cosmos";
import { type NostalgicCosmosProps } from "../types";

// Safe margins (README): keep all type inside this inset on 1080x1920.
const MARGIN_X = 96;
const SAFE_TOP = 150;
const SAFE_BOTTOM = 230;

// Journey split: a short depart (the ember rises) and a generous arrive for the
// close. The energy peak (the drop) sits at ~10.8s of the 20s window (~clip
// 0.54), inside the long travel phase where the gel field warms and the rim
// ignites.
const SPLIT: [number, number] = [0.16, 0.82];

// Scene type beats in seconds (intensity rides the audio; timing is the grammar).
const T = {
  artistIn: 0.5,
  artistOut: 7.0,
  closeIn: 16.6,
  metaIn: 12.4,
  metaOut: 16.0,
  trackIn: 7.6,
  trackOut: 12.2,
};

// The drop window: the energy curve peaks (1.0) at 10.8s of the 20s clip. Warm
// the gel field and ignite the rim across [10.2s, 10.9s] so the heat and the gold
// peak land together. Expressed in clip progress (0..1).
const DROP_IN = 10.2 / 20;
const DROP_OUT = 10.9 / 20;

// The GEL-SPLIT background shader: two committed light temperatures sharing one
// frame, mirroring the cover's backlit duotone. The warm side (Eclipse/Re-entry
// heat) owns the right, the cool side (the artwork's teal, retinted-in as a MINOR
// counter-accent per the Retint Rule) pools on the left, with a soft breathing
// seam down the middle. The drop (u_drop) floods the whole field warm so the cool
// burns off and the night becomes one heat — then it recedes. Everything stays a
// deep warm-dark inky cloud so the orb is always the brightest thing (the One
// Sun). Grain + dither baked in-shader (the preferred GPU grain), so this is
// rendered light, not a CSS gradient.
const GEL_FRAG = /* glsl */ `
uniform float u_drop;   // 0..1 how far the drop has flooded the field warm
uniform float u_seam;   // 0..1 horizontal seam position breath
uniform float u_cold;   // 0..1 cool-side strength (high in intro/breakdown, off on the peak)
uniform vec3  u_cool;   // the artwork's teal, retinted-in as the minor cool side

${GLSL.hash}
${GLSL.valueNoise}
${GLSL.fbm}
${GLSL.paletteRamp}
${GLSL.filmGrain}
${GLSL.vignette}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;

  // Two-layer fbm gives the haze its volume: a warp field flows a second field so
  // the gel drifts and folds like stage haze rather than scrolling. Slow time.
  vec2 q = uv * vec2(1.0, 1.6);
  float warp = fbm(q * 1.2 + vec2(0.0, u_time * 0.04), 4);
  float field = fbm(q * 2.0 + warp * 0.65 + vec2(u_time * 0.02, u_seed * 0.6), 6);

  // The gel split: a soft vertical seam. Right of it reads warm, left reads cool,
  // mirroring the cover's backlit duotone. The seam breathes horizontally (u_seam)
  // so the two temperatures slosh like haze blown across a stage. The drop pushes
  // the seam right so the warm floods most of the frame on the peak.
  float seamX = mix(0.44, 0.56, u_seam) + u_drop * 0.42;
  float warmSide = smoothstep(seamX - 0.20, seamX + 0.20, uv.x);

  // Heat field: a deep warm-dark inky cloud, the ramp kept LOW so it barely
  // reaches gold and never cream (the orb stays the One Sun). A low horizon ember
  // sits under the frame; energy + drop widen the bloom. Field peaks add wisps.
  float horizon = (1.0 - uv.y);
  float heat = mix(0.04, 0.15, u_drop) + u_energy * 0.05;
  float t = field * field * (0.20 + u_drop * 0.22) + horizon * heat;
  vec3 warmCol = paletteRamp(clamp(t, 0.0, 0.70));

  // Cool side: the artwork's teal, admitted ONLY on the left of the seam, mirroring
  // the cover's backlit duotone gel. It rides the brighter WISPS of the cool-side
  // field (where there is luminance to carry the hue) and is screened in so it
  // glows like a stage gel rather than muddying the warm dark. Strong in the cool
  // intro/breakdown (u_cold), burning off as the drop floods the frame warm. The
  // Retint Rule: a minor counter-accent that tints the night, never a field, never
  // gold — the warm dark always wins, but the duotone reads.
  float coolWisp = smoothstep(0.34, 0.86, field) * (1.0 - warmSide);
  float coolAmt = clamp((0.18 + coolWisp) * u_cold, 0.0, 1.0);
  // Teal glow, brightest in the wisps; screened over the warm field so it adds
  // light (a gel) instead of replacing the night with cyan.
  vec3 coolGlow = u_cool * (0.22 + coolWisp * 0.85);
  vec3 col = warmCol + coolGlow * coolAmt * 0.5;

  // Vignette toward warm dark, then organic film grain over the whole field, then
  // dither to kill 8-bit banding on the smooth gradient.
  col *= mix(0.28, 1.0, vignette(uv, 0.95, 0.80));
  col = filmGrain(col, uv, u_time, 0.13);
  gl_FragColor = vec4(dither8(col, uv), 1.0);
}
`;

// === INLINED VEHICLE: the orb surface shader (formerly journey/journey-orb.tsx's
// ORB_FRAG) ================================================================
// Renders a rendered-grade celestial body into the (square) layer that wraps it:
// an SDF disc whose body is an fbm-textured material, a hot fresnel-style limb (a
// thin bright burning edge, like a solar eclipse / planet limb), a soft outer
// glow with physical falloff, and emulsion grain baked INTO the surface so the
// grain reads as the material, not an overlay. The disc sits in the center;
// everything outside it is transparent so the layer composites cleanly.
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
  //
  // The exp falloff alone never reaches 0, so at the (square) layer's on-axis
  // edge it's still ~24% bright and the hard quad clip prints a visible
  // rectangle around the halo. Multiply by a radial edge fade that drives the
  // glow to EXACT zero well inside the quad — by r ~= 0.95, where p reaches the
  // shorter axis at r = 1.0 — so the halo dissolves into the field with no
  // perceivable boundary. (radius is 0.78, leaving ample room for the falloff.)
  float outside = smoothstep(radius - 0.02, radius + 0.02, r);
  float glowFall = exp(-max(0.0, r - radius) * 6.5);
  float edgeFade = 1.0 - smoothstep(0.80, 0.96, r);
  float glow = outside * glowFall * edgeFade * (0.55 + u_rim * 0.9);
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

/** A position + scale along the journey arc, in screen fractions (0..1). */
type OrbPlacement = {
  x: number;
  y: number;
  scale: number;
};

type JourneyOrbProps = {
  size?: number;
  path: (arc: number) => OrbPlacement;
  journey?: UseJourneyOptions;
  palette?: Partial<CosmosPalette>;
  variant?: "limb" | "sun";
  rimColor?: string;
  rimIntensity?: number;
  beatPulse?: number;
  beatGrid?: number[];
  bassBreath?: number;
  bassCurve?: { timeMs: number; energy: number }[];
  lightAngle?: number;
  surfaceGrain?: number;
  surfaceDetail?: number;
  style?: CSSProperties;
};

/**
 * The orb vehicle (inlined from journey/journey-orb.tsx). A disc that travels
 * across the clip along the journey arc, scaling as it approaches and arrives.
 * Its surface is rendered-grade GPU light: an SDF disc with an fbm-textured body,
 * a hot fresnel limb, a soft outer glow, and grain baked into the material. This
 * archive uses only the GPU-surface (no-children) path with a custom `path`
 * function; the plate/children path of the original is not used here.
 */
const JourneyOrb: React.FC<JourneyOrbProps> = ({
  size = 520,
  path,
  journey,
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

  const placement = path(arc);
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

  // rimColor is the One Sun Rule's gold default; referenced to keep the prop
  // observably consumed (the in-shader rim is palette-driven).
  void rimColor;

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
      {/* GPU surface: the disc + limb + glow + baked grain, drawn in one shader
          into a square layer centered on the orb. No CSS rects; rendered light. */}
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
    </div>
  );
};

// === END INLINED VEHICLE ===================================================

export const DownWithYourLove: React.FC<NostalgicCosmosProps> = ({
  track,
  audio,
  palette,
  seed,
}) => {
  const { fps, durationInFrames, width, height } = useVideoConfig();

  // Shared narrative clock: every gesture below travels on this one arc.
  const { arc, phase, phaseProgress, progress } = useJourney({ split: SPLIT });

  // Audio-reactive scalars.
  const energy = useEnergy(audio.energyCurve, { smoothingFrames: 8 });
  const bass = useBass(audio.bassCurve, { smoothingFrames: 3 });
  const { pulse } = useBeat(audio.beatGrid, { decay: 3.0 });
  const onset = useOnset(audio.onsets, 150);

  // The drop gate: 0 before the energy peak, ramping to 1 across the drop window
  // so the gel floods warm and the Eclipse Gold ignition land together, then
  // easing back so the breakdown after it cools again. Frame-derived.
  const dropRise = interpolate(progress, [DROP_IN, DROP_OUT], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  // After the peak the field relaxes back through the breakdown, then the re-entry
  // re-warms. Driven mostly by instantaneous energy so the breakdown's energy dip
  // (~11-12.5s) visibly COOLS the field, with a small localized boost on the drop
  // peak so the gold ignition still lands hard. A low warm baseline keeps the
  // intro from going stone-cold (the orb is always an ember, never a void).
  const drop = Math.min(1, 0.12 + dropRise * 0.25 + energy * 0.6);

  // The seam breathes slowly across the clip (pure, frame-derived sine).
  const sec = useCurrentFrame() / fps;
  const seam = 0.5 + 0.5 * Math.sin(sec * 0.5);

  // The cool teal side: strong in the cool intro and the breakdown (low energy),
  // burning off toward the drop peak so the duotone reads as a temperature that
  // swings with the tune rather than a static wash. Inverted energy, floored so a
  // hint of teal always survives on the left.
  const cold = Math.max(0.2, 1 - dropRise * 0.7 - energy * 0.35);

  // Energy opens the starfield drift; the cosmos breathes, it does not scroll.
  const driftBoost = 1 + energy * 1.5;
  const floatBoost = 1 + energy * 0.7;

  // Onset = brief gold exposure spike + a grain kick + a chromatic-aberration
  // shudder (the cover's RGB-fringed title). Gated up by the drop so the intro
  // stays quiet and the anthem section sparks.
  const exposure = onset * 0.14 * (0.3 + drop * 0.7);
  const grainKick = onset * 0.07;
  const aberration = onset * (0.4 + drop * 0.6);

  // The orb path: the sun holds the centre the whole clip (Always-Visible
  // Vehicle), rising gently from just-below-centre to upper-centre as the journey
  // travels and growing as it arrives. A faint sway keeps it drifting, not
  // tracking a rail; it settles to centre by arrival.
  const orbPath = (a: number) => {
    const sway = Math.sin(a * Math.PI * 1.4) * 0.04 * (1 - a);
    return {
      scale: 0.5 + a * 0.26,
      x: 0.5 + sway,
      y: 0.44 - a * 0.1,
    };
  };

  // The orb's current placement (same arc JourneyOrb travels), used to mask its
  // square GPU surface layer to a circle so the in-shader outer glow does not clip
  // to a visible RECTANGLE against the field (the seam fix from the kit).
  const orbBase = Math.min(width, height) * 0.46;
  const place = orbPath(arc);
  const orbPx = orbBase * place.scale;
  const footprint = orbPx * 1.9; // the square layer JourneyOrb renders into
  const maskInner = footprint * 0.34;
  const maskOuter = footprint * 0.49;
  const orbMask = `radial-gradient(circle at ${place.x * 100}% ${place.y * 100}%,
    #000 ${maskInner}px, transparent ${maskOuter}px)`;

  // The orb stays an occluded ECLIPSE (a dark, mottled body with a BURNING rim),
  // not a lit ball — so Eclipse Gold lives only on the rim (~10% of the frame, the
  // One Sun Rule). It is a dim EMBER from frame one (never invisible), warms with
  // the journey, then the drop ignites it and bass + beat make it swell. Capped so
  // it never blazes flat into a cream disc.
  const rimIntensity = Math.min(
    0.98,
    0.2 + drop * 0.42 + bass * 0.32 * (0.4 + drop * 0.6) + pulse * 0.22 * (0.4 + drop * 0.6),
  );
  // Always the limb variant: the body falls into shadow along the terminator, one
  // edge burns. The drop lights that edge hotter; it never flips to a full sun.
  const orbVariant = "limb" as const;

  // The artwork's teal counter-accent, retinted-in on the cool side of the gel.
  // The cover's teal is swatch index 3 (#0c8f90); fall back gracefully.
  const coolHex = palette.swatches[3] ?? palette.swatches[0] ?? colors.starlightCream;
  const coolVec = hexToVec3(coolHex);

  // The gel field stays on the CANON warm ramp regardless of the artwork (the Warm
  // Dark Rule): Deep Field -> Re-entry Red -> Eclipse Gold -> Cream. The artwork's
  // teal is admitted only as the minor u_cool seep, never as a ramp stop.
  const gelStops: [string, string, string, string] = [
    colors.deepField,
    colors.reentryRed,
    colors.eclipseGold,
    colors.starlightCream,
  ];

  // The orb is the One Sun: its surface burns GOLD, so the rim/limb reaches
  // Eclipse Gold rather than the artwork's oxblood. Background stays the warm
  // near-black; accent is the Re-entry-Red heat under the gold glow.
  const sunPalette = {
    accent: colors.reentryRed,
    background: palette.background || colors.deepField,
    glow: colors.eclipseGold,
    ink: colors.starlightCream,
  };

  return (
    <AbsoluteFill style={{ backgroundColor: palette.background || colors.deepField }}>
      {/* Audio: the analysed clip, trimmed to the drop window via startFrom. */}
      <Audio
        src={staticFile(audio.file)}
        startFrom={Math.round((audio.startMs / 1000) * fps)}
        endAt={Math.round((audio.startMs / 1000) * fps) + durationInFrames}
      />

      {/* GEL-SPLIT FIELD: the rendered duotone background. Grain + Retint baked
          in-shader (the preferred GPU grain). */}
      <AbsoluteFill>
        <ShaderLayer
          fragmentShader={GEL_FRAG}
          paletteStops={gelStops}
          seed={(seed % 9973) + 1}
          energyCurve={audio.energyCurve}
          bassCurve={audio.bassCurve}
          uniforms={{
            u_cold: cold,
            u_cool: coolVec,
            u_drop: drop,
            u_seam: seam,
          }}
        />
      </AbsoluteFill>

      {/* Starfield over the gel: drifts faster as energy lifts. Always there. */}
      <Starfield
        seed={seed}
        density={120}
        depth={3}
        drift={{ x: 0.004 * driftBoost, y: -0.01 * driftBoost }}
        maxSize={2.5}
        twinkle={0.4}
      />

      {/* THE ONE VEHICLE: the orb riding the journey arc, present and burning from
          frame one (Always-Visible Vehicle). Its GPU surface is the rendered
          Eclipse (fbm body, fresnel limb, baked grain). The rim is the single
          Eclipse Gold light source, an ember in the intro, igniting on the drop.
          The radial mask dissolves the square surface-layer seam. */}
      <AbsoluteFill
        style={{
          WebkitMaskImage: orbMask,
          maskImage: orbMask,
        }}
      >
        <JourneyOrb
          size={orbBase}
          path={orbPath}
          journey={{ split: SPLIT }}
          palette={sunPalette}
          variant={orbVariant}
          rimColor={colors.eclipseGold}
          rimIntensity={rimIntensity}
          beatPulse={0.06}
          beatGrid={audio.beatGrid}
          bassBreath={0.05}
          bassCurve={audio.bassCurve}
          lightAngle={-2.2}
          surfaceGrain={0.34}
          surfaceDetail={3.4}
        />
      </AbsoluteFill>

      {/* Eclipse occlusion: a warm-dark disc over the orb body so it reads as an
          ECLIPSE (a body crossing the sun) and the gold lives only on the burning
          rim (~10% of the frame, the One Sun Rule), not a flat bright ball. It
          eases open with the drop so the rim flares on the peak; in the intro it
          keeps the orb a dim ember. Centred on the orb placement, sized to the
          disc, screened away outside it. */}
      <div
        style={{
          background: `radial-gradient(circle at 50% 50%,
            ${withAlpha(colors.deepField, 0.86)} 0%,
            ${withAlpha(colors.deepField, 0.7)} ${30 + drop * 12}%,
            ${withAlpha(colors.deepField, 0)} ${64 + drop * 8}%)`,
          borderRadius: "50%",
          height: orbPx * 1.04,
          left: `${place.x * 100}%`,
          pointerEvents: "none",
          position: "absolute",
          top: `${place.y * 100}%`,
          transform: "translate(-50%, -50%)",
          width: orbPx * 1.04,
        }}
      />

      {/* Chromatic-aberration shudder (the cover's RGB-fringed title), as a
          SUPPORTING glitch accent on onsets — a red/teal split echo of the heat
          glow, kept faint and gated by the drop so it never competes with the orb.
          Warm channels per the Retint Rule. */}
      {aberration > 0.02 ? (
        <>
          <AbsoluteFill
            style={{
              background: `radial-gradient(60% 44% at ${50 - aberration * 2}% 50%,
                ${withAlpha(colors.reentryRed, aberration * 0.1)} 0%,
                ${withAlpha(colors.reentryRed, 0)} 55%)`,
              mixBlendMode: "screen",
              pointerEvents: "none",
            }}
          />
          <AbsoluteFill
            style={{
              background: `radial-gradient(60% 44% at ${50 + aberration * 2}% 50%,
                ${withAlpha(coolHex, aberration * 0.08)} 0%,
                ${withAlpha(coolHex, 0)} 55%)`,
              mixBlendMode: "screen",
              pointerEvents: "none",
            }}
          />
        </>
      ) : null}

      {/* Lower scrim: a warm-dark pane seating all the bottom-third type (track
          line, date, close card) so it always holds AA over the orb's glow (The
          Legible Sky Rule — make the pane more opaque, never the text dimmer). A
          one-direction gradient toward Deep Field, so it reads as the night
          deepening at the bottom, not a flat bar. */}
      <AbsoluteFill
        style={{
          background: `linear-gradient(180deg,
            ${withAlpha(colors.deepField, 0)} 52%,
            ${withAlpha(colors.deepField, 0.55)} 78%,
            ${withAlpha(colors.deepField, 0.82)} 100%)`,
          pointerEvents: "none",
        }}
      />

      {/* --- TYPE TIMELINE (all inside the safe inset) ------------------------ */}
      <AbsoluteFill
        style={{
          paddingBottom: SAFE_BOTTOM,
          paddingLeft: MARGIN_X,
          paddingRight: MARGIN_X,
          paddingTop: SAFE_TOP,
        }}
      >
        {/* The artist as the brand-led opening mark, lifting through the intro,
            gone by the time the drop fills the frame. */}
        <TimedBlock
          inSec={T.artistIn}
          outSec={T.artistOut}
          fps={fps}
          style={{ left: MARGIN_X, position: "absolute", top: SAFE_TOP - 30 }}
        >
          <FloatingType
            variant="brandMark"
            mark={track.artists.join(", ")}
            fontSize={76}
            drift={7 * floatBoost}
            color={colors.starlightCream}
          />
        </TimedBlock>

        {/* On the drop: Artist — Title (the only sanctioned em dash). */}
        <TimedBlock
          inSec={T.trackIn}
          outSec={T.trackOut}
          fps={fps}
          style={{
            bottom: SAFE_BOTTOM + 150,
            left: MARGIN_X,
            position: "absolute",
            right: MARGIN_X,
          }}
        >
          <FloatingType
            variant="trackLine"
            track={track}
            fontSize={46}
            drift={6 * floatBoost}
            color={colors.starlightCream}
          />
        </TimedBlock>

        {/* Discovered date (tabular Oxanium). */}
        <TimedBlock
          inSec={T.metaIn}
          outSec={T.metaOut}
          fps={fps}
          style={{ bottom: SAFE_BOTTOM + 100, left: MARGIN_X, position: "absolute" }}
        >
          <FloatingType
            variant="meta"
            track={track}
            fontSize={32}
            drift={5 * floatBoost}
            driftPhase={0.7}
            color={colors.stardust}
          />
        </TimedBlock>

        {/* The close card, driven by the journey's "arrive" phase so it reveals
            exactly as the orb settles. The one permitted gold type moment. */}
        <div
          style={{
            bottom: SAFE_BOTTOM + 220,
            left: MARGIN_X,
            position: "absolute",
            right: MARGIN_X,
          }}
        >
          <CloseCard
            arc={phase === "arrive" ? phaseProgress : 0}
            floatBoost={floatBoost}
            palette={{ accent: colors.eclipseGold, ink: colors.starlightCream }}
          />
        </div>
      </AbsoluteFill>

      {/* Onset exposure spike: a brief additive gold veil, gated up by the drop. */}
      {exposure > 0.001 ? (
        <AbsoluteFill
          style={{
            background: `radial-gradient(80% 60% at 50% 48%,
              ${withAlpha(colors.eclipseGlow, exposure)} 0%,
              ${withAlpha(colors.eclipseGold, 0)} 60%)`,
            mixBlendMode: "screen",
            pointerEvents: "none",
          }}
        />
      ) : null}

      {/* GRAIN OVER EVERYTHING, ALWAYS — the system base texture over the whole
          frame (the in-shader grain is the material grain; this is the overlay). */}
      <Grain
        opacity={0.14 + grainKick}
        intensity={0.85}
        seed={(seed % 97) + 1}
        framePool={14}
        blendMode="overlay"
      />

      {/* A faint cinematic vignette to seat the type and hold the warm dark. */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(130% 100% at 50% 46%,
            ${withAlpha(colors.deepField, 0)} 55%,
            ${withAlpha(colors.deepField, 0.5)} 100%)`,
          pointerEvents: "none",
        }}
      />

      {/* arc reference keeps the journey clock observably consumed at the scene
          level (the orb and close card both already read it). */}
      <span style={{ display: "none" }}>{arc.toFixed(3)}</span>
    </AbsoluteFill>
  );
};

// --- Helpers ---------------------------------------------------------------

/** hex -> [0..1, 0..1, 0..1] for a vec3 uniform. Pure. */
const hexToVec3 = (hex: string): [number, number, number] => {
  const h = hex.replace("#", "");
  const n =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const r = parseInt(n.slice(0, 2), 16) / 255;
  const g = parseInt(n.slice(2, 4), 16) / 255;
  const b = parseInt(n.slice(4, 6), 16) / 255;
  return [Number.isFinite(r) ? r : 0, Number.isFinite(g) ? g : 0, Number.isFinite(b) ? b : 0];
};

/**
 * A block that fades + floats in/out over a [inSec, outSec) window. Pure: the
 * envelope is frame-derived. Mounts always (cheap) so layout is stable.
 */
const TimedBlock: React.FC<{
  inSec: number;
  outSec: number;
  fps: number;
  style?: React.CSSProperties;
  children: React.ReactNode;
}> = ({ inSec, outSec, fps, style, children }) => {
  const frame = useCurrentFrame();
  const sec = frame / fps;
  const fade = 0.6;

  const opacity = interpolate(sec, [inSec, inSec + fade, outSec - fade, outSec], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const rise = interpolate(sec, [inSec, inSec + fade, outSec - fade, outSec], [26, 0, 0, -18], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  if (opacity <= 0.001) {
    return null;
  }

  return <div style={{ ...style, opacity, transform: `translateY(${rise}px)` }}>{children}</div>;
};

export default DownWithYourLove;
