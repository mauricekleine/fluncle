// The Explainer family's Remotion root — a SEPARATE entry from the per-track
// root.tsx, like set-root.tsx. It registers the reusable ExplainerComposition
// and opens on the Pipeline Tour manifest. Add a new video by pointing a new
// Composition at another manifest (or swap defaultProps via inputProps).

import { Composition } from "remotion";

import { calculateExplainerMetadata, ExplainerComposition } from "./explainer-composition";
import { pipelineTour, pipelineTourPortrait, pipelineTourSquare } from "./pipeline-tour";
import { FPS, HEIGHT, WIDTH } from "./theme";

// The same tour in three aspect ratios. calculateMetadata reads width/height off
// each manifest, so the placeholder durationInFrames/width/height here are just
// what Studio shows before the manifest resolves.
export const ExplainerRoot: React.FC = () => (
  <>
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
    <Composition
      calculateMetadata={calculateExplainerMetadata}
      component={ExplainerComposition}
      defaultProps={{ manifest: pipelineTourPortrait }}
      durationInFrames={1}
      fps={FPS}
      height={WIDTH}
      id="PipelineTourPortrait"
      width={HEIGHT}
    />
    <Composition
      calculateMetadata={calculateExplainerMetadata}
      component={ExplainerComposition}
      defaultProps={{ manifest: pipelineTourSquare }}
      durationInFrames={1}
      fps={FPS}
      height={HEIGHT}
      id="PipelineTourSquare"
      width={HEIGHT}
    />
  </>
);
