import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { performanceRegistry } from "./contracts";
import { CONTRACT_D_CONTRACT_IDS } from "./contract-d";
import {
  DOMINANT_REGRESSION_FAMILY_IDS,
  DOMINANT_REGRESSION_INVENTORY,
  type DominantRegressionFamily,
  validateDominantRegressionInventory,
} from "./dominant-regression-inventory";

const REPOSITORY_ROOT = join(import.meta.dirname, "../../../..");
const knownContractIds = new Set(performanceRegistry.list().map((contract) => contract.id));

function copyInventory(): DominantRegressionFamily[] {
  return DOMINANT_REGRESSION_INVENTORY.map((family) => ({
    ...family,
    compatibility: {
      ...family.compatibility,
      source: { ...family.compatibility.source },
      test: { ...family.compatibility.test },
    },
    finalImplementation: family.finalImplementation.map((evidence) => ({ ...evidence })),
    originalShapes: [...family.originalShapes],
    performanceContractIds: [...family.performanceContractIds],
    runtimeTests: family.runtimeTests.map((evidence) => ({ ...evidence })),
  }));
}

function failuresFor(inventory: readonly DominantRegressionFamily[]): string[] {
  return validateDominantRegressionInventory(inventory, knownContractIds);
}

describe("Goal H dominant regression inventory", () => {
  it("contains exactly the nine canonical stable family IDs", () => {
    expect(DOMINANT_REGRESSION_INVENTORY.map((family) => family.id)).toEqual(
      DOMINANT_REGRESSION_FAMILY_IDS,
    );
    expect(Object.isFrozen(DOMINANT_REGRESSION_INVENTORY)).toBe(true);
    expect(Object.isFrozen(DOMINANT_REGRESSION_INVENTORY[0])).toBe(true);
  });

  it("maps every performance proof to the registered registry and Contract D exactly once", () => {
    expect(failuresFor(DOMINANT_REGRESSION_INVENTORY)).toEqual([]);

    const contractDMapping = DOMINANT_REGRESSION_INVENTORY.flatMap((family) =>
      family.performanceContractIds.filter((id) =>
        CONTRACT_D_CONTRACT_IDS.includes(id as (typeof CONTRACT_D_CONTRACT_IDS)[number]),
      ),
    );
    expect(contractDMapping).toHaveLength(CONTRACT_D_CONTRACT_IDS.length);
    expect(contractDMapping.sort()).toEqual([...CONTRACT_D_CONTRACT_IDS].sort());
  });

  it("keeps final and compatibility source/test evidence nonempty and present", async () => {
    const evidence = DOMINANT_REGRESSION_INVENTORY.flatMap((family) => [
      ...family.finalImplementation,
      ...family.runtimeTests,
      family.compatibility.source,
      family.compatibility.test,
    ]);

    await Promise.all(
      evidence.map(async ({ file, marker }) => {
        expect(file).not.toBe("");
        expect(marker).not.toBe("");
        const path = join(REPOSITORY_ROOT, file);
        await expect(access(path)).resolves.toBeUndefined();
        await expect(readFile(path, "utf8")).resolves.toContain(marker);
      }),
    );
  });

  it("treats source symbols as reference evidence, while naming separate runtime test markers", () => {
    for (const family of DOMINANT_REGRESSION_INVENTORY) {
      expect(family.finalImplementation).not.toEqual(family.runtimeTests);
    }
  });

  it("rejects omitted or duplicate family IDs", () => {
    expect(failuresFor(copyInventory().slice(1))).toContain(
      "inventory must contain exactly the nine canonical stable family IDs in order",
    );

    const duplicate = copyInventory();
    const second = duplicate[1];
    if (second === undefined) {
      throw new Error("missing duplicate fixture family");
    }
    duplicate[0] = { ...second };
    expect(failuresFor(duplicate)).toContain(
      "inventory must contain exactly the nine canonical stable family IDs in order",
    );
  });

  it("rejects unknown and missing or duplicated Contract D proof IDs", () => {
    const unknown = copyInventory();
    const first = unknown[0];
    if (first === undefined) {
      throw new Error("missing unknown-proof fixture family");
    }
    first.performanceContractIds = [...first.performanceContractIds, "unknown.proof"];
    expect(failuresFor(unknown)).toContain(
      "artist-identity-case-or: unknown performance contract unknown.proof",
    );

    const missing = copyInventory();
    const staleRearm = missing[1];
    if (staleRearm === undefined) {
      throw new Error("missing Contract D fixture family");
    }
    staleRearm.performanceContractIds = staleRearm.performanceContractIds.slice(1);
    expect(failuresFor(missing)).toContain(
      "Contract D ID projection.crawl-two-lane-claim must be mapped exactly once; found 0",
    );

    const duplicate = copyInventory();
    const releaseHub = duplicate[3];
    if (releaseHub === undefined) {
      throw new Error("missing duplicate Contract D fixture family");
    }
    releaseHub.performanceContractIds = [
      ...releaseHub.performanceContractIds,
      "projection.crawl-two-lane-claim",
    ];
    expect(failuresFor(duplicate)).toContain(
      "Contract D ID projection.crawl-two-lane-claim must be mapped exactly once; found 2",
    );
  });
});
