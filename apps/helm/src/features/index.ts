// THE FEATURE REGISTRY — the only shared touch point between units.
//
// Registering a feature is ONE line: add its directory name to `featureIds`
// (collisions between parallel units stay one-line and trivial). The daemon
// then loads src/features/<id>/{manifest.ts,server.ts} and the glass lazy-loads
// src/features/<id>/panel.tsx by the same convention — nothing else to wire.

export const featureIds = ["pulse"] as const;

export type FeatureId = (typeof featureIds)[number];
