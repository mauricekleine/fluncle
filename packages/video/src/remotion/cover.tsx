import { AbsoluteFill, Img } from "remotion";
import { colors } from "@fluncle/tokens";

import { FloatingType } from "./primitives/floating-type";
import { provenanceLine } from "./primitives/type-plate";
import { type CosmosTrack } from "./types";

// <Cover> — the profile-grid thumbnail, a DIFFERENT surface from the video.
//
// In the feed the video carries a quiet lower-left identity that reads beautifully
// full-screen but vanishes when TikTok shrinks a frame to a profile-grid cell. The
// grid is a recognition surface: someone scanning @fluncle should spot an artist or
// title they already know at a glance. So the cover is allowed to do what the video
// must not — state the identity LOUD and CENTERED, over a pure-art still.
//
// It is not a frame of the video; it's a still rendered from one. The background is
// a vivid late frame of the track's own footage (passed in as `background`, after
// the in-video TypePlate has cleared, so the art is clean and nothing clashes). Over
// it, the canonical Artist — Title (FloatingType's trackLine, the sanctioned em dash)
// at cover scale, with provenance beneath — both carrying FloatingType's ink halo so
// they lift off any bright wisp, the same contrast guarantee the video uses.
//
// Composed for the grid CROP: the block sits a touch above center so it survives the
// portrait crop and clears TikTok's bottom-left play-count stamp. The operator sets
// this as the post's cover in-app (uploaded from Photos).
//
// Rendered as a still by the render-cover pipeline (renderStill at frame 0); the
// drift is disabled so the type sits still.

export type CoverProps = {
  /** The track whose identity the cover states. */
  track: Pick<
    CosmosTrack,
    "title" | "artists" | "label" | "releaseDate" | "discoveredAt" | "logId"
  >;
  /**
   * The nebula still behind the type: a data URL (or staticFile path) of a vivid
   * late frame of the track's footage. Absent in Studio defaults → solid field.
   */
  background?: string;
  /** Title ink — scene-derived, default Starlight Cream. Gold is the sun, never type. */
  ink?: string;
  /** Provenance ink — default Stardust. */
  dimInk?: string;
};

export const Cover: React.FC<CoverProps> = ({ track, background, ink, dimInk }) => {
  const provenance = provenanceLine(track.label, track.releaseDate);

  return (
    <AbsoluteFill style={{ backgroundColor: colors.deepField }}>
      {background ? (
        <Img src={background} style={{ height: "100%", objectFit: "cover", width: "100%" }} />
      ) : null}

      {/* Identity, loud and dead-centered (the grid crop is symmetric about
          center, so true center survives it and clears the bottom play-count). */}
      <AbsoluteFill
        style={{
          alignItems: "center",
          display: "flex",
          flexDirection: "column",
          gap: 26,
          justifyContent: "center",
          padding: "0 110px",
        }}
      >
        <FloatingType
          variant="trackLine"
          track={track}
          fontSize={76}
          align="center"
          color={ink}
          drift={0}
        />
        {provenance ? (
          <FloatingType
            variant="body"
            text={provenance}
            fontSize={30}
            align="center"
            color={dimInk}
            drift={0}
          />
        ) : null}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
