import React, { useMemo } from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { colors } from "@fluncle/tokens";
import { type CosmosPalette, type EnergySample } from "../types";
import { GLSL } from "./glsl";
import { ShaderLayer } from "./shader-layer";

// "JourneyGlass" — the GLASS travelling vehicle (the One Vehicle Rule, see
// packages/video/README.md), rebuilt as a GPU fragment shader. A procedural warm
// flamefold backdrop (an fbm flow field run through the Retint palette ramp) is
// seen THROUGH a curtain of vertical glass ribs. Each rib carries a real
// screen-space refraction: it offsets the backdrop sample by a per-rib surface
// normal so the molten gradient behind genuinely bends; rib edges throw specular
// streak highlights and a thin chromatic split. The whole curtain SWEEPS across
// the frame over the journey arc (the travel) while the molten flow speed and
// specular ride the audio.
//
// Moodboard references (MOODBOARD.md, "glass" vehicle group + Retint Rule):
//   - liquid-glass-flamefold-warm.webp : the warm molten S-fold gradient behind
//     faint glass striations; near-canon out of the box. The shader's backdrop is
//     this fold; the ribs are the striations that refract it.
//   - liquid-blade-curtain-rgb.webp    : the vertical blade displacement and the
//     wet gel falloff per ribbon; retinted warm (cream/gold/red), NOT the RGB.
//   - grain-liquid-heat.jpg            : dense grain over flowing liquid heat;
//     the shader bakes its own film grain and the parent Grain layer sits on top.
//
// Two modes:
//   - PURE-SHADER MODE (no children): the shader fills the frame. The ribs
//     refract the procedural flamefold itself — this is the high-fidelity glass.
//   - CHILDREN MODE (children provided): the children render BEHIND as DOM (an
//     Eclipse, a Starfield, towers) and the shader curtain composites OVER them
//     with partial alpha (`childrenOverlayOpacity`). A fragment shader cannot
//     sample DOM pixels, so in this mode it refracts its OWN flamefold and
//     overlays it as a translucent glass sheet — the ribs, specular and sweep
//     read over the scene, but the literal refraction is of the shader's field,
//     not the children. Use pure-shader mode when you need true refraction.
//
// Palette defaults to the WARM CANON (Deep Field -> Re-entry Red -> Eclipse Gold
// -> Starlight Cream). Gold lives only as the thin specular crest on rib edges,
// staying subordinate to the parent composition's single Eclipse sun.
//
// Determinism: every shader uniform is frame-, seed- or curve-derived (u_time =
// frame/fps; audio via the curve hooks inside ShaderLayer). No Math.random /
// Date.now in the render.

export type JourneyGlassSweep = "left" | "right";

export type JourneyGlassProps = {
  /**
   * Number of vertical refractive ribs across the frame. More ribs = finer
   * striations. 7–14 reads as a liquid glass curtain.
   * @default 9
   */
  bladeCount?: number;
  /**
   * Which way the whole curtain travels across the journey arc. "right" sweeps
   * the ribs + flow rightward; "left" sweeps leftward. This is the TRAVEL.
   * @default "right"
   */
  sweep?: JourneyGlassSweep;
  /**
   * Full sweeps across the frame per second of travel. ~0.06 crosses the frame
   * in roughly a 16s clip; raise for a faster passage. Ignored when `arc` is
   * supplied (the arc then drives the sweep position directly).
   * @default 0.06
   */
  sweepPerSec?: number;
  /**
   * Refraction strength, 0..1. Drives how far each rib offsets the backdrop
   * sample (the screen-space bend), the specular streak gain and the chromatic
   * split at rib boundaries. 0 = flat glass; 1 = strongly bent, wet glass.
   * @default 0.6
   */
  refraction?: number;
  /**
   * How much each rib breathes (widens/brightens) on the bass, 0..1. Pass
   * bassCurve to feed it; 0 disables the audio breathing.
   * @default 0.5
   */
  breathe?: number;
  /**
   * Bass curve (composition audio.bassCurve) driving the per-rib breathing and
   * specular swell. Optional; without it the curtain still sweeps and refracts.
   */
  bassCurve?: EnergySample[];
  /**
   * Energy curve (composition audio.energyCurve). Opens the overall specular
   * brightness AND speeds the molten flow behind the glass. Optional.
   */
  energyCurve?: EnergySample[];
  /**
   * Beat grid (ms offsets) — feeds the shader's beat pulse so rib specular can
   * snap on the grid. Optional.
   */
  beatGrid?: number[];
  /** Beat-pulse decay (see useBeat). Default 3.2. */
  beatDecay?: number;
  /** Per-track seed for the procedural flamefold. Default 1. */
  seed?: number;
  /**
   * The journey arc, 0..1, driving the curtain sweep position. Pass the eased
   * `arc` from useJourney so the glass travels on the shared narrative clock.
   * When omitted the sweep is driven by u_time * sweepPerSec alone.
   */
  arc?: number;
  /**
   * Brand palette. The flamefold field defaults to the warm canon (Deep Field ->
   * Re-entry Red -> Eclipse Gold -> Starlight Cream). Pass the composition
   * palette to bend the fold toward the artwork while keeping the warm law.
   */
  palette?: Partial<CosmosPalette>;
  /**
   * Overall layer opacity, 0..1, for fading the curtain in/out across the arc.
   * @default 1
   */
  opacity?: number;
  /**
   * In CHILDREN MODE, the alpha the shader curtain composites over the children
   * with. Lower lets more of the scene through the glass; higher reads as a
   * heavier glass sheet. Ignored in pure-shader mode (which is fully opaque).
   * @default 0.82
   */
  childrenOverlayOpacity?: number;
  /**
   * Content rendered BEHIND the curtain (the CREATIVITY slot): an Eclipse, a
   * Starfield, artwork. Switches the layer into CHILDREN MODE — the shader
   * composites OVER them as a translucent glass sheet (it refracts its own
   * flamefold, not the children's DOM pixels). Omit for pure-shader mode.
   */
  children?: React.ReactNode;
};

// Warm-canon defaults: the flamefold ramp. Deep Field ground, Re-entry-Red heat,
// Eclipse Gold crest, Starlight Cream ink.
const FALLBACK_PALETTE: CosmosPalette = {
  accent: colors.reentryRed,
  background: colors.deepField,
  glow: colors.eclipseGold,
  ink: colors.starlightCream,
  swatches: [],
};

// The glass fragment shader. The backdrop is a molten S-fold: a domain-warped fbm
// flow field tilted into the warm ramp. The ribs are a periodic vertical lattice;
// each rib has a smooth cross-rib coordinate from which we derive a surface normal
// (a lens), and we offset the backdrop UV by that normal — real screen-space
// refraction of the procedural field. Rib edges add a specular streak and a small
// per-channel chromatic split; the whole lattice sweeps on u_glassSweep.
//
// Uniform contract: u_breathe and u_flow are GATES (the prop amount or 0). The
// live response folds in the smoothed audio uniforms (u_bass / u_energy) inside
// main(), so breathing/flow stay off when no curve is fed but ride the audio when
// it is — all the per-frame audio sampling stays inside ShaderLayer.
const GLASS_FRAG = /* glsl */ `
${GLSL.hash}
${GLSL.valueNoise}
${GLSL.fbm}
${GLSL.paletteRamp}
${GLSL.filmGrain}
${GLSL.vignette}

uniform float u_ribs;        // rib count across the frame
uniform float u_refraction;  // 0..1 refraction strength
uniform float u_breathe;     // bass breathing GATE (amount or 0), * u_bass in main
uniform float u_glassSweep;  // sweep phase (the travel), in "sweeps"
uniform float u_flow;        // molten-flow GATE (1 or 0), * u_energy in main

// The molten flamefold backdrop, sampled at an (already refracted) uv. An fbm
// warp folds the domain into the liquid-glass S-curve; the ramp climbs into
// gold/cream only where the fold crests, keeping warm dark dominant.
vec3 flamefold(vec2 uv, float flowLive) {
  vec2 q = (uv - 0.5) * vec2(1.0, 1.45);
  // Slow molten drift; energy speeds it. Seed offsets the field per track.
  float ts = u_time * (0.045 + 0.06 * flowLive) + u_seed * 3.17;
  // Domain warp -> the S-fold. Two fbm passes, the first bending the second.
  float warp = fbm(q * 1.3 + vec2(ts * 0.6, ts * 0.2), 4);
  float fold = fbm(q * 2.1 + warp * 0.9 + vec2(-ts * 0.3, ts * 0.5), 6);
  // A diagonal S-bias so the heat reads as one big molten fold, not soup.
  float sBias = 0.5 + 0.5 * sin((uv.x * 1.6 + uv.y * 0.9 + warp * 1.2) * 3.14159);
  float t = mix(fold, sBias, 0.45);
  t = t * t * 0.92 + (1.0 - uv.y) * 0.12; // warm-dark ground, horizon lift
  return paletteRamp(clamp(t, 0.0, 1.0));
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;

  // Fold the live smoothed audio into the gates: off without a curve, reactive
  // with one. breatheLive 0..~amount, flowLive 0..1.
  float breatheLive = u_breathe * u_bass;
  float flowLive = u_flow * u_energy;

  // --- The rib lattice -----------------------------------------------------
  // Sweep the ribs horizontally (the travel). A bass breath widens the effective
  // rib period slightly so the curtain pulses with the low end.
  float breath = 1.0 + 0.12 * breatheLive;
  float ribX = uv.x * u_ribs / breath + u_glassSweep * u_ribs;
  float ribId = floor(ribX);
  float ribF = fract(ribX);              // 0..1 across one rib
  float centered = ribF - 0.5;           // -0.5..0.5, 0 at rib center

  // Per-rib jitter: each rib bows a little differently (organic glass), and a
  // slow vertical wobble makes ribs look molten rather than ruled.
  float jitter = (hash21(vec2(ribId, 7.0 + u_seed)) - 0.5);
  float wobble = sin(uv.y * 2.4 + ribId * 0.7 + u_time * 0.5) * 0.18;

  // The rib surface as a smooth lens. Treat each rib as a half-cylinder of glass:
  // x' = centered*2 in -1..1, the surface height is sqrt(1-x'^2) and the normal's
  // horizontal slope is x' itself. Light refracts by the slope, so the backdrop
  // bends hardest near the rib edges and runs straight through the center — the
  // signature lens read (think the flamefold seen through fluted glass).
  float xp = clamp(centered * 2.0, -1.0, 1.0);
  float lens = sqrt(max(0.0, 1.0 - xp * xp)); // 1 at center, 0 at edges (thickness)
  float slope = xp;                            // -1 left edge .. +1 right edge
  float refrAmt = u_refraction * (0.16 + 0.05 * breatheLive) / max(2.0, u_ribs);

  // --- Screen-space refraction --------------------------------------------
  // Bend the backdrop by the lens slope (scaled to one rib width so it doesn't
  // tear) plus a vertical molten drag. Chromatic split: sample R/G/B at slightly
  // different refraction so rib edges fringe gold/cyan like real glass.
  vec2 baseOff = vec2(slope * refrAmt + jitter * refrAmt * 0.4, wobble * refrAmt * 0.6);
  float ca = refrAmt * 0.5 * u_refraction;
  vec3 col;
  col.r = flamefold(uv + baseOff + vec2(ca, 0.0), flowLive).r;
  col.g = flamefold(uv + baseOff, flowLive).g;
  col.b = flamefold(uv + baseOff - vec2(ca, 0.0), flowLive).b;

  // Thickness shading: the rib center reads brighter/cleaner (light passes
  // straight) and the edges sink darker (grazing angle) — the wet gel falloff.
  float gel = mix(0.72, 1.12, lens);
  col *= gel;

  // --- Specular streak highlights on rib edges -----------------------------
  // A sharp, narrow hot line where the curved rib face catches the key light.
  // It sits just off the rib center on the lit side; a second fainter streak on
  // the far edge. Sharp falloff (high power) makes it read as a wet glint, not a
  // wash. Driven up by energy (flowLive) + breath + the beat pulse.
  float lit = smoothstep(0.02, 0.16, ribF) * smoothstep(0.34, 0.18, ribF);   // hot band near 1/4
  float litFar = smoothstep(0.66, 0.82, ribF) * smoothstep(0.98, 0.84, ribF); // faint far band
  // Break the streak vertically into wet glints (where the molten fold crests),
  // so it reads as light catching a liquid surface rather than a printed line.
  float glint = 0.45 + 0.55 * smoothstep(0.35, 0.85,
    fbm(vec2(uv.y * 4.5 + ribId * 1.3, ribId * 0.7 + u_time * 0.25 + u_seed), 3));
  float specGain = (0.7 + 0.5 * flowLive) * (0.85 + 0.5 * breatheLive) * (1.0 + 0.7 * u_beatPulse);
  float spec = (lit * 1.0 + litFar * 0.35) * glint * specGain;
  // Cream core (cleanest light) with a gold inner — thin and edge-bound (the
  // only gold; subordinate to the One Sun), screened in additively.
  vec3 specCol = mix(u_palette[3], u_palette[2], 0.35);
  col += spec * 0.85 * specCol;

  // A crisp dark seam in the trough between ribs (the striation lines).
  float seam = 1.0 - smoothstep(0.0, 0.07, abs(centered) - 0.43);
  col *= 1.0 - seam * 0.55;

  // A faint full-curtain sheen sweeping with the travel, tying ribs into a sheet.
  float sheen = smoothstep(0.16, 0.0, abs(fract(uv.x * 0.6 - u_glassSweep) - 0.5));
  col += sheen * 0.06 * (0.6 + 0.4 * flowLive) * u_palette[3];

  // --- Finish --------------------------------------------------------------
  col *= mix(0.5, 1.0, vignette(uv, 1.04, 0.95));
  col = filmGrain(col, uv, u_time, 0.12);
  gl_FragColor = vec4(dither8(col, uv), 1.0);
}
`;

export const JourneyGlass: React.FC<JourneyGlassProps> = ({
  bladeCount = 9,
  sweep = "right",
  sweepPerSec = 0.06,
  refraction = 0.6,
  breathe = 0.5,
  bassCurve,
  energyCurve,
  beatGrid,
  beatDecay = 3.2,
  seed = 1,
  arc,
  palette,
  opacity = 1,
  childrenOverlayOpacity = 0.82,
  children,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const seconds = frame / fps;

  const pal = { ...FALLBACK_PALETTE, ...palette };
  const ribs = Math.max(1, Math.round(bladeCount));
  const refr = Math.min(1, Math.max(0, refraction));
  const dir = sweep === "left" ? -1 : 1;

  const hasBass = !!bassCurve && bassCurve.length > 0;
  const hasEnergy = !!energyCurve && energyCurve.length > 0;

  // TRAVEL: when the shared arc is supplied the glass rides the narrative clock
  // (a little under one full sweep across the whole journey); otherwise it
  // advances by wall-arc time at sweepPerSec. Both directions honour `sweep`.
  const sweepPhase = arc !== undefined ? arc * dir * 0.85 : seconds * sweepPerSec * dir;

  // Custom uniforms pushed every frame by ShaderLayer. u_breathe / u_flow are
  // GATES (amount or 0); the shader multiplies them by the smoothed u_bass /
  // u_energy so the audio response lives entirely inside the curve hooks.
  const shaderUniforms = useMemo<Record<string, number>>(
    () => ({
      u_breathe: hasBass ? breathe : 0,
      u_flow: hasEnergy ? 1 : 0,
      u_glassSweep: sweepPhase,
      u_refraction: refr,
      u_ribs: ribs,
    }),
    [hasBass, breathe, hasEnergy, sweepPhase, refr, ribs],
  );

  const shader = (
    <ShaderLayer
      fragmentShader={GLASS_FRAG}
      palette={palette}
      seed={seed}
      beatGrid={beatGrid}
      beatDecay={beatDecay}
      energyCurve={energyCurve}
      bassCurve={bassCurve}
      uniforms={shaderUniforms}
      opacity={children ? childrenOverlayOpacity : 1}
    />
  );

  // CHILDREN MODE: render children behind, composite the shader sheet over them.
  if (children) {
    return (
      <AbsoluteFill aria-hidden style={{ opacity, overflow: "hidden", pointerEvents: "none" }}>
        {children}
        {shader}
      </AbsoluteFill>
    );
  }

  // PURE-SHADER MODE: the shader fills the frame and refracts its own flamefold.
  return (
    <AbsoluteFill
      aria-hidden
      style={{
        backgroundColor: pal.background,
        opacity,
        overflow: "hidden",
        pointerEvents: "none",
      }}
    >
      {shader}
    </AbsoluteFill>
  );
};
