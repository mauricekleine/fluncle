// Unit O · the set render's Remotion webpack entry — the isolated bundle root
// render-set.ts points @remotion/bundler at. Registers only the FluncleSet root.
import { registerRoot } from "remotion";

import { SetRoot } from "./set-root";

registerRoot(SetRoot);
