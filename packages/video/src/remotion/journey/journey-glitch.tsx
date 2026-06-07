import React, { useMemo } from "react";
import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { colors } from "@fluncle/tokens";
import { withAlpha } from "../color";
import { DitherField } from "../primitives";
import { useEnergy, useOnset } from "../hooks";
import { type CosmosPalette, type EnergySample } from "../types";

// "JourneyGlitch" — the GLITCH travelling vehicle (the One Vehicle Rule, see
// packages/video/README.md). Dither/pixel corruption that TRAVELS across the
// image: a corruption front crosses the frame, radiates from a focal point, or
// kicks RGB-split offsets on transients. The content underneath is the thing
// being corrupted (the CREATIVITY slot).
//
// Moodboard references (MOODBOARD.md, "glitch" vehicle group + Retint Rule):
//   - dither-hourglass-glitch.png  : 1-bit floyd-steinberg dither of a soft form
//     + crop-mark HUD brackets. Steal the dither rendering; drop the cold B/W.
//   - green-matrix-bloom.png       : photo fractured through mismatched halftone
//     tiles. Steal the tiled-resolution corruption; drop the hacker green.
//   - dot-matrix-runner.png        : a figure in a uniform dot grid as a motion
//     canvas. Steal the dot-matrix scaffold the corruption front travels over.
//   - pixel-masked-paragraph.png   : pixel-block masking as a reveal/redact wipe;
//     the "sweep" mode is that wipe made into a travelling front.
// Retint Rule: corruption is warm (Starlight Cream dither, Eclipse-Gold &
// Re-entry-Red channel splits), never phosphor green / RGB primaries.
//
// Builds on the DitherField primitive for the dither texture itself; this
// component owns the TRAVEL (where corruption lives at frame f) and the
// channel-split offsets. CPU-friendly: CSS masks, layered copies, SVG dither.
//
// Determinism: frame-, seed-, onset- and curve-derived values only. No
// Math.random / Date.now in the render.

export type JourneyGlitchMode = "sweep" | "bloom" | "channel-split";

export type JourneyGlitchDensityPreset = "energy" | "onset";

export type JourneyGlitchProps = {
  /**
   * How the corruption travels:
   *  - "sweep": a corruption FRONT crosses the frame with the arc.
   *  - "bloom": corruption RADIATES outward from a focal point.
   *  - "channel-split": RGB-split offsets kicked by useOnset (no spatial front;
   *    the whole frame tears on transients).
   * @default "sweep"
   */
  mode?: JourneyGlitchMode;
  /**
   * Direction of the "sweep" front in degrees (0 = left→right, 90 = top→bottom).
   * Ignored for other modes.
   * @default 0
   */
  sweepAngle?: number;
  /**
   * Fraction of one full travel completed per second. ~0.06 crosses the frame in
   * a ~16s clip. For "bloom" this grows the radius; ignored for "channel-split".
   * @default 0.07
   */
  travelPerSec?: number;
  /**
   * Focal point for "bloom" as frame fractions {x,y}, 0..1. Default center.
   * @default { x: 0.5, y: 0.5 }
   */
  focal?: { x: number; y: number };
  /**
   * Softness of the corruption edge as a fraction of the frame, 0..1. 0 = a hard
   * wipe; higher feathers the front so the dither dissolves in.
   * @default 0.22
   */
  feather?: number;
  /**
   * Corruption density driver. A preset reads the audio:
   *  - "energy": density rides useEnergy (slow swell).
   *  - "onset": density spikes on transients via useOnset.
   * Or pass a custom function (frame, fps) => 0..1 for full control.
   * @default "energy"
   */
  density?: JourneyGlitchDensityPreset | ((frame: number, fps: number) => number);
  /**
   * Dither cell size in px passed through to DitherField. Smaller = finer
   * corruption.
   * @default 14
   */
  cellSize?: number;
  /**
   * Which DitherField pattern the corruption uses ("halftone" | "checker" |
   * "pixel").
   * @default "pixel"
   */
  ditherPattern?: "halftone" | "checker" | "pixel";
  /**
   * Peak RGB-split offset in px (kicked by useOnset). For "channel-split" this is
   * the whole effect; for the other modes it tears the corrupted region on hits.
   * @default 8
   */
  splitStrength?: number;
  /** Onsets (composition audio.onsets) for channel-split + density "onset". */
  onsets?: number[];
  /** Energy curve (composition audio.energyCurve) for density "energy". */
  energyCurve?: EnergySample[];
  /**
   * Brand palette. The dither ink defaults to Starlight Cream; the two split
   * channels to Eclipse Gold and Re-entry Red (the warm retint of RGB).
   */
  palette?: Partial<CosmosPalette>;
  /** Deterministic seed for the dither grid. @default 1 */
  seed?: number;
  /**
   * Overall layer opacity, 0..1, for fading the vehicle in/out.
   * @default 1
   */
  opacity?: number;
  /**
   * The content being corrupted (the CREATIVITY slot): an Eclipse, artwork, a
   * FloatingType line, a Starfield. The glitch travels over THIS.
   */
  children?: React.ReactNode;
};

const FALLBACK_PALETTE: CosmosPalette = {
  accent: colors.reentryRed,
  background: colors.deepField,
  glow: colors.eclipseGlow,
  ink: colors.starlightCream,
  swatches: [],
};

export const JourneyGlitch: React.FC<JourneyGlitchProps> = ({
  mode = "sweep",
  sweepAngle = 0,
  travelPerSec = 0.07,
  focal = { x: 0.5, y: 0.5 },
  feather = 0.22,
  density = "energy",
  cellSize = 14,
  ditherPattern = "pixel",
  splitStrength = 8,
  onsets,
  energyCurve,
  palette,
  seed = 1,
  opacity = 1,
  children,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const seconds = frame / fps;

  const pal = { ...FALLBACK_PALETTE, ...palette };
  const goldCh = colors.eclipseGold;
  const redCh = pal.accent;

  // Audio-reactive density: preset reads a hook, or the caller's function.
  // Hooks are called unconditionally; presets pick which result to use.
  const energy = useEnergy(energyCurve ?? []);
  const onsetFlash = useOnset(onsets ?? []);
  const densityVal = useMemo<number>(() => {
    if (typeof density === "function") {
      return Math.min(1, Math.max(0, density(frame, fps)));
    }
    if (density === "onset") {
      return onsets && onsets.length > 0 ? onsetFlash : 0;
    }
    return energyCurve && energyCurve.length > 0 ? energy : 0.5;
  }, [density, frame, fps, onsets, onsetFlash, energyCurve, energy]);

  // RGB-split offset kicked by onsets (warm channels: gold vs red).
  const split = (onsets && onsets.length > 0 ? onsetFlash : 0) * splitStrength;

  const feath = Math.min(1, Math.max(0, feather)) * 100; // % feather band

  // TRAVEL → a CSS mask describing WHERE corruption lives this frame.
  // "sweep": a linear front at `sweepAngle` advancing across the frame.
  // "bloom": a radial front growing from the focal point.
  const corruptionMask = useMemo<string>(() => {
    if (mode === "bloom") {
      const r = (seconds * travelPerSec) % 1.6; // grows, then wraps for repeat
      const pct = r * 130; // radius as % of frame
      return `radial-gradient(circle at ${(focal.x * 100).toFixed(1)}% ${(focal.y * 100).toFixed(
        1,
      )}%, black 0%, black ${Math.max(0, pct - feath).toFixed(
        1,
      )}%, transparent ${pct.toFixed(1)}%)`;
    }
    if (mode === "channel-split") {
      // No spatial front: the whole frame is "corrupted" (tears on onsets).
      return "linear-gradient(black, black)";
    }
    // sweep: a front sweeping across at sweepAngle.
    const pos = ((seconds * travelPerSec) % 1.4) * 100; // 0..140% across, wraps
    return `linear-gradient(${sweepAngle}deg, black 0%, black ${Math.max(0, pos - feath).toFixed(
      1,
    )}%, transparent ${pos.toFixed(1)}%)`;
  }, [mode, seconds, travelPerSec, sweepAngle, focal.x, focal.y, feath]);

  const maskStyle: React.CSSProperties =
    mode === "channel-split"
      ? {}
      : {
          WebkitMaskImage: corruptionMask,
          maskImage: corruptionMask,
        };

  // Dither opacity follows density so quiet passages corrupt less.
  const ditherOpacity = interpolate(densityVal, [0, 1], [0.18, 0.95], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  // Density also tightens the dither threshold (denser corruption on peaks).
  const ditherThreshold = interpolate(densityVal, [0, 1], [0.3, 0.62], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

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
      {/* The content being corrupted. For channel-split we render three offset
          copies tinted to warm channels; otherwise one clean copy. */}
      {mode === "channel-split" && split > 0.01 ? (
        <>
          {/* Two channel-shoved copies (warm retint of the R/B split): one
              pushed toward Re-entry Red, one toward Eclipse Gold, offset apart
              and screen-blended so the seam tears like a misregistered scan.
              Filter-based tinting keeps it content-agnostic and deterministic. */}
          <div style={channelLayer(-split, "red")}>{children}</div>
          <div style={channelLayer(split, "gold")}>{children}</div>
          {/* The clean copy on top holds the un-torn core legible. */}
          <div style={{ inset: 0, position: "absolute" }}>{children}</div>
        </>
      ) : (
        <div style={{ inset: 0, position: "absolute" }}>{children}</div>
      )}

      {/* The travelling corruption: a dither layer clipped to the front mask,
          torn by the onset split. */}
      <div style={{ inset: 0, position: "absolute", ...maskStyle }}>
        {/* Warm channel tear of the dither on transients. */}
        <div
          style={{
            inset: 0,
            mixBlendMode: "screen",
            position: "absolute",
            transform: `translateX(${-split}px)`,
          }}
        >
          <DitherField
            pattern={ditherPattern}
            scale={cellSize}
            color={withAlpha(redCh, 0.9)}
            threshold={ditherThreshold}
            opacity={ditherOpacity}
            seed={seed}
            blendMode="screen"
          />
        </div>
        <div
          style={{
            inset: 0,
            mixBlendMode: "screen",
            position: "absolute",
            transform: `translateX(${split}px)`,
          }}
        >
          <DitherField
            pattern={ditherPattern}
            scale={cellSize}
            color={withAlpha(goldCh, 0.9)}
            threshold={ditherThreshold}
            opacity={ditherOpacity}
            seed={seed + 1}
            blendMode="screen"
          />
        </div>
        {/* The base cream dither, the body of the corruption. */}
        <DitherField
          pattern={ditherPattern}
          scale={cellSize}
          color={pal.ink}
          threshold={ditherThreshold}
          opacity={ditherOpacity}
          seed={seed + 2}
          blendMode="screen"
        />
      </div>

      {/* Crop-mark HUD brackets at the leading edge of a sweep front, the
          archive/HUD language from dither-hourglass-glitch. Only for sweep. */}
      {mode === "sweep" ? <SweepBrackets opacity={0.5 * (0.4 + densityVal)} /> : null}
    </div>
  );
};

// An offset, hue-shoved copy of the children for the channel-split tear. sepia
// recolors any content to a warm base, then hue-rotate/saturate pushes it toward
// Re-entry Red or Eclipse Gold; the two copies screen-blend into the warm retint
// of a classic chromatic-aberration RGB split. Content-agnostic + deterministic.
const channelLayer = (offsetPx: number, channel: "red" | "gold"): React.CSSProperties => ({
  filter:
    channel === "red"
      ? "sepia(1) saturate(6) hue-rotate(-25deg) brightness(1.05)"
      : "sepia(1) saturate(5) hue-rotate(8deg) brightness(1.1)",
  inset: 0,
  mixBlendMode: "screen",
  opacity: 0.8,
  position: "absolute",
  transform: `translateX(${offsetPx}px)`,
});

// Corner crop-mark brackets, drawn with thin cream rules. HUD overlay language.
const SweepBrackets: React.FC<{ opacity: number }> = ({ opacity }) => {
  const len = 42;
  const inset = 40;
  const rule = `2px solid ${withAlpha(colors.starlightCream, 0.8)}`;
  const corner = (
    pos: { top?: number; bottom?: number; left?: number; right?: number },
    borders: React.CSSProperties,
  ): React.CSSProperties => ({
    height: len,
    position: "absolute",
    width: len,
    ...pos,
    ...borders,
  });
  return (
    <div aria-hidden style={{ inset: 0, opacity, position: "absolute" }}>
      <div style={corner({ left: inset, top: inset }, { borderLeft: rule, borderTop: rule })} />
      <div style={corner({ right: inset, top: inset }, { borderRight: rule, borderTop: rule })} />
      <div
        style={corner({ bottom: inset, left: inset }, { borderBottom: rule, borderLeft: rule })}
      />
      <div
        style={corner({ bottom: inset, right: inset }, { borderBottom: rule, borderRight: rule })}
      />
    </div>
  );
};
