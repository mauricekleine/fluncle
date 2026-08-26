import { describe, expect, test } from "vitest";

import { DATABASE_OPERATION_REGISTRY } from "./database-operation-registry";
import {
  DUE_WORK_CUTOVER_CONSUMERS,
  DUE_WORK_LEGACY_ONLY_NONPHYSICAL_MODES,
  PHYSICAL_DUE_WORK_KINDS,
  RECURRING_DUE_WORK_TRIGGER_OPERATION_IDS,
} from "./due-work-cutover-consumers";

describe("Goal C due-work cutover consumers", () => {
  test("the three physical inventories are unique and currently contain 41 kinds", () => {
    expect(PHYSICAL_DUE_WORK_KINDS).toHaveLength(41);
    expect(new Set(PHYSICAL_DUE_WORK_KINDS).size).toBe(PHYSICAL_DUE_WORK_KINDS.length);
  });

  test("the consumer map is unique and exhaustive with no missing or extra kinds", () => {
    const mappedKinds = Object.keys(DUE_WORK_CUTOVER_CONSUMERS);
    const physicalKinds = [...PHYSICAL_DUE_WORK_KINDS];

    expect(new Set(mappedKinds).size).toBe(mappedKinds.length);
    expect(mappedKinds.sort()).toEqual(physicalKinds.sort());
    for (const [kind, row] of Object.entries(DUE_WORK_CUTOVER_CONSUMERS)) {
      expect(row.workKind).toBe(kind);
    }
  });

  test("39 recurring kinds and the two projected on-demand modes are classified honestly", () => {
    const rows = Object.entries(DUE_WORK_CUTOVER_CONSUMERS);
    const recurring = rows.filter(([, row]) => row.mode === "recurring");
    const onDemand = rows.filter(([, row]) => row.mode === "on-demand");

    expect(recurring).toHaveLength(39);
    expect(onDemand.map(([kind]) => kind).sort()).toEqual([
      "finding.context.retry-empty",
      "finding.render.requires-observation",
    ]);

    for (const [, row] of onDemand) {
      expect("triggerOperationId" in row).toBe(false);
      if (!("rationale" in row)) {
        throw new Error("on-demand cutover rows must explain why they have no fleet trigger");
      }
      expect(row.rationale.trim()).not.toBe("");
    }
  });

  test("every recurring row points at a flattened registry trigger", () => {
    const flattenedRegistryTriggers = new Set(
      DATABASE_OPERATION_REGISTRY.flatMap((operation) =>
        operation.triggers.map((trigger) => trigger.operationId),
      ),
    );

    expect(RECURRING_DUE_WORK_TRIGGER_OPERATION_IDS).toEqual(flattenedRegistryTriggers);
    for (const row of Object.values(DUE_WORK_CUTOVER_CONSUMERS)) {
      if (row.mode === "recurring") {
        expect(flattenedRegistryTriggers.has(row.triggerOperationId)).toBe(true);
      }
    }
  });

  test("the one family-only trigger match documents its literal fleet-scope difference", () => {
    const familyMatches = Object.entries(DUE_WORK_CUTOVER_CONSUMERS).filter(
      ([, row]) =>
        row.mode === "recurring" && "triggerMatch" in row && row.triggerMatch === "family",
    );

    expect(familyMatches.map(([kind]) => kind)).toEqual(["analyze-findings"]);
    for (const [, row] of familyMatches) {
      if (!("triggerOperationId" in row) || !("triggerRationale" in row)) {
        throw new Error("family trigger matches must name and explain their registry trigger");
      }
      expect(row.triggerRationale.trim()).not.toBe("");
      expect(RECURRING_DUE_WORK_TRIGGER_OPERATION_IDS.has(row.triggerOperationId)).toBe(true);
    }
  });

  test("operator-targeted nonphysical modes stay legacy-only and outside the inventory", () => {
    expect(Object.keys(DUE_WORK_LEGACY_ONLY_NONPHYSICAL_MODES)).toEqual([
      "cover-masters.retryNone",
    ]);

    for (const [mode, row] of Object.entries(DUE_WORK_LEGACY_ONLY_NONPHYSICAL_MODES)) {
      expect(PHYSICAL_DUE_WORK_KINDS).not.toContain(mode);
      expect("triggerOperationId" in row).toBe(false);
      expect(row.rationale.trim()).not.toBe("");
      expect(row.workKind).toBe(mode);
    }
  });

  test("selector-backed rows name the exact exported consumer", () => {
    expect({
      albumCoverMaster: DUE_WORK_CUTOVER_CONSUMERS["album.cover-master"].consumerId,
      artistCoverMaster: DUE_WORK_CUTOVER_CONSUMERS["artist.cover-master"].consumerId,
      artistCredits: DUE_WORK_CUTOVER_CONSUMERS["artist-credits"].consumerId,
      artistEdges: DUE_WORK_CUTOVER_CONSUMERS["artist-edges"].consumerId,
      captureVerification: DUE_WORK_CUTOVER_CONSUMERS["capture-verification"].consumerId,
      catalogueRank: DUE_WORK_CUTOVER_CONSUMERS["catalogue-rank"].consumerId,
      labelImage: DUE_WORK_CUTOVER_CONSUMERS["label.image"].consumerId,
      recordingMbidLookup: DUE_WORK_CUTOVER_CONSUMERS["mbid-isrc-lookup"].consumerId,
    }).toEqual({
      albumCoverMaster: "cover-masters.resolveCoverMasters",
      artistCoverMaster: "cover-masters.resolveCoverMasters",
      artistCredits: "backfill-artist-credits.resolveArtistCredits",
      artistEdges: "backfill-artist-edges.resolveArtistEdges",
      captureVerification: "catalogue.listUnverifiedCaptures",
      catalogueRank: "catalogue.rankCatalogue",
      labelImage: "label-images.resolveLabelImages",
      recordingMbidLookup: "recording-mbids.resolveRecordingMbids.isrc-lookup",
    });
  });

  test("every physical kind names a cutover consumer", () => {
    for (const row of Object.values(DUE_WORK_CUTOVER_CONSUMERS)) {
      expect(row.consumerId.trim()).not.toBe("");
    }
  });
});
