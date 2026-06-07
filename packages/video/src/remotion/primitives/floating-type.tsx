import { useCurrentFrame, useVideoConfig } from "remotion";
import { colors } from "@fluncle/tokens";
import { OXANIUM_STACK } from "../fonts";
import { type CosmosTrack } from "../types";

export type FloatingTypeVariant = "brandMark" | "trackLine" | "meta" | "body";

export type FloatingTypeProps = {
  /** Which typographic role to render. */
  variant: FloatingTypeVariant;
  /**
   * Gentle float amplitude in px (the type drifts up and down like the figure).
   * 0 disables. Default 6.
   */
  drift?: number;
  /** Float period in seconds. Default 5. */
  driftPeriodSec?: number;
  /** Phase offset so stacked lines don't bob in lockstep. Default 0. */
  driftPhase?: number;
  /** Ink color override; defaults per variant. */
  color?: string;
  /** Font size in px override; defaults per variant. */
  fontSize?: number;
  /** Text align. Default "left". */
  align?: React.CSSProperties["textAlign"];

  // --- variant data ---
  /** brandMark: the wordmark text. Default "Fluncle". */
  mark?: string;
  /** trackLine / meta: the track to format. */
  track?: Pick<CosmosTrack, "title" | "artists" | "discoveredAt">;
  /** body: free text (sentence case, no exclamation marks per VOICE.md). */
  text?: string;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Discovered Jun 4" — discovery date, tabular, no leading zero (VOICE.md). */
const formatDiscovered = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return "Discovered";
  }
  // Use UTC so the same ISO always renders the same date regardless of host TZ
  // (determinism: renders must not depend on the machine's clock/timezone).
  return `Discovered ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
};

/**
 * Typography primitive for the four sanctioned roles, with a gentle float.
 *
 * Brand rules baked in (DESIGN.md + VOICE.md):
 * - Oxanium speaks for the brand and numbers: brandMark uses Oxanium 800, meta
 *   uses Oxanium tabular-nums for the date. trackLine + body read in the system
 *   sans (The One Voice Rule).
 * - trackLine renders `Artist — Title` with an em dash, the ONLY sanctioned em
 *   dash in the system. Multiple artists join with ", ".
 * - meta renders the "Discovered Jun 4" discovery date, tabular.
 * - Sentence case by default; no exclamation marks anywhere (The Dry Rule). This
 *   component never adds punctuation; it only formats what it is given.
 *
 * Determinism: float is frame-derived (sine of frame/fps), never wall-clock; the
 * date is formatted in UTC.
 */
export const FloatingType: React.FC<FloatingTypeProps> = ({
  variant,
  drift = 6,
  driftPeriodSec = 5,
  driftPhase = 0,
  color,
  fontSize,
  align = "left",
  mark = "Fluncle",
  track,
  text,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const seconds = frame / fps;
  const dy =
    drift > 0 ? Math.sin((seconds / driftPeriodSec) * Math.PI * 2 + driftPhase) * drift : 0;

  const base: React.CSSProperties = {
    margin: 0,
    textAlign: align,
    transform: `translateY(${dy}px)`,
  };

  if (variant === "brandMark") {
    return (
      <div
        style={{
          ...base,
          color: color ?? colors.eclipseGold,
          fontFamily: OXANIUM_STACK,
          fontSize: fontSize ?? 72,
          fontWeight: 800,
          letterSpacing: "-0.02em",
          lineHeight: 1,
        }}
      >
        {mark}
      </div>
    );
  }

  if (variant === "trackLine") {
    const artists = track?.artists?.join(", ") ?? "";
    const title = track?.title ?? "";
    // The only sanctioned em dash in the system (VOICE.md mechanics).
    const line = artists && title ? `${artists} — ${title}` : artists || title;
    return (
      <div
        style={{
          ...base,
          color: color ?? colors.starlightCream,
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          fontSize: fontSize ?? 40,
          fontWeight: 800,
          letterSpacing: "-0.01em",
          lineHeight: 1.18,
        }}
      >
        {line}
      </div>
    );
  }

  if (variant === "meta") {
    return (
      <div
        style={{
          ...base,
          color: color ?? colors.stardust,
          fontFamily: OXANIUM_STACK,
          fontSize: fontSize ?? 26,
          fontVariantNumeric: "tabular-nums",
          fontWeight: 400,
          letterSpacing: "-0.02em",
        }}
      >
        {track ? formatDiscovered(track.discoveredAt) : ""}
      </div>
    );
  }

  // body
  return (
    <div
      style={{
        ...base,
        color: color ?? colors.stardust,
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        fontSize: fontSize ?? 24,
        fontWeight: 400,
        lineHeight: 1.25,
      }}
    >
      {text ?? ""}
    </div>
  );
};
