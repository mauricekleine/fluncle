import { AbsoluteFill, Img } from "remotion";
import { colors } from "@fluncle/tokens";

import { FloatingType } from "./primitives/floating-type";
import { provenanceLine } from "./primitives/type-plate";
import { type CosmosTrack } from "./types";

export type CoverProps = {
  track: Pick<
    CosmosTrack,
    "title" | "artists" | "label" | "releaseDate" | "discoveredAt" | "logId"
  >;

  background?: string;

  ink?: string;

  dimInk?: string;
};

export const Cover: React.FC<CoverProps> = ({ track, background, ink, dimInk }) => {
  const provenance = provenanceLine(track.label, track.releaseDate);

  return (
    <AbsoluteFill style={{ backgroundColor: colors.deepField }}>
      {background ? (
        <Img src={background} style={{ height: "100%", objectFit: "cover", width: "100%" }} />
      ) : null}

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
