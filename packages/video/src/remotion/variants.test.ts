// Self-running check for the render-variant provenance helper — no framework.
// Asserts buildVariants() emits the correct per-master render flags so the bundle
// render.json stays self-describing (a clean re-render from source reproduces the
// right cut, not the portrait default). See docs/video-variants.md.
// Run: `bun src/remotion/variants.test.ts` (exits non-zero on failure).

import assert from "node:assert/strict";

import { buildVariants, FOOTAGE_FILENAME, FOOTAGE_SOCIAL_FILENAME } from "./variants";

// Default: both masters, each with its canonical flags.
const both = buildVariants();
assert.deepEqual(both, {
  [FOOTAGE_FILENAME]: { aspect: "square", hideOverlay: true },
  [FOOTAGE_SOCIAL_FILENAME]: { aspect: "portrait", hideOverlay: false },
});

// footage.mp4 is the clean square crop-source master.
assert.equal(both[FOOTAGE_FILENAME]!.aspect, "square");
assert.equal(both[FOOTAGE_FILENAME]!.hideOverlay, true);

// footage.social.mp4 is the portrait baked-text social cut (the render default).
assert.equal(both[FOOTAGE_SOCIAL_FILENAME]!.aspect, "portrait");
assert.equal(both[FOOTAGE_SOCIAL_FILENAME]!.hideOverlay, false);

// A writer that produces only one master records only that master's entry —
// never fabricating a master it didn't render.
const onlySquare = buildVariants({ footageSocial: false });
assert.deepEqual(onlySquare, {
  [FOOTAGE_FILENAME]: { aspect: "square", hideOverlay: true },
});

const onlySocial = buildVariants({ footage: false });
assert.deepEqual(onlySocial, {
  [FOOTAGE_SOCIAL_FILENAME]: { aspect: "portrait", hideOverlay: false },
});

console.log("variants.test.ts OK");
