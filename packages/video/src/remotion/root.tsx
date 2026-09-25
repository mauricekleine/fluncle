import { Composition, type CalculateMetadataFunction } from "remotion";
import { colors } from "@fluncle/tokens";

import { Cover } from "./cover";
import { GlProbe } from "./gl-probe";
import { type NostalgicCosmosProps } from "./types";

declare global {
  // oxlint-disable-next-line typescript/consistent-type-definitions
  interface ImportMeta {
    webpackContext: (
      dir: string,
      options: { recursive: boolean; regExp: RegExp },
    ) => {
      keys: () => string[];
      (id: string): Record<string, unknown>;
    };
  }
}

const FPS = 30;

const WIDTH = 1080;
const HEIGHT = 1920;
const LANDSCAPE_WIDTH = 1920;
const LANDSCAPE_HEIGHT = 1080;
const SQUARE_SIZE = 1920;

const calculateMetadata: CalculateMetadataFunction<NostalgicCosmosProps> = ({ props }) => {
  const dimensions =
    props.aspect === "landscape"
      ? { height: LANDSCAPE_HEIGHT, width: LANDSCAPE_WIDTH }
      : props.aspect === "square"
        ? { height: SQUARE_SIZE, width: SQUARE_SIZE }
        : { height: HEIGHT, width: WIDTH };
  return {
    durationInFrames: Math.max(1, Math.round((props.audio.durationMs / 1000) * FPS)),
    fps: FPS,
    ...dimensions,
  };
};

const defaultProps: NostalgicCosmosProps = {
  audio: {
    bassCurve: [],
    beatGrid: [],
    bpm: 174,
    durationMs: 20000,
    energyCurve: [],
    file: "0mK92Hp80kOOhn086qcDgZ.m4a",
    fluxCurve: [],
    midCurve: [],
    onsets: [],
    rawDynamicsHint: { bass: 0, mid: 0, treble: 0 },
    startMs: 9950,
    trebleCurve: [],
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

const workbenchContext = import.meta.webpackContext("./workbench", {
  recursive: false,
  regExp: /\.tsx$/,
});
const trackCompositions: Array<{
  component: React.FC<NostalgicCosmosProps>;
  id: string;
}> = workbenchContext
  .keys()
  .sort()
  .flatMap((key) => {
    const mod = workbenchContext(key);
    const candidate =
      mod.default ?? Object.values(mod).find((value) => typeof value === "function");
    if (typeof candidate !== "function") {
      return [];
    }
    const id = key.replace(/^\.\//, "").replace(/\.tsx$/, "");
    return [{ component: candidate as React.FC<NostalgicCosmosProps>, id }];
  });

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

      <Composition
        component={Cover}
        defaultProps={{
          dimInk: colors.stardust,
          ink: colors.starlightCream,
          track: defaultProps.track,
        }}
        durationInFrames={1}
        fps={FPS}
        height={HEIGHT}
        id="Cover"
        width={WIDTH}
      />
    </>
  );
};
