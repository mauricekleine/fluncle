import { colors } from "@fluncle/tokens";
import { type CSSProperties } from "react";
import { withAlpha } from "../color";
import { useBass, useEnergy, useOnset } from "../hooks";
import { type CosmosAudio } from "../types";
import { useJourney, type UseJourneyOptions } from "./use-journey";

/**
 * Which line-field geometry the vehicle draws.
 * - "ridge": stacked horizontal lines displaced upward into terrain (the
 *   Unknown Pleasures waveform-ridge motif; data-as-landscape).
 * - "contour": fine lines parting around a focal point (gravitational
 *   displacement; contour-eclipse-lines).
 * - "blinds": vertical bars with a height ramp (an equalizer rendered as
 *   venetian blinds; waveform-blinds-heat-ramp).
 */
export type JourneyLinesMode = "ridge" | "contour" | "blinds";

/**
 * Built-in displacement presets that sample the audio curves passed via `audio`.
 * - "energy": the overall energy curve drives displacement height.
 * - "bass": the low-end curve drives it (heavier, slower swells).
 * - "onset": transient flashes spike the field on each onset.
 * Use a custom displacement function instead for full creative control.
 */
export type JourneyLinesPreset = "energy" | "bass" | "onset";

/**
 * The semi-headless displacement field. Either a preset name (sampling the audio
 * curves) or a custom function: given `x` (0..1 across the field) and `arc`
 * (the eased journey progress), return a displacement amount 0..1. The custom
 * form is the creative slot for hand-authored terrain, math fields, or focal
 * shaping. Must be pure (no randomness, no wall clock) to stay deterministic.
 */
export type JourneyLinesDisplacement = JourneyLinesPreset | ((x: number, arc: number) => number);

export type JourneyLinesProps = {
  /** Field geometry. Default "ridge". */
  mode?: JourneyLinesMode;
  /**
   * Displacement field driving the line shapes. Preset (samples `audio`) or a
   * custom (x, arc) => 0..1 function. Default "energy".
   */
  displacement?: JourneyLinesDisplacement;
  /**
   * Audio curves for the presets. Required for "energy"/"bass"/"onset" to do
   * anything; ignored by a custom displacement function. Pass the composition's
   * audio prop.
   */
  audio?: Pick<CosmosAudio, "energyCurve" | "bassCurve" | "onsets">;
  /**
   * Journey clock options forwarded to useJourney so the field evolves on the
   * same arc as every other vehicle. Default phases 0.15/0.85.
   */
  journey?: UseJourneyOptions;
  /** Number of lines (ridge/contour) or bars (blinds). Default 48. */
  lineCount?: number;
  /** Line / bar color. Default Starlight Cream (the system ink). */
  color?: string;
  /**
   * Index of the ONE line/crest/bar that catches Eclipse Gold (the One Sun
   * discipline: a single lit element in the field). -1 disables. Default is the
   * middle line. The accent line also gets a faint gold glow.
   */
  accentIndex?: number;
  /** Accent color for the one lit line. Default Eclipse Gold. */
  accentColor?: string;
  /**
   * How strongly displacement pushes lines, as a fraction of the field height
   * (ridge/contour) or bar height (blinds). Default 0.55.
   */
  amplitude?: number;
  /** Stroke width of each line in px (ignored for blinds, which use bar width). Default 2. */
  strokeWidth?: number;
  /**
   * How fast the displacement field scrolls/evolves with the journey arc. The
   * field's horizontal phase advances by `travel` full cycles over the clip, so
   * the terrain reads as travelling. 0 freezes it. Default 1.
   */
  travel?: number;
  /**
   * Focal point for "contour" mode (0..1 fractional coords). Lines part around
   * it, densest and most displaced near the point. Ignored by other modes.
   * Default frame center.
   */
  focal?: { x: number; y: number };
  /** Field width/height in px. Defaults fill the 1080x1920 frame. */
  width?: number;
  height?: number;
  /** Extra styles merged onto the absolutely-positioned field wrapper. */
  style?: CSSProperties;
};

/** Smooth bell falloff (0..1) around a center, width controlling the spread. */
const bell = (distance: number, spread: number): number => {
  const t = distance / Math.max(0.0001, spread);
  return Math.exp(-(t * t));
};

/**
 * The lines vehicle: a field of displaced lines that travels as terrain or
 * signal across the clip. Owns GEOMETRY (ridge/contour/blinds layouts), MOTION
 * (the field scrolls with the journey arc), and BRAND LAW (Starlight Cream ink,
 * one Eclipse Gold accent line, determinism). The consuming agent owns the
 * displacement field (preset or custom function) and the accent placement.
 *
 * Moodboard: waveform-ridge (stacked terrain), contour-eclipse-lines (parting
 * around a focal point), waveform-blinds-heat-ramp (vertical equalizer bars).
 * The One Sun discipline: exactly one line catches gold; the rest are cream.
 *
 * Pure and deterministic: every line position derives from the journey clock and
 * the audio curves only. No randomness, no wall clock; CPU-friendly SVG only.
 */
export const JourneyLines: React.FC<JourneyLinesProps> = ({
  mode = "ridge",
  displacement = "energy",
  audio,
  journey,
  lineCount = 48,
  color = colors.starlightCream,
  accentIndex,
  accentColor = colors.eclipseGold,
  amplitude = 0.55,
  strokeWidth = 2,
  travel = 1,
  focal = { x: 0.5, y: 0.5 },
  width = 1080,
  height = 1920,
  style,
}) => {
  const { arc } = useJourney(journey);

  // Resolve audio-driven scalars once; presets read these per-line.
  const energy = useEnergy(audio?.energyCurve ?? []);
  const bass = useBass(audio?.bassCurve ?? []);
  const onset = useOnset(audio?.onsets ?? []);

  const resolvedAccent = accentIndex === undefined ? Math.floor(lineCount / 2) : accentIndex;

  // The travelling phase: advances `travel` full cycles over the eased arc.
  const phase = arc * travel * Math.PI * 2;

  /**
   * Displacement at fractional x (0..1). A custom function gets (x, arc); a
   * preset blends an audio scalar with a travelling sinus so the field reads as
   * moving terrain rather than a static curve. Returns ~0..1.
   */
  const displaceAt = (x: number): number => {
    if (typeof displacement === "function") {
      return Math.min(1, Math.max(0, displacement(x, arc)));
    }
    const scalar = displacement === "bass" ? bass : displacement === "onset" ? onset : energy;
    // A travelling ridge: two summed sines scrolled by the journey phase,
    // gated by the audio scalar so silence flattens the field.
    const wave =
      0.5 +
      0.32 * Math.sin(x * Math.PI * 6 + phase) +
      0.18 * Math.sin(x * Math.PI * 13 - phase * 1.7);
    return Math.min(1, Math.max(0, wave * (0.35 + scalar * 0.65)));
  };

  const renderLine = (i: number): React.ReactNode => {
    const isAccent = i === resolvedAccent;
    const stroke = isAccent ? accentColor : color;
    const baseOpacity = isAccent ? 0.95 : 0.5 + (i / lineCount) * 0.25;

    if (mode === "blinds") {
      // Vertical bars: each bar's height ramps from the displacement field.
      const x = lineCount <= 1 ? 0.5 : i / (lineCount - 1);
      const d = displaceAt(x);
      const barH = (0.12 + d * amplitude) * height;
      const barW = (width / lineCount) * 0.62;
      return (
        <rect
          key={i}
          x={x * width - barW / 2}
          y={height - barH}
          width={barW}
          height={barH}
          fill={stroke}
          opacity={baseOpacity}
          rx={barW * 0.3}
          style={
            isAccent
              ? { filter: `drop-shadow(0 0 ${barW * 0.9}px ${withAlpha(accentColor, 0.6)})` }
              : undefined
          }
        />
      );
    }

    // ridge / contour: a horizontal polyline displaced upward per sample.
    const rowY = lineCount <= 1 ? 0.5 : i / (lineCount - 1);
    const samples = 64;
    const points: string[] = [];
    for (let s = 0; s <= samples; s++) {
      const x = s / samples;
      let d = displaceAt(x);
      if (mode === "contour") {
        // Lines part around the focal point: displacement peaks near it, and
        // the line itself bows away from the focal row.
        const focalPull = bell(Math.abs(x - focal.x), 0.22);
        const rowGap = (rowY - focal.y) * focalPull;
        d = d * 0.4 + focalPull * 0.6;
        const py = (rowY + rowGap * 0.35 - d * amplitude * focalPull) * height;
        points.push(`${(x * width).toFixed(1)},${py.toFixed(1)}`);
      } else {
        // ridge: each line is a baseline pushed upward by the field; far rows
        // (higher i) ride higher so the stack reads as receding terrain.
        const lift = d * amplitude * (0.5 + rowY * 0.5);
        const py = (rowY - lift) * height;
        points.push(`${(x * width).toFixed(1)},${py.toFixed(1)}`);
      }
    }
    return (
      <polyline
        key={i}
        points={points.join(" ")}
        fill="none"
        stroke={stroke}
        strokeWidth={isAccent ? strokeWidth * 1.5 : strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={baseOpacity}
        style={
          isAccent
            ? { filter: `drop-shadow(0 0 ${strokeWidth * 4}px ${withAlpha(accentColor, 0.5)})` }
            : undefined
        }
      />
    );
  };

  const lines: React.ReactNode[] = [];
  for (let i = 0; i < lineCount; i++) {
    lines.push(renderLine(i));
  }

  return (
    <div
      aria-hidden
      style={{
        height,
        pointerEvents: "none",
        position: "absolute",
        width,
        ...style,
      }}
    >
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        style={{ display: "block", height: "100%", width: "100%" }}
      >
        {lines}
      </svg>
    </div>
  );
};
