// pulse-lite — the daemon's own vitals, and the end-to-end proof of the feature
// contract (a panel, feature routes, a notification, a streamed run). Units 2-4
// replace/extend around it; read this trio as the reference implementation.

import { type FeatureManifest } from "../types";

export const manifest: FeatureManifest = {
  id: "pulse-lite",
  machines: ["m2", "m5"],
  order: 90,
  title: "Pulse",
};
