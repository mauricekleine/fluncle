import { Composition } from "remotion";

import { calculateExplainerMetadata, ExplainerComposition } from "./explainer-composition";
import { pipelineTour, pipelineTourPortrait, pipelineTourSquare } from "./pipeline-tour";
import { FPS, HEIGHT, WIDTH } from "./theme";

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
