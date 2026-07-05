// show-control — raise the live glass from the Helm (M5, the build/compose +
// capture/stream machine; AGENTS.md's two-Mac split). The station picks a
// tracklist (a plan by its galaxy-slug handle, or a published mixtape by its Log
// ID) and spawns `bun run --cwd packages/live show --plan <ref>` under the
// daemon, then reads the show's pre-flight tokens back as a live checklist.

import { type FeatureManifest } from "../types";

export const manifest: FeatureManifest = {
  id: "show-control",
  machines: ["m5"],
  order: 10,
  title: "Show",
};
