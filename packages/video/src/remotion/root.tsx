// Composition registry. Generated track compositions are temporary workbench
// sources: register one here while rendering, then ship its source as
// composition.tsx in the R2 bundle and remove the local file before commit.

import { Composition, type CalculateMetadataFunction } from "remotion";
import { colors } from "@fluncle/tokens";

import { GlProbe } from "./gl-probe";
import { type NostalgicCosmosProps } from "./types";

const FPS = 30;
const WIDTH = 1080;
const HEIGHT = 1920;

// durationInFrames is derived from audio.durationMs so the video always matches
// the audio clip length regardless of the default placeholder duration.
const calculateMetadata: CalculateMetadataFunction<NostalgicCosmosProps> = ({ props }) => {
  return {
    durationInFrames: Math.max(1, Math.round((props.audio.durationMs / 1000) * FPS)),
    fps: FPS,
    height: HEIGHT,
    width: WIDTH,
  };
};

// Contract-default props. Real values come from the social-preview pipeline.
const defaultProps: NostalgicCosmosProps = {
  audio: {
    // Real analysed clip from the social-preview pipeline (gitignored .m4a under
    // public/). Per-track props come from out/<trackId>.props.json; these
    // defaults just let Studio open a composition with matching audio.
    bassCurve: [],
    beatGrid: [],
    bpm: 174,
    durationMs: 20000,
    energyCurve: [],
    file: "0mK92Hp80kOOhn086qcDgZ.m4a",
    onsets: [],
    startMs: 9950,
  },
  palette: {
    accent: colors.eclipseGold,
    background: colors.deepField,
    glow: colors.eclipseGlow,
    ink: colors.starlightCream,
    swatches: [colors.eclipseGold, colors.eclipseGlow, colors.reentryRed],
  },
  seed: 1,
  track: {
    album: "Everything In Its Right Place",
    artists: ["Bugwell"],
    artworkUrl: "https://i.scdn.co/image/ab67616d00001e02c545f57d57d46fe27fd6846f",
    discoveredAt: "2026-06-04T11:34:44.716Z",
    title: "Everything In Its Right Place",
    trackId: "0mK92Hp80kOOhn086qcDgZ",
  },
};

// Temporary generated compositions go here while rendering, then their source is
// copied into out/<log-id>/composition.tsx by the ship pipeline and uploaded to
// R2 with the video artifacts.
const trackCompositions: Array<{
  component: React.FC<NostalgicCosmosProps>;
  id: string;
}> = [];

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {trackCompositions.map(({ component, id }) => (
        <Composition
          key={id}
          id={id}
          component={component}
          durationInFrames={Math.round((defaultProps.audio.durationMs / 1000) * FPS)}
          fps={FPS}
          width={WIDTH}
          height={HEIGHT}
          defaultProps={defaultProps}
          calculateMetadata={calculateMetadata}
        />
      ))}
      <Composition
        component={GlProbe}
        durationInFrames={30}
        fps={30}
        height={1920}
        id="GlProbe"
        width={1080}
      />
    </>
  );
};
