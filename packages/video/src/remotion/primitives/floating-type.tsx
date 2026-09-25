import { useCurrentFrame, useVideoConfig } from "remotion";
import { colors } from "@fluncle/tokens";
import { OXANIUM_STACK, SPACE_GROTESK_STACK } from "../fonts";
import { withAlpha } from "../color";
import { type CosmosTrack } from "../types";

export type FloatingTypeVariant = "brandMark" | "trackLine" | "meta" | "body" | "logId";

const inkHalo = (fontSizePx: number, heavy: boolean): string => {
  const u = Math.max(fontSizePx, 32) / 40;
  const ink = colors.deepField;
  const core = heavy ? 0.78 : 0.7;

  return [
    `0 0 ${(1 * u).toFixed(2)}px ${withAlpha(ink, core)}`,
    `0 0 ${(2 * u).toFixed(2)}px ${withAlpha(ink, core)}`,
    `0 0 ${(4 * u).toFixed(2)}px ${withAlpha(ink, core * 0.92)}`,
    `0 0 ${(8 * u).toFixed(2)}px ${withAlpha(ink, core * 0.78)}`,
    `0 0 ${(14 * u).toFixed(2)}px ${withAlpha(ink, core * 0.55)}`,
    `0 ${(1 * u).toFixed(2)}px ${(22 * u).toFixed(2)}px ${withAlpha(ink, core * 0.38)}`,
  ].join(", ");
};

export type FloatingTypeProps = {
  variant: FloatingTypeVariant;

  drift?: number;

  driftPeriodSec?: number;

  driftPhase?: number;

  color?: string;

  fontSize?: number;

  align?: React.CSSProperties["textAlign"];

  mark?: string;

  track?: Pick<CosmosTrack, "title" | "artists" | "discoveredAt" | "logId">;

  text?: string;

  uri?: boolean;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const formatDiscovered = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return "Found";
  }

  return `Found ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
};

function formatTrackLine(track: FloatingTypeProps["track"]): string {
  const artists = track?.artists?.join(", ") ?? "";
  const title = track?.title ?? "";
  return artists && title ? `${artists} — ${title}` : artists || title;
}

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
  uri = false,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const seconds = frame / fps;
  const dy =
    drift > 0 ? Math.sin((seconds / driftPeriodSec) * Math.PI * 2 + driftPhase) * drift : 0;

  let glyph: React.CSSProperties;
  let content: React.ReactNode;
  let size: number;
  let heavy = false;

  if (variant === "brandMark") {
    size = fontSize ?? 72;
    heavy = true;
    glyph = {
      color: color ?? colors.starlightCream,
      fontFamily: OXANIUM_STACK,
      fontSize: size,
      fontWeight: 800,
      letterSpacing: "-0.02em",
      lineHeight: 1,
    };
    content = mark;
  } else if (variant === "trackLine") {
    size = fontSize ?? 40;
    heavy = true;

    glyph = {
      color: color ?? colors.starlightCream,
      fontFamily: SPACE_GROTESK_STACK,
      fontSize: size,

      fontWeight: 700,
      letterSpacing: "-0.01em",
      lineHeight: 1.18,
    };
    content = formatTrackLine(track);
  } else if (variant === "meta") {
    size = fontSize ?? 26;
    glyph = {
      color: color ?? colors.stardust,
      fontFamily: OXANIUM_STACK,
      fontSize: size,
      fontVariantNumeric: "tabular-nums",
      fontWeight: 400,
      letterSpacing: "-0.02em",
    };
    content = track ? formatDiscovered(track.discoveredAt) : "";
  } else if (variant === "logId") {
    size = fontSize ?? 22;
    const coord = track?.logId ?? "";
    glyph = {
      color: color ?? colors.stardust,
      fontFamily: OXANIUM_STACK,
      fontSize: size,
      fontVariantNumeric: "tabular-nums",
      fontWeight: 500,
      letterSpacing: "0.12em",
    };
    content = coord ? (uri ? `fluncle://${coord}` : coord) : "";
  } else {
    size = fontSize ?? 24;
    glyph = {
      color: color ?? colors.stardust,
      fontFamily: SPACE_GROTESK_STACK,
      fontSize: size,
      fontWeight: 400,
      lineHeight: 1.25,
    };
    content = text ?? "";
  }

  return (
    <div
      style={{
        margin: 0,
        textAlign: align,
        transform: `translateY(${dy}px)`,
      }}
    >
      <span
        style={{
          ...glyph,
          display: "inline-block",
          margin: 0,

          textShadow: inkHalo(size, heavy),
        }}
      >
        {content}
      </span>
    </div>
  );
};
