import { Composition, type CalculateMetadataFunction } from "remotion";
import { colors } from "@fluncle/tokens";
import { NostalgicCosmos } from "./nostalgic-cosmos";
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
    // defaults just let Studio open the exemplar with matching audio.
    bassCurve: [],
    beatGrid: [],
    bpm: 171.43,
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

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="NostalgicCosmos"
      component={NostalgicCosmos}
      durationInFrames={Math.round((defaultProps.audio.durationMs / 1000) * FPS)}
      fps={FPS}
      width={WIDTH}
      height={HEIGHT}
      defaultProps={defaultProps}
      calculateMetadata={calculateMetadata}
    />
  );
};
