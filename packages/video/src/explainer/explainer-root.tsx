// The Explainer family's Remotion root — a SEPARATE entry from the per-track
// root.tsx, like set-root.tsx. It registers the reusable ExplainerComposition
// and opens on the Pipeline Tour manifest. Add a new video by pointing a new
// Composition at another manifest (or swap defaultProps via inputProps).

import { Composition } from "remotion";

import { calculateExplainerMetadata, ExplainerComposition } from "./explainer-composition";
import { pipelineTour } from "./pipeline-tour";
import { FPS, HEIGHT, WIDTH } from "./theme";

export const ExplainerRoot: React.FC = () => (
  <Composition
    calculateMetadata={calculateExplainerMetadata}
    component={ExplainerComposition}
    defaultProps={{ manifest: pipelineTour }}
    durationInFrames={1}
    fps={FPS}
    height={HEIGHT}
    id="PipelineTour"
    width={WIDTH}
  />
);
