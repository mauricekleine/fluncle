import { describe, expect, it } from "vitest";

import { PERFORMANCE_BUDGETS, PERFORMANCE_CRITERION_CATEGORIES } from "./budgets";
import { performanceRegistry } from "./contracts";
import {
  deriveDominantRegressionVitestPaths,
  DOMINANT_REGRESSION_INVENTORY,
} from "./dominant-regression-inventory";
import { getScaleManifest } from "./manifest";
import {
  aggregateNoGo,
  assessCategoryCompleteness,
  DOMINANT_REGRESSION_RUNTIME_COMPONENT_ASSIGNMENTS,
  parseReleaseArguments,
  REQUIRED_RELEASE_CATEGORIES,
  releaseCommands,
  type ChildResult,
  type ReleaseCommandResult,
  validateChildResult,
  validateDominantRegressionRuntimeCoverage,
  validateProfileReport,
} from "./release";

function validProfileReport(profile: "1x" | "2x" | "4x"): string {
  const registeredContracts = performanceRegistry.list();
  const counts = getScaleManifest(profile).counts;
  const distribution = { max: 1, p50: 1, p95: 1, p99: 1 };

  return JSON.stringify({
    clientBounds: { local: 1 },
    environment: "local",
    fixture: {
      counts,
      exactProfileCardinality: true,
      profile,
      writeDurationMs: 1,
      written: { perf_tracks: counts.tracks },
    },
    indexAudit: { passed: true },
    report: {
      contracts: registeredContracts.map((contract) => ({
        affectedRowCount: null,
        batchCount: null,
        budget: {
          description: PERFORMANCE_BUDGETS[contract.workClass].description,
          failures: [],
          required: PERFORMANCE_BUDGETS[contract.workClass].requiredProfiles.includes(profile),
          warnings: [],
        },
        contractId: contract.id,
        convergence: null,
        criterionCategories: [contract.workClass],
        description: contract.description,
        durationMs: distribution,
        invariantTotals: {},
        iterations: contract.iterations,
        metadata: [],
        passed: true,
        plan: null,
        queueMs: null,
        resultRowCount: distribution,
        validationFailures: [],
        workClass: contract.workClass,
      })),
      criteria: Object.fromEntries(
        PERFORMANCE_CRITERION_CATEGORIES.map((category) => [
          category,
          {
            addressed: true,
            contractIds: registeredContracts
              .filter((contract) => contract.workClass === category)
              .map((contract) => contract.id),
            passed: true,
            warnings: [],
          },
        ]),
      ),
      generatedAt: "2026-08-27T00:00:00.000Z",
      passed: true,
      profile,
      resources: {
        availability: "measured",
        failures: [],
        mode: profile === "4x" ? "bounded-memory-timing-warning" : "required",
        peak: { heapUsedBytes: 1, rssBytes: 2, wallDurationMs: 3 },
        sampleSource: "provided",
        unavailableReason: null,
        warningThresholds: {
          heapUsedBytes: 1,
          rssBytes: 2,
          wallDurationMs: 3,
        },
        warnings: [],
      },
      schemaVersion: 3,
    },
    schemaVersion: 3,
  });
}

function child(overrides: Partial<ChildResult> = {}): ChildResult {
  return {
    durationMs: 1,
    exitCode: 0,
    spawnError: null,
    stderr: "",
    stdout: "",
    ...overrides,
  };
}

function commandResult(overrides: Partial<ReleaseCommandResult> = {}): ReleaseCommandResult {
  return {
    artifactFilenames: [],
    categories: ["mixed-load"],
    command: ["bun", "test"],
    cwd: ".",
    durationMs: 1,
    exitCode: 0,
    id: "component",
    profile: null,
    spawnError: null,
    startedAt: "2026-08-27T00:00:00.000Z",
    status: "passed",
    validationFailures: [],
    ...overrides,
  };
}

describe("database performance release proof", () => {
  it("parses only one optional output directory", () => {
    expect(parseReleaseArguments([])).toEqual({ outputDirectory: null });
    expect(parseReleaseArguments(["--output-dir", "/tmp/proof"])).toEqual({
      outputDirectory: "/tmp/proof",
    });
    expect(() => parseReleaseArguments(["--output-dir"])).toThrow(
      "--output-dir requires a directory path",
    );
    expect(() => parseReleaseArguments(["--output-dir", "one", "--output-dir", "two"])).toThrow(
      "--output-dir may be supplied only once",
    );
    expect(() => parseReleaseArguments(["--hosted"])).toThrow("unknown");
  });

  it("rejects failed or malformed child results", () => {
    expect(validateChildResult(child())).toEqual([]);
    expect(validateChildResult(child({ exitCode: 2 }))).toContain("child process exited 2");
    expect(validateChildResult(child({ exitCode: null, spawnError: "cargo unavailable" }))).toEqual(
      ["process could not start: cargo unavailable", "child process has no valid exit code"],
    );
    expect(validateChildResult(child({ durationMs: Number.NaN }))).toContain(
      "child duration is not a non-negative finite number",
    );
  });

  it("requires a complete passing schema-v3 report at exact profile cardinality", () => {
    const valid = validateProfileReport(validProfileReport("2x"), "2x");
    expect(valid.errors).toEqual([]);
    expect(valid.exactProfileCardinality).toBe(true);
    expect(valid.observedCardinality).toEqual(getScaleManifest("2x").counts);
    expect(valid.reportPassed).toBe(true);

    const inexact = JSON.parse(validProfileReport("4x"));
    inexact.fixture.exactProfileCardinality = false;
    inexact.fixture.counts.tracks -= 1;
    inexact.report.passed = false;
    delete inexact.report.criteria.projection;
    inexact.indexAudit.passed = false;
    const rejected = validateProfileReport(JSON.stringify(inexact), "4x");

    expect(rejected.errors).toEqual(
      expect.arrayContaining([
        "profile 4x exactProfileCardinality is not true",
        "profile 4x fixture counts do not match the exact manifest cardinality",
        "profile 4x payload criterion projection is missing",
        "profile 4x indexAudit.passed is not true",
        "profile 4x report.passed is not true",
      ]),
    );
    expect(validateProfileReport("not-json", "1x").errors[0]).toContain(
      "stdout is not one JSON document",
    );
  });

  it("fails closed on contract identity, contract shape, and criterion shape drift", () => {
    const missing = JSON.parse(validProfileReport("2x"));
    missing.report.contracts.splice(0, 1);
    const missingValidation = validateProfileReport(JSON.stringify(missing), "2x");
    expect(missingValidation.report).toBeNull();
    expect(missingValidation.errors.some((error) => error.includes("missing registered ids"))).toBe(
      true,
    );

    const extra = JSON.parse(validProfileReport("2x"));
    const firstContract = extra.report.contracts[0];
    if (firstContract === undefined) {
      throw new Error("valid fixture did not include a registered contract");
    }
    extra.report.contracts.push({ ...firstContract, contractId: "extra.contract" });
    const extraValidation = validateProfileReport(JSON.stringify(extra), "2x");
    expect(extraValidation.report).toBeNull();
    expect(extraValidation.errors.some((error) => error.includes("extra ids"))).toBe(true);

    const incomplete = JSON.parse(validProfileReport("2x"));
    delete incomplete.report.contracts[0].durationMs;
    const incompleteValidation = validateProfileReport(JSON.stringify(incomplete), "2x");
    expect(incompleteValidation.report).toBeNull();
    expect(
      incompleteValidation.errors.some((error) => error.includes("durationMs is incomplete")),
    ).toBe(true);

    const incompleteCriterion = JSON.parse(validProfileReport("2x"));
    delete incompleteCriterion.report.criteria.projection.addressed;
    const criterionValidation = validateProfileReport(JSON.stringify(incompleteCriterion), "2x");
    expect(criterionValidation.report).toBeNull();
    expect(
      criterionValidation.errors.some((error) =>
        error.includes("criterion projection is missing addressed"),
      ),
    ).toBe(true);
  });

  it("marks every absent, failed, and complete category explicitly", () => {
    const results = REQUIRED_RELEASE_CATEGORIES.flatMap((category, index) =>
      index === 0
        ? []
        : [
            commandResult({
              categories: [category],
              id: `command-${category}`,
              status: index === 1 ? "failed" : "passed",
            }),
          ],
    );
    const coverage = assessCategoryCompleteness(results);

    expect(coverage[0]).toMatchObject({ status: "missing" });
    expect(coverage[1]).toMatchObject({ status: "failed" });
    expect(coverage.slice(2).every((entry) => entry.status === "passed")).toBe(true);
  });

  it("derives every inventory Vitest path into the dominant command and preserves cutover extras", () => {
    const definitions = releaseCommands();
    const dominantCommand = definitions.find(({ id }) => id === "component-registry-and-cutovers");
    if (dominantCommand === undefined) {
      throw new Error("missing dominant-regression component command");
    }

    const derivedPaths = deriveDominantRegressionVitestPaths(DOMINANT_REGRESSION_INVENTORY);
    expect(new Set(derivedPaths)).toHaveLength(derivedPaths.length);
    expect(dominantCommand.command).toEqual(expect.arrayContaining(derivedPaths));
    expect(dominantCommand.command).toEqual(
      expect.arrayContaining([
        "src/lib/server/backfill-due-work-cutover.integration.test.ts",
        "src/lib/server/due-work-cutover-consumers.test.ts",
        "src/lib/server/due-work-finding-bio-cutover.integration.test.ts",
        "src/lib/server/due-work-image-cutovers.integration.test.ts",
        "src/lib/server/due-work-vendor-core-cutover.integration.test.ts",
      ]),
    );
    expect(
      validateDominantRegressionRuntimeCoverage(DOMINANT_REGRESSION_INVENTORY, definitions),
    ).toEqual([]);
    expect(DOMINANT_REGRESSION_RUNTIME_COMPONENT_ASSIGNMENTS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ commandId: "component-sonar-rust" }),
        expect.objectContaining({ commandId: "component-device-derivation" }),
      ]),
    );
  });

  it("fails closed when future runtime evidence has no executable assignment", () => {
    const futureInventory = DOMINANT_REGRESSION_INVENTORY.map((family, index) =>
      index === 0
        ? {
            ...family,
            runtimeTests: [
              ...family.runtimeTests,
              {
                file: "apps/sonar/src/future-runtime.rs",
                marker: "future runtime evidence",
              },
            ],
          }
        : family,
    );

    expect(validateDominantRegressionRuntimeCoverage(futureInventory, releaseCommands())).toContain(
      "artist-identity-case-or: runtime evidence apps/sonar/src/future-runtime.rs#future runtime evidence has no explicit component assignment",
    );
  });

  it("aggregates every process, validation, category, and runner no-go", () => {
    const commands = [
      commandResult({
        id: "failed-command",
        status: "failed",
        validationFailures: ["report.passed is not true"],
      }),
    ];
    const coverage = assessCategoryCompleteness(commands);
    const reasons = aggregateNoGo(commands, coverage, ["runner could not write an artifact"]);

    expect(reasons).toEqual(
      expect.arrayContaining([
        "runner could not write an artifact",
        "command failed-command failed",
        "failed-command: report.passed is not true",
        "required category sql-full-fixture-1x is missing",
      ]),
    );
    expect(reasons.length).toBeGreaterThan(4);
  });
});
