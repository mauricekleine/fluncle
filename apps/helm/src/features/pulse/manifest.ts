// pulse — the rig's heartbeat, on both Macs. The render queue, the surface probe,
// the show's liveness, the daemon's own vitals, and the operator's single next
// thing to post — one board that says, at a glance, what the machine is doing and
// what it's waiting on. Absorbs the old pulse-lite reference (its notify + line
// check live on as the daemon vitals + the nudge test hook).

import { type FeatureManifest } from "../types";

export const manifest: FeatureManifest = {
  id: "pulse",
  machines: ["m2", "m5"],
  order: 90,
  title: "Pulse",
};
