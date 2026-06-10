import { useCurrentFrame, useVideoConfig } from "remotion";
import { interpolate } from "remotion";
import { type CosmosTrack } from "../types";
import { FloatingType } from "./floating-type";

// <TypePlate> — the fixed informational type system every Fluncle video shares.
//
// The art varies; the information does not. Predictable facts get a predictable
// home, so the plate is brand LAW (DESIGN.md): two blocks, two fixed corners,
// two type voices, category-separated:
//
//   IDENTITY (lower-left, scene ink, system sans)
//     Artist — Title          ← the music, the reason the clip exists
//     Label (2018)            ← provenance: label + release YEAR, subordinate,
//                               dim. Year in parens per VOICE.md (the caption's
//                               convention); degrades to label-only or year-only.
//
//   TELEMETRY (upper-right, right-aligned, Oxanium tabular, dim)
//     Found Jun 3             ← the logbook stamp
//     007.8.1B                ← the finding's coordinate
//
// Identity and telemetry are different CATEGORIES and never share a stack —
// the split is spatial (opposite corners) and typographic (warm sans vs
// instrument numerals), so each reads at a glance as what it is.
//
// TIMING is prescriptive and shared by every clip: identity enters first,
// telemetry boots shortly after like a HUD stamp, both clear well before the
// drop so the climax plays on pure art, and the CloseCard owns the ending.
// Scenes may nudge the in-points onto a musical seam (`identityInSec` /
// `telemetryInSec`); the placement is not nudgeable.
//
// LEGIBILITY comes from FloatingType's ink halo plus the calm fixed corners
// and the text-free drop window — no scrim, no backdrop box (the old radial
// scrim printed a visible rectangle over bright passages; removed).
//
// Determinism: every envelope derives from useCurrentFrame()/fps.

export type TypePlateProps = {
  /** The track whose facts are rendered. Only props-exposed fields appear. */
  track: Pick<
    CosmosTrack,
    "title" | "artists" | "discoveredAt" | "logId" | "label" | "releaseDate"
  >;
  /**
   * Primary ink for the track line — drawn from the COMPOSITION (doctrine 4),
   * default Starlight Cream. Gold is the sun, never the type.
   */
  ink?: string;
  /** Dim ink for label / date / Log ID. Default Stardust. */
  dimInk?: string;
  /**
   * When the identity block enters, in seconds. Default 1.0. Nudge onto a
   * musical seam if the intro asks for it; keep it inside the first quarter.
   */
  identityInSec?: number;
  /** When the telemetry block enters, in seconds. Default 2.2 (after identity). */
  telemetryInSec?: number;
  /** How long each block holds before fading, in seconds. Default 6.0. */
  holdSec?: number;
  /** Float amplitude multiplier passed through to FloatingType. Default 1. */
  floatBoost?: number;
};

// The shared safe inset (1080×1920, platform-chrome safe). The plate owns these
// so compositions stop re-deriving them.
//
// TikTok safe zones (2026): the top band is unsafe to ~140px in the normal feed,
// but to ~280px once the in-app "Find related content" search bar is present
// (opening a video from a profile or search — i.e. exactly how the owner reviews
// their own posts). The right edge carries the action rail (~120px wide) but only
// from mid-frame down, so the UPPER-right stays clear above it. So telemetry lives
// below the search-bar band (SAFE_TOP) and right-aligned above the rail; identity
// sits above the bottom caption band (SAFE_BOTTOM). Verified against live posts.
const MARGIN_X = 96;
const SAFE_TOP = 300; // clears the in-app search bar (~280px), not just the feed top bar
const SAFE_BOTTOM = 230;

const FADE = 0.8;

/**
 * The provenance line: label and release year, the two release credits, joined
 * as `Label (2018)`. Parens are the sanctioned year form (VOICE.md / the
 * caption); the year is a catalog credit beside the label, never confused with
 * Fluncle's Found date. Degrades to label-only, bare year, or nothing.
 */
export const provenanceLine = (label?: string, releaseDate?: string): string | null => {
  const year = releaseDate?.slice(0, 4);
  const hasYear = year ? /^\d{4}$/.test(year) : false;
  if (label && hasYear) {
    return `${label} (${year})`;
  }
  if (label) {
    return label;
  }
  return hasYear ? year! : null;
};

/** 0..1 presence envelope: eased fade in at `inSec`, hold, eased fade out. */
const useEnvelope = (inSec: number, outSec: number): { opacity: number; rise: number } => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const sec = frame / fps;

  const opacity = interpolate(sec, [inSec, inSec + FADE, outSec - FADE, outSec], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  // A gentle settle on entry, a gentle lift on exit — never a slide.
  const rise = interpolate(sec, [inSec, inSec + FADE, outSec - FADE, outSec], [14, 0, 0, -10], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return { opacity, rise };
};

/**
 * The plate. Drop it once, above the scene layers and inside no other inset —
 * it owns its own fixed corners. Renders only fields the track exposes.
 */
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

  const provenance = provenanceLine(track.label, track.releaseDate);

  return (
    <>
      {/* IDENTITY — lower-left. The music first; provenance beneath, subordinate. */}
      {identity.opacity > 0.001 ? (
        <div
          style={{
            bottom: SAFE_BOTTOM,
            display: "flex",
            flexDirection: "column",
            gap: 10,
            left: MARGIN_X,
            opacity: identity.opacity,
            position: "absolute",
            right: MARGIN_X, // wraps long titles inside the safe inset
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

      {/* TELEMETRY — upper-right, right-aligned. The logbook stamp: date over
          coordinate, instrument numerals, dim. A different category in a
          different corner in a different voice. */}
      {telemetry.opacity > 0.001 ? (
        <div
          style={{
            alignItems: "flex-end",
            display: "flex",
            flexDirection: "column",
            gap: 8,
            opacity: telemetry.opacity,
            position: "absolute",
            right: MARGIN_X,
            top: SAFE_TOP,
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
