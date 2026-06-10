// Composition registry — a permanent template, never hand-edited per render.
//
// Generated track compositions are output, not codebase history. An agent drops
// its composition into the gitignored `./workbench/` dir; this file AUTO-REGISTERS
// every `.tsx` there via webpack's require.context (Remotion bundles with
// webpack, in both render and Studio). So a render touches no tracked file: no
// registration edit, no cleanup, no commit hazard. The durable copy is the R2
// bundle (`ship` copies the source into out/<log-id>/composition.tsx). The
// composition id is the workbench filename without its extension.

import { Composition, type CalculateMetadataFunction } from "remotion";
import { colors } from "@fluncle/tokens";

import { GlProbe } from "./gl-probe";
import { type NostalgicCosmosProps } from "./types";

// webpack 5 directory globbing. It must be called as a LITERAL
// `import.meta.webpackContext(...)` so webpack can statically replace it at
// build time (aliasing it breaks that). Typed via this ImportMeta augmentation.
declare global {
  // Must be an interface (declaration merging augments the global ImportMeta);
  // a `type` alias cannot merge, and `oxlint --fix` would otherwise break it.
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

// Auto-register every composition in the gitignored ./workbench/ dir. id = the
// filename (sans .tsx); the component is the default export (or the sole
// React component the file exports). Keys are sorted so registration order is
// deterministic. An empty workbench (just .gitkeep) registers nothing.
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
    </>
  );
};
