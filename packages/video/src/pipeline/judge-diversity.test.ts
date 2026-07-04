// Self-running checks for the diversity metric. Uses the committed calibration
// posters (packages/video/calibration/posters/) so the anchors are re-verifiable
// offline — NO network. Locks the two ground-truth pairs from the audit:
//   - 027.5.4D vs 025.5.5T : the SAME primitive recolored → must read LOW (too
//     similar). This is the laundering-by-recolor guard: a colour-only metric would
//     read them as very different; the structure-dominant distance must not.
//   - 032.0.4L vs 032.0.6R : genuinely distinct → must read HIGH.
// If the posters are absent (a shallow checkout) or ffmpeg is not on PATH (the
// decode shells out to it; CI without ffmpeg stays green — the analyze-set
// convention), the check no-ops with a note.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import { decodeImageRgb } from "./frames";
import {
  DIVERSITY_MIN,
  diversityDistance,
  evaluateStructureGate,
  featureOf,
  type StructureNeighbour,
} from "./judge-diversity";
import { type IntentRegister } from "./intent";
import { type StructureFamily } from "./shader-structure";

const POSTERS = path.resolve(import.meta.dirname, "..", "..", "calibration", "posters");
const poster = (id: string): string => path.join(POSTERS, `${id}.jpg`);
const ids = ["027.5.4D", "025.5.5T", "032.0.4L", "032.0.6R"];

// decodeImageRgb spawns the bare `ffmpeg` binary, so probe exactly that.
const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

if (!hasFfmpeg) {
  console.log("~ diversity: ffmpeg absent — poster-decode anchors skipped.");
} else if (!ids.every((id) => existsSync(poster(id)))) {
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

// The PURE structural gate — no network, no fs. The heart of the new axis: a repeat of
// the subject's dominant family inside the hard window (the last 4) FAILS; inside the
// wider window (5–8) WARNS; beyond it, or when absent, PASSES; an unresolved subject
// family SKIPS (never fails a ship because a body couldn't be classified).
describe("evaluateStructureGate", () => {
  const n = (
    family: StructureFamily | null,
    logId: string,
    vehicle: string,
    register: IntentRegister | null = null,
  ): StructureNeighbour => ({
    family,
    logId,
    register,
    vehicle,
  });
  const window = (families: (StructureFamily | null)[]): StructureNeighbour[] =>
    families.map((f, i) => n(f, `03${i}.0.0X`, `world ${i}`));
  // A window where every neighbour is tagged with a register (for the presence-nuance tests).
  const windowReg = (
    families: (StructureFamily | null)[],
    register: IntentRegister,
  ): StructureNeighbour[] => families.map((f, i) => n(f, `03${i}.0.0X`, `world ${i}`, register));

  test("a repeat in the immediate window (index < 4) FAILS and names the repeat", () => {
    const gate = evaluateStructureGate(
      "cellular",
      window(["flow", "cellular", "caustic", "filament"]),
    );
    expect(gate.status).toBe("fail");
    expect(gate.repeatAt).toBe(1);
    expect(gate.verdict).toContain("cellular");
    expect(gate.verdict).toContain("world 1");
  });

  test("the immediate neighbour repeating FAILS (index 0, 'twice in a row')", () => {
    const gate = evaluateStructureGate("cellular", window(["cellular", "flow", "caustic", "flow"]));
    expect(gate.status).toBe("fail");
    expect(gate.repeatAt).toBe(0);
  });

  test("a repeat only in the wider window (index 4..7) WARNS", () => {
    const gate = evaluateStructureGate(
      "cellular",
      window(["flow", "caustic", "filament", "radial", "cellular", "flow", "caustic", "lattice"]),
    );
    expect(gate.status).toBe("warn");
    expect(gate.repeatAt).toBe(4);
  });

  test("a family absent from the whole window PASSES", () => {
    const gate = evaluateStructureGate(
      "metaball",
      window(["flow", "cellular", "caustic", "filament"]),
    );
    expect(gate.status).toBe("pass");
    expect(gate.repeatAt).toBeNull();
  });

  test("an unresolved subject family SKIPS (pass, never blocks a ship)", () => {
    const gate = evaluateStructureGate(
      null,
      window(["cellular", "cellular", "cellular", "cellular"]),
    );
    expect(gate.status).toBe("skipped");
    expect(gate.subject).toBeNull();
  });

  test("neighbours whose own family is unresolved (null) never count as a repeat", () => {
    const gate = evaluateStructureGate("cellular", window([null, null, null, null]));
    expect(gate.status).toBe("pass");
    expect(gate.repeatAt).toBeNull();
  });

  test("the boundary: index 3 FAILS (last of the hard window), index 4 WARNS (first soft)", () => {
    const atThree = evaluateStructureGate(
      "flow",
      window(["cellular", "caustic", "filament", "flow"]),
    );
    expect(atThree.status).toBe("fail");
    expect(atThree.repeatAt).toBe(3);

    const atFour = evaluateStructureGate(
      "flow",
      window(["cellular", "caustic", "filament", "radial", "flow"]),
    );
    expect(atFour.status).toBe("warn");
    expect(atFour.repeatAt).toBe(4);
  });

  // ── the presence nuance: representational subjects classify alike ──────────
  test("two REPRESENTATIONAL subjects sharing a family DEMOTE a hard FAIL to WARN", () => {
    // metaball is the family every raymarched/SDF subject classifies as; a ship and a
    // ruin are different worlds, so the hard repeat softens to a rhyme.
    const gate = evaluateStructureGate(
      "metaball",
      windowReg(["metaball", "flow", "caustic", "filament"], "representational"),
      "representational",
    );
    expect(gate.status).toBe("warn");
    expect(gate.repeatAt).toBe(0);
    expect(gate.verdict).toContain("representational");
  });

  test("a REPRESENTATIONAL subject repeating an ABSTRACT (texture) neighbour stays a hard FAIL", () => {
    // The neighbour is a texture-register field of the same family — not a subject; the
    // saturation guard the gate was built for still bites.
    const neighbours = windowReg(["metaball", "flow", "caustic", "filament"], "abstract");
    const gate = evaluateStructureGate("metaball", neighbours, "representational");
    expect(gate.status).toBe("fail");
    expect(gate.repeatAt).toBe(0);
  });

  test("two ABSTRACT (texture) subjects sharing a family stay a hard FAIL (the cellular 3-in-6 case)", () => {
    const gate = evaluateStructureGate(
      "cellular",
      windowReg(["cellular", "flow", "caustic", "filament"], "abstract"),
      "abstract",
    );
    expect(gate.status).toBe("fail");
  });

  test("the demotion only touches the FAIL window: a representational rhyme in the WARN window is still WARN", () => {
    const gate = evaluateStructureGate(
      "metaball",
      windowReg(
        ["flow", "caustic", "filament", "radial", "metaball", "flow", "caustic", "lattice"],
        "representational",
      ),
      "representational",
    );
    expect(gate.status).toBe("warn");
    expect(gate.repeatAt).toBe(4);
  });

  test("no subjectRegister passed → the strict texture-era FAIL is preserved (back-compat)", () => {
    // The existing 2-arg callers keep the hard-fail behavior even against a
    // representational-tagged neighbour, because the subject's own register is unknown.
    const gate = evaluateStructureGate(
      "metaball",
      windowReg(["metaball", "flow", "caustic", "filament"], "representational"),
    );
    expect(gate.status).toBe("fail");
  });
});
