// The Explainer family's isolated Remotion webpack entry (`bun run tour:studio`
// points remotion at this). Registers only the Explainer root, so the family
// never pulls the per-track workbench into its bundle.
import { registerRoot } from "remotion";

import { ExplainerRoot } from "./explainer-root";

registerRoot(ExplainerRoot);
