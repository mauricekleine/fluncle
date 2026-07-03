// Unit O · the set render's Remotion root — a SEPARATE entry from the per-track
// root.tsx (render.ts), so the hour render is fully isolated: it registers only
// the FluncleSet composition, resolves the prepped chapter comps via
// set-composition.tsx's require.context over the gitignored set-workbench, and
// never pulls the per-track workbench into its bundle. render-set.ts bundles
// set-entry.ts and renders "FluncleSet" in frameRange chunks.

import { Composition } from "remotion";

import { calculateSetMetadata, SetComposition, type SetCompositionProps } from "./set-composition";

// A contract-default so Studio can open the composition with an empty set; real
// values come from render-set.ts via inputProps (calculateMetadata sums them).
const defaultProps: SetCompositionProps = {
  chapters: [],
  continuity: { energy: [], hopMs: 100 },
  fps: 30,
  hideOverlay: true,
  mixtape: { logId: "000.F.0A", title: "Fluncle Mixtape" },
};

export const SetRoot: React.FC = () => (
  <Composition
    id="FluncleSet"
    component={SetComposition}
    defaultProps={defaultProps}
    calculateMetadata={calculateSetMetadata}
    durationInFrames={1}
    fps={30}
    width={1920}
    height={1080}
  />
);
