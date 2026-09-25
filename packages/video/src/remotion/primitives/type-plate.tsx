import { getInputProps, useCurrentFrame, useVideoConfig } from "remotion";
import { interpolate } from "remotion";
import { type CosmosTrack } from "../types";
import { FloatingType } from "./floating-type";

export type TypePlateProps = {
  track: Pick<
    CosmosTrack,
    "title" | "artists" | "discoveredAt" | "logId" | "label" | "releaseDate"
  >;

  ink?: string;

  dimInk?: string;

  identityInSec?: number;

  telemetryInSec?: number;

  holdSec?: number;

  floatBoost?: number;
};

const MARGIN_X = 96;
const SAFE_TOP = 300;
const SAFE_BOTTOM = 230;

const FADE = 0.8;

const IDENTITY_STYLE: React.CSSProperties = {
  bottom: SAFE_BOTTOM,
  display: "flex",
  flexDirection: "column",
  gap: 10,
  left: MARGIN_X,
  position: "absolute",
  right: MARGIN_X,
};
const TELEMETRY_STYLE: React.CSSProperties = {
  alignItems: "flex-end",
  display: "flex",
  flexDirection: "column",
  gap: 8,
  position: "absolute",
  right: MARGIN_X,
  top: SAFE_TOP,
};

export const provenanceLine = (label?: string, releaseDate?: string): string | null => {
  const sliced = releaseDate?.slice(0, 4);
  const year = sliced && /^\d{4}$/.test(sliced) ? sliced : null;
  if (label && year) {
    return `${label} (${year})`;
  }
  if (label) {
    return label;
  }
  return year;
};

const useEnvelope = (inSec: number, outSec: number): { opacity: number; rise: number } => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const sec = frame / fps;

  const opacity = interpolate(sec, [inSec, inSec + FADE, outSec - FADE, outSec], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const rise = interpolate(sec, [inSec, inSec + FADE, outSec - FADE, outSec], [14, 0, 0, -10], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return { opacity, rise };
};

export const TypePlate: React.FC<TypePlateProps> = ({
  track,
  ink,
  dimInk,
  identityInSec = 1.0,
  telemetryInSec = 2.2,
  holdSec = 6.0,
  floatBoost = 1,
}) => {
  const identity = useEnvelope(identityInSec, identityInSec + holdSec);
  const telemetry = useEnvelope(telemetryInSec, telemetryInSec + holdSec);

  if ((getInputProps() as { hideOverlay?: boolean }).hideOverlay) {
    return null;
  }

  const provenance = provenanceLine(track.label, track.releaseDate);

  return (
    <>
      {identity.opacity > 0.001 ? (
        <div
          style={{
            ...IDENTITY_STYLE,
            opacity: identity.opacity,
            transform: `translateY(${identity.rise}px)`,
          }}
        >
          <FloatingType
            variant="trackLine"
            track={track}
            fontSize={40}
            drift={5 * floatBoost}
            align="left"
            color={ink}
          />
          {provenance ? (
            <FloatingType
              variant="body"
              text={provenance}
              fontSize={23}
              drift={5 * floatBoost}
              driftPhase={0.5}
              align="left"
              color={dimInk}
            />
          ) : null}
        </div>
      ) : null}

      {telemetry.opacity > 0.001 ? (
        <div
          style={{
            ...TELEMETRY_STYLE,
            opacity: telemetry.opacity,
            transform: `translateY(${telemetry.rise}px)`,
          }}
        >
          <FloatingType
            variant="meta"
            track={track}
            fontSize={24}
            drift={4 * floatBoost}
            driftPhase={1.1}
            align="right"
            color={dimInk}
          />
          {track.logId ? (
            <FloatingType
              variant="logId"
              track={track}
              fontSize={21}
              drift={4 * floatBoost}
              driftPhase={1.4}
              align="right"
              color={dimInk}
            />
          ) : null}
        </div>
      ) : null}
    </>
  );
};
