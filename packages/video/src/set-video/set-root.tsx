import { Composition } from "remotion";

import { calculateSetMetadata, SetComposition, type SetCompositionProps } from "./set-composition";

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
