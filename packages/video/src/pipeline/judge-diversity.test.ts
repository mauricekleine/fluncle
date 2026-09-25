import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import { decodeImageRgb } from "./frames";
import {
  DIVERSITY_MIN,
  diversityDistance,
  evaluatePlateSubjectGate,
  evaluateStructureGate,
  featureOf,
  type PlateSubjectNeighbour,
  type StructureNeighbour,
} from "./judge-diversity";
import { type StructureFamily } from "./shader-structure";

const POSTERS = path.resolve(import.meta.dirname, "..", "..", "calibration", "posters");
const poster = (id: string): string => path.join(POSTERS, `${id}.jpg`);
const ids = ["027.5.4D", "025.5.5T", "032.0.4L", "032.0.6R"];

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

describe("evaluateStructureGate", () => {
  const n = (
    family: StructureFamily | null,
    logId: string,
    vehicle: string,
  ): StructureNeighbour => ({
    family,
    logId,
    vehicle,
  });
  const window = (families: (StructureFamily | null)[]): StructureNeighbour[] =>
    families.map((f, i) => n(f, `03${i}.0.0X`, `world ${i}`));

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

  test("a representational-pair same-family repeat inside the FAIL window FAILS (no demotion)", () => {
    const gate = evaluateStructureGate(
      "metaball",
      window(["metaball", "flow", "caustic", "filament"]),
    );
    expect(gate.status).toBe("fail");
    expect(gate.repeatAt).toBe(0);
  });

  test("a same-family repeat inside the FAIL window FAILS (the texture cellular 3-in-6 case)", () => {
    const gate = evaluateStructureGate(
      "cellular",
      window(["cellular", "flow", "caustic", "filament"]),
    );
    expect(gate.status).toBe("fail");
  });

  test("a same-family repeat only in the WARN window stays WARN (metaball rhyme)", () => {
    const gate = evaluateStructureGate(
      "metaball",
      window(["flow", "caustic", "filament", "radial", "metaball", "flow", "caustic", "lattice"]),
    );
    expect(gate.status).toBe("warn");
    expect(gate.repeatAt).toBe(4);
  });
});

describe("evaluatePlateSubjectGate", () => {
  const n = (plateSubject: string | null, i: number): PlateSubjectNeighbour => ({
    logId: `03${i}.0.0X`,
    plateSubject,
  });
  const window = (subjects: (string | null)[]): PlateSubjectNeighbour[] =>
    subjects.map((s, i) => n(s, i));

  test("a same-kind repeat inside the window WARNS and names the neighbour", () => {
    const gate = evaluatePlateSubjectGate("hull", window([null, "hull", "flora", null]));

    expect(gate.status).toBe("warn");
    expect(gate.repeatAt).toBe(1);
    expect(gate.verdict).toContain('"hull"');
    expect(gate.verdict).toContain("031.0.0X");
  });

  test("a fresh kind PASSES against plate-less and different-kind neighbours", () => {
    const gate = evaluatePlateSubjectGate("ruin", window([null, "hull", "flora", null]));

    expect(gate.status).toBe("pass");
    expect(gate.repeatAt).toBeNull();
  });

  test("a plate-less render (null subject) SKIPS — the axis never blocks abstract work", () => {
    const gate = evaluatePlateSubjectGate(null, window(["hull", "flora", null, "ruin"]));

    expect(gate.status).toBe("skipped");
  });

  test("only the WARN window counts: a repeat beyond 4 findings back is clear", () => {
    const gate = evaluatePlateSubjectGate(
      "hull",
      window([null, "flora", null, "ruin", "hull", "creature"]),
    );

    expect(gate.status).toBe("pass");
  });

  test("plate-less neighbours (null) never count as a repeat", () => {
    const gate = evaluatePlateSubjectGate("hull", window([null, null, null, null]));

    expect(gate.status).toBe("pass");
  });
});
