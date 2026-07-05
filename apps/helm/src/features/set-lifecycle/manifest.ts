// set-lifecycle — the post-set ritual as one guided surface. A DJ set's whole
// life on the Log-ID spine: capture a take (M5), derive its cues from Rekordbox
// (M2), promote it to a minted mixtape, distribute the masters (M5). The shelf
// (listRecordings) is the lifecycle board — plan → take → promoted — and lives on
// both Macs; the machine-heavy actions gate themselves inside the panel.

import { type FeatureManifest } from "../types";

export const manifest: FeatureManifest = {
  id: "set-lifecycle",
  machines: ["m2", "m5"],
  order: 20,
  title: "Set lifecycle",
};
