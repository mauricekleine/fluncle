import { describe, expect, test } from "bun:test";

import { featureIds } from "./index";
import { visibleFeatures } from "./gating";
import { manifest as pulseLite } from "./pulse-lite/manifest";
import { type FeatureManifest } from "./types";

const m5Only: FeatureManifest = { id: "show", machines: ["m5"], order: 10, title: "Show" };
const m2Only: FeatureManifest = { id: "cues", machines: ["m2"], order: 20, title: "Cues" };
const both: FeatureManifest = { id: "pulse", machines: ["m2", "m5"], order: 30, title: "Pulse" };

describe("visibleFeatures (manifest gating)", () => {
  test("a machine sees only the stations wired for it, rail-ordered", () => {
    expect(visibleFeatures([both, m2Only, m5Only], "m5").map((m) => m.id)).toEqual([
      "show",
      "pulse",
    ]);
    expect(visibleFeatures([both, m5Only, m2Only], "m2").map((m) => m.id)).toEqual([
      "cues",
      "pulse",
    ]);
  });

  test("an unknown machine is never locked out — it sees everything", () => {
    expect(visibleFeatures([m5Only, m2Only, both], "unknown")).toHaveLength(3);
  });

  test("order ties break on id so the rail never jitters", () => {
    const a: FeatureManifest = { id: "b-station", machines: ["m5"], order: 1, title: "B" };
    const b: FeatureManifest = { id: "a-station", machines: ["m5"], order: 1, title: "A" };

    expect(visibleFeatures([a, b], "m5").map((m) => m.id)).toEqual(["a-station", "b-station"]);
  });
});

describe("the feature registry", () => {
  test("ids are unique", () => {
    expect(new Set(featureIds).size).toBe(featureIds.length);
  });

  test("pulse-lite's manifest matches its registered id (the convention the loader enforces)", () => {
    expect(featureIds as readonly string[]).toContain(pulseLite.id);
    expect(pulseLite.machines.length).toBeGreaterThan(0);
  });
});
