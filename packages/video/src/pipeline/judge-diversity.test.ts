// Self-running checks for the diversity metric. Uses the committed calibration
// posters (packages/video/calibration/posters/) so the anchors are re-verifiable
// offline — NO network. Locks the two ground-truth pairs from the audit:
//   - 027.5.4D vs 025.5.5T : the SAME primitive recolored → must read LOW (too
//     similar). This is the laundering-by-recolor guard: a colour-only metric would
//     read them as very different; the structure-dominant distance must not.
//   - 032.0.4L vs 032.0.6R : genuinely distinct → must read HIGH.
// If the posters are absent (a shallow checkout), the check no-ops with a note.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";

import { decodeImageRgb } from "./frames";
import { DIVERSITY_MIN, diversityDistance, featureOf } from "./judge-diversity";

const POSTERS = path.resolve(import.meta.dirname, "..", "..", "calibration", "posters");
const poster = (id: string): string => path.join(POSTERS, `${id}.jpg`);
const ids = ["027.5.4D", "025.5.5T", "032.0.4L", "032.0.6R"];

if (!ids.every((id) => existsSync(poster(id)))) {
  console.log(
    "~ diversity: calibration posters not present — skipping (run from a full checkout).",
  );
} else {
  const feat = (id: string) => featureOf(decodeImageRgb(poster(id), { height: 160, width: 160 }));
  const f = Object.fromEntries(ids.map((id) => [id, feat(id)]));

  const same = diversityDistance(f["027.5.4D"], f["025.5.5T"]);
  const diff = diversityDistance(f["032.0.4L"], f["032.0.6R"]);

  assert.ok(
    same.combined < DIVERSITY_MIN,
    `a same-primitive recolored pair must read TOO SIMILAR (< ${DIVERSITY_MIN}); got ${same.combined.toFixed(3)}`,
  );
  assert.ok(
    diff.combined >= DIVERSITY_MIN,
    `a genuinely distinct pair must read distinct (>= ${DIVERSITY_MIN}); got ${diff.combined.toFixed(3)}`,
  );
  // The structural fingerprint is what discriminates: the recolored pair shares edges.
  assert.ok(
    same.edgeOrient < diff.edgeOrient,
    "the recolored pair must have a smaller edge-orientation distance than the distinct pair",
  );
  assert.ok(diff.combined - same.combined > 0.2, "the two anchors must separate with margin");

  console.log(
    `diversity: same(027.5.4D/025.5.5T)=${same.combined.toFixed(3)}(edge ${same.edgeOrient.toFixed(2)}) diff(032.0.4L/032.0.6R)=${diff.combined.toFixed(3)}(edge ${diff.edgeOrient.toFixed(2)}) threshold=${DIVERSITY_MIN}`,
  );
  console.log(
    "✓ diversity: structure-dominant distance reads the recolor as too-similar and the distinct pair as diverse",
  );
}
