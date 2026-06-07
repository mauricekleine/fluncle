import React, { useMemo } from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { colors } from "@fluncle/tokens";
import { mix, withAlpha } from "../color";
import { useBass, useEnergy } from "../hooks";
import { type CosmosPalette, type EnergySample } from "../types";

// "JourneyGlass" — the GLASS travelling vehicle (the One Vehicle Rule, see
// packages/video/README.md). A curtain of refractive vertical blades/ribs that
// SWEEPS across the frame over the journey arc, each blade bending what sits
// behind it. The travel is the sweep: the whole curtain slides one direction
// across the clip while individual blades breathe on the bass.
//
// Moodboard references (MOODBOARD.md, "glass" vehicle group + Retint Rule):
//   - liquid-glass-flamefold-warm.webp : the warm liquid S-fold behind faint
//     glass striations; near-canon out of the box. Steal the fold + rib overlay.
//   - liquid-blade-curtain-rgb.webp    : a curtain of vertical liquid blades
//     bulging around a void; steal the blade displacement + wet gel falloff per
//     ribbon. Retint Rule: blades go warm (cream/gold/red), NOT the RGB palette.
//   - grain-liquid-heat.jpg            : dense grain over flowing liquid heat;
//     pairs with the parent Grain layer.
//
// Refraction is FAKED (no real refraction, CPU-friendly): each blade is a
// translucent vertical strip with a per-blade horizontal skew, brightness/contrast
// offset, and a layered specular gradient sampling the warm field, so the band
// behind appears bent and lit like glass. Pure SVG/CSS compositing only.
//
// Palette defaults to the WARM CANON: gold crest highlight, Re-entry-Red field,
// warm dark ground (the flamefold). Gold lives only as the thin crest on blades,
// staying subordinate to the parent composition's single Eclipse sun.
//
// Determinism: frame-, seed- and curve-derived values only. No Math.random /
// Date.now in the render.

export type JourneyGlassSweep = "left" | "right";

export type JourneyGlassProps = {
  /**
   * Number of vertical refractive blades across the frame. More blades = finer
   * ribbing (and slightly more cost). 7–14 reads as a liquid curtain.
   * @default 9
   */
  bladeCount?: number;
  /**
   * Which way the whole curtain travels across the journey arc. "right" sweeps
   * the field rightward; "left" sweeps it leftward. This is the TRAVEL.
   * @default "right"
   */
  sweep?: JourneyGlassSweep;
  /**
   * Full sweeps across the frame per second of travel. ~0.06 crosses the frame
   * in roughly a 16s clip; raise for a faster passage.
   * @default 0.06
   */
  sweepPerSec?: number;
  /**
   * Fake-refraction strength, 0..1. Drives per-blade skew, brightness offset and
   * specular intensity. 0 = flat strips; 1 = strongly bent, wet glass.
   * @default 0.6
   */
  refraction?: number;
  /**
   * How much each blade breathes (widens/brightens) on the bass, 0..1. Pass
   * bassCurve to feed it; 0 disables the audio breathing.
   * @default 0.5
   */
  breathe?: number;
  /**
   * Bass curve (composition audio.bassCurve) driving the per-blade breathing
   * and crest swell. Optional; without it the curtain still sweeps and refracts.
   */
  bassCurve?: EnergySample[];
  /**
   * Energy curve (composition audio.energyCurve) opening the overall specular
   * brightness across the arc. Optional.
   */
  energyCurve?: EnergySample[];
  /**
   * Brand palette. The crest highlight defaults to the warm canon gold; the
   * field to Re-entry Red; the ground to warm dark. Pass the composition palette
   * to bend the field toward the artwork while keeping the warm law.
   */
  palette?: Partial<CosmosPalette>;
  /**
   * Overall layer opacity, 0..1, for fading the curtain in/out across the arc.
   * @default 1
   */
  opacity?: number;
  /**
   * Content rendered BEHIND the curtain (the CREATIVITY slot): an Eclipse, a
   * Starfield, artwork — whatever the blades refract. The blades sample it via
   * their layered gradients (faked), not by true optics.
   */
  children?: React.ReactNode;
};

// Warm-canon defaults: the flamefold. Gold crest, Re-entry-Red field, warm dark.
const FALLBACK_PALETTE: CosmosPalette = {
  accent: colors.reentryRed,
  background: colors.deepField,
  glow: colors.eclipseGlow,
  ink: colors.starlightCream,
  swatches: [],
};

export const JourneyGlass: React.FC<JourneyGlassProps> = ({
  bladeCount = 9,
  sweep = "right",
  sweepPerSec = 0.06,
  refraction = 0.6,
  breathe = 0.5,
  bassCurve,
  energyCurve,
  palette,
  opacity = 1,
  children,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const seconds = frame / fps;

  const pal = { ...FALLBACK_PALETTE, ...palette };
  const count = Math.max(1, Math.round(bladeCount));
  const refr = Math.min(1, Math.max(0, refraction));
  const dir = sweep === "left" ? -1 : 1;

  // Audio drives the breathing + crest swell; hooks called unconditionally.
  const bass = useBass(bassCurve ?? []);
  const energy = useEnergy(energyCurve ?? []);
  const breatheAmt = breathe * (bassCurve && bassCurve.length > 0 ? bass : 0);
  const specGain = 0.7 + 0.3 * (energyCurve && energyCurve.length > 0 ? energy : 0);

  // TRAVEL: the whole curtain phase advances each second. We use it to offset
  // per-blade properties so the wave of bulge/brightness rolls across the frame.
  const sweepPhase = seconds * sweepPerSec * dir; // in "sweeps", wraps via sin

  // The warm field the blades appear to refract: a flamefold S-gradient. Sits
  // behind the children too, so even an empty curtain reads as warm glass.
  const fieldStyle = useMemo<React.CSSProperties>(() => {
    const crest = mix(pal.glow, colors.eclipseGold, 0.4);
    return {
      backgroundImage: `
        radial-gradient(120% 80% at 30% 18%, ${withAlpha(crest, 0.22)} 0%, transparent 46%),
        linear-gradient(165deg, ${withAlpha(pal.accent, 0.32)} 0%, ${withAlpha(
          pal.background,
          0.0,
        )} 42%, ${withAlpha(pal.accent, 0.24)} 78%, ${pal.background} 100%)`,
      inset: 0,
      position: "absolute",
    };
  }, [pal.glow, pal.accent, pal.background]);

  const bladeW = 100 / count; // each blade's width as a % of the frame

  return (
    <div
      aria-hidden
      style={{
        height: "100%",
        inset: 0,
        opacity,
        overflow: "hidden",
        pointerEvents: "none",
        position: "absolute",
        width: "100%",
      }}
    >
      {/* Behind the curtain: the caller's content, then the warm flamefold field. */}
      {children}
      <div style={fieldStyle} />

      {/* The refractive blades. Each is a clipped vertical strip; inside it the
          field is skewed + brightness-shifted so the band behind looks bent and
          lit. A thin gold crest runs the lit edge (warm canon). */}
      {Array.from({ length: count }).map((_, i) => {
        // Per-blade phase along the curtain; the sweep rolls the wave across.
        const u = i / Math.max(1, count - 1); // 0..1 across the frame
        const wave = Math.sin((u + sweepPhase) * Math.PI * 2);
        const wave2 = Math.sin((u * 2 + sweepPhase * 1.7 + 0.6) * Math.PI * 2);

        // Faked refraction: skew the inner field, shift brightness, bulge width.
        const skew = wave * 14 * refr; // degrees
        const bright = 1 + 0.35 * refr * wave2 * specGain;
        const bulge = 1 + breatheAmt * 0.35 * (0.5 + 0.5 * wave);
        // Specular crest opacity peaks on the lit side of the bulge.
        const crestAlpha = Math.max(0, wave) * 0.5 * refr * specGain;
        // Inner shadow on the unlit side for the wet gel falloff.
        const shadeAlpha = Math.max(0, -wave) * 0.4 * refr;

        const crest = mix(pal.glow, colors.eclipseGold, 0.5);

        return (
          <div
            key={i}
            style={{
              clipPath: "inset(0)",
              height: "100%",
              left: `${u * (100 - bladeW)}%`,
              overflow: "hidden",
              position: "absolute",
              top: 0,
              transform: `scaleX(${bulge})`,
              transformOrigin: `${u < 0.5 ? "left" : "right"} center`,
              width: `${bladeW}%`,
            }}
          >
            {/* The bent, re-lit copy of the warm field inside this blade. */}
            <div
              style={{
                ...fieldStyle,
                filter: `brightness(${bright.toFixed(3)}) saturate(${(1 + 0.25 * refr).toFixed(
                  3,
                )})`,
                inset: "-20% -40%",
                transform: `skewX(${skew.toFixed(2)}deg) translateX(${(wave * 8 * refr).toFixed(
                  2,
                )}%)`,
              }}
            />
            {/* Specular gold crest on the lit edge (the only gold; subordinate). */}
            <div
              style={{
                backgroundImage: `linear-gradient(90deg, ${withAlpha(
                  crest,
                  crestAlpha,
                )} 0%, transparent 30%, transparent 70%, ${withAlpha(
                  colors.starlightCream,
                  crestAlpha * 0.6,
                )} 100%)`,
                inset: 0,
                mixBlendMode: "screen",
                position: "absolute",
              }}
            />
            {/* Wet gel shadow falloff on the unlit edge. */}
            <div
              style={{
                backgroundImage: `linear-gradient(90deg, ${withAlpha(
                  colors.deepField,
                  shadeAlpha,
                )} 0%, transparent 45%)`,
                inset: 0,
                mixBlendMode: "multiply",
                position: "absolute",
              }}
            />
            {/* Thin rib seam between blades (the striation overlay). */}
            <div
              style={{
                borderRight: `1px solid ${withAlpha(colors.deepField, 0.35)}`,
                inset: 0,
                position: "absolute",
              }}
            />
          </div>
        );
      })}

      {/* A faint overall glass sheen sweeping with the curtain, tying the blades
          into one moving sheet. */}
      <div
        style={{
          backgroundImage: `linear-gradient(${
            105 + dir * 10
          }deg, transparent 0%, ${withAlpha(colors.starlightCream, 0.06 * specGain)} ${(
            40 +
            30 * Math.sin(sweepPhase * Math.PI * 2)
          ).toFixed(1)}%, transparent 70%)`,
          inset: 0,
          mixBlendMode: "screen",
          position: "absolute",
        }}
      />
    </div>
  );
};
