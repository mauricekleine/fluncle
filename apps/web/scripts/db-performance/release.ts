#!/usr/bin/env bun
import { mkdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PERFORMANCE_BUDGETS, PERFORMANCE_CRITERION_CATEGORIES } from "./budgets";
import { performanceRegistry } from "./contracts";
import {
  getScaleManifest,
  SCALE_PROFILES,
  type FixtureCounts,
  type ScaleProfile,
} from "./manifest";
import {
  appsWebVitestPath,
  deriveDominantRegressionVitestPaths,
  dominantRegressionEvidenceKey,
  DOMINANT_REGRESSION_INVENTORY,
  type DominantRegressionFamily,
  type EvidenceLocation,
} from "./dominant-regression-inventory";
import { PERFORMANCE_REPORT_SCHEMA_VERSION, type PerformanceContract } from "./registry";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const DEFAULT_ARTIFACT_ROOT = join(REPOSITORY_ROOT, "apps/web/.dev/db-performance-release");

export const RELEASE_MANIFEST_SCHEMA_VERSION = 1 as const;

export const REQUIRED_RELEASE_CATEGORIES = [
  "sql-full-fixture-1x",
  "sql-full-fixture-2x",
  "sql-full-fixture-4x",
  "dominant-regression-inventory",
  "operation-registry-classification",
  "compatibility-cutovers",
  "mixed-load",
  "admission-enforced",
  "admission-schema",
  "admission-shadow",
  "operation-receipt-schema",
  "operation-receipt-ambiguity",
  "operation-receipt-restart",
  "public-projection-convergence",
  "device-derivation",
  "device-mirror",
  "device-scaled-convergence",
  "device-resource-bounds",
  "sonar-rust",
  "sonar-scaled-delta-full-rebuild",
] as const;

export type ReleaseCategory = (typeof REQUIRED_RELEASE_CATEGORIES)[number];

export type DominantRegressionRuntimeComponentAssignment = Readonly<{
  categories: readonly ReleaseCategory[];
  commandId: string;
  evidence: EvidenceLocation;
}>;

/** Runtime evidence with an existing component proof owner outside the dominant command. */
export const DOMINANT_REGRESSION_RUNTIME_COMPONENT_ASSIGNMENTS = [
  {
    categories: ["sonar-rust", "sonar-scaled-delta-full-rebuild"],
    commandId: "component-sonar-rust",
    evidence: {
      file: "apps/sonar/src/state.rs",
      marker: "delta_converges_with_full_local_rebuild_at_scaled_corpora",
    },
  },
  {
    categories: ["device-derivation"],
    commandId: "component-device-derivation",
    evidence: {
      file: "apps/web/scripts/lib/device-db-derivation.test.ts",
      marker: "materializes the growing anchored scan once and makes every copy read that relation",
    },
  },
  {
    categories: ["mixed-load"],
    commandId: "component-mixed-load",
    evidence: {
      file: "apps/web/scripts/db-performance/mixed-load.test.ts",
      marker: "keeps public reads moving beside a held reader and serializes write batches",
    },
  },
] as const satisfies readonly DominantRegressionRuntimeComponentAssignment[];

export type ReleaseOptions = {
  outputDirectory: string | null;
};

export type ChildResult = {
  durationMs: number;
  exitCode: number | null;
  spawnError: string | null;
  stderr: string;
  stdout: string;
};

export type ReleaseCommandResult = {
  artifactFilenames: string[];
  categories: ReleaseCategory[];
  command: string[];
  cwd: string;
  durationMs: number;
  exitCode: number | null;
  id: string;
  profile: ScaleProfile | null;
  spawnError: string | null;
  startedAt: string;
  status: "failed" | "passed";
  validationFailures: string[];
};

export type ProfileEvidence = {
  commandId: string;
  exactProfileCardinality: boolean | null;
  expectedCardinality: FixtureCounts;
  observedCardinality: Record<string, number> | null;
  profile: ScaleProfile;
  reportArtifact: string | null;
  reportPassed: boolean | null;
  status: "failed" | "passed";
  validationFailures: string[];
  warnings: string[];
  warningThresholds: Record<string, number> | null;
};

export type CategoryCoverage = {
  category: ReleaseCategory;
  commandIds: string[];
  status: "failed" | "missing" | "passed";
};

export type ReleaseCommandDefinition = {
  categories: ReleaseCategory[];
  command: string[];
  cwd: string;
  id: string;
  profile?: ScaleProfile;
};

type JsonRecord = Record<string, unknown>;

export type ProfileValidation = {
  errors: string[];
  exactProfileCardinality: boolean | null;
  observedCardinality: Record<string, number> | null;
  report: JsonRecord | null;
  reportPassed: boolean | null;
  warnings: string[];
  warningThresholds: Record<string, number> | null;
};

export function parseReleaseArguments(args: readonly string[]): ReleaseOptions {
  let outputDirectory: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--output-dir") {
      const value = args[index + 1];

      if (!value || value.startsWith("--")) {
        throw new Error("--output-dir requires a directory path");
      }
      if (outputDirectory !== null) {
        throw new Error("--output-dir may be supplied only once");
      }

      outputDirectory = value;
      index += 1;
      continue;
    }

    throw new Error(`unknown database-performance release option: ${argument ?? "<missing>"}`);
  }

  return { outputDirectory };
}

export function validateChildResult(result: ChildResult): string[] {
  const failures: string[] = [];

  if (!Number.isFinite(result.durationMs) || result.durationMs < 0) {
    failures.push("child duration is not a non-negative finite number");
  }
  if (result.spawnError !== null) {
    failures.push(`process could not start: ${result.spawnError}`);
  }
  if (!Number.isSafeInteger(result.exitCode) || (result.exitCode ?? -1) < 0) {
    failures.push("child process has no valid exit code");
  } else if (result.exitCode !== 0) {
    failures.push(`child process exited ${result.exitCode}`);
  }
  if (typeof result.stdout !== "string" || typeof result.stderr !== "string") {
    failures.push("child process output was not captured as text");
  }

  return failures;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function readNumericRecord(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) {
    return null;
  }

  const entries = Object.entries(value);
  if (entries.some(([, entry]) => !isNonNegativeFiniteNumber(entry))) {
    return null;
  }

  return Object.fromEntries(entries) as Record<string, number>;
}

function sameCardinality(
  observed: Record<string, number> | null,
  expected: FixtureCounts,
): boolean {
  if (observed === null) {
    return false;
  }

  const observedKeys = Object.keys(observed).sort();
  const expectedKeys = Object.keys(expected).sort();

  return (
    observedKeys.length === expectedKeys.length &&
    observedKeys.every(
      (key, index) =>
        key === expectedKeys[index] && observed[key] === expected[key as keyof FixtureCounts],
    )
  );
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : null;
}

const DISTRIBUTION_FIELDS = ["max", "p50", "p95", "p99"] as const;

function isDistribution(value: unknown): boolean {
  return (
    isRecord(value) && DISTRIBUTION_FIELDS.every((field) => isNonNegativeFiniteNumber(value[field]))
  );
}

function isNullableDistribution(value: unknown): boolean {
  return value === null || isDistribution(value);
}

function isExplainPlanAnalysis(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const details = stringArray(value.details);
  const tempSorts = stringArray(value.tempSorts);
  const violations = stringArray(value.violations);

  return (
    details !== null &&
    Array.isArray(value.fullScans) &&
    value.fullScans.every(
      (scan) => isRecord(scan) && typeof scan.detail === "string" && typeof scan.table === "string",
    ) &&
    tempSorts !== null &&
    violations !== null
  );
}

function isConvergenceReport(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  return (
    (value.category === "projection" || value.category === "queue") &&
    typeof value.converged === "boolean" &&
    isNonNegativeFiniteNumber(value.fieldMismatches) &&
    isNonNegativeFiniteNumber(value.missingRows) &&
    isNonNegativeFiniteNumber(value.projectedRows) &&
    isNonNegativeFiniteNumber(value.repairRows) &&
    typeof value.scope === "string" &&
    isNonNegativeFiniteNumber(value.sourceRows) &&
    isNonNegativeFiniteNumber(value.unexpectedRows) &&
    isNonNegativeFiniteNumber(value.failedObservations) &&
    isNonNegativeFiniteNumber(value.observations)
  );
}

function sameStringArray(observed: readonly string[], expected: readonly string[]): boolean {
  return (
    observed.length === expected.length &&
    observed.every((entry, index) => entry === expected[index])
  );
}

function validateRegisteredContractReport(
  entry: JsonRecord,
  registered: PerformanceContract,
  profile: ScaleProfile,
  malformedReport: (message: string) => void,
): void {
  const label = `profile ${profile} payload contract ${registered.id}`;
  const criterionCategories = stringArray(entry.criterionCategories);
  const budget = isRecord(entry.budget) ? entry.budget : null;

  if (entry.description !== registered.description) {
    malformedReport(`${label} description is incomplete or does not match its registration`);
  }
  if (entry.workClass !== registered.workClass) {
    malformedReport(`${label} workClass is incomplete or does not match its registration`);
  }
  if (
    criterionCategories === null ||
    criterionCategories.length !== 1 ||
    criterionCategories[0] !== registered.workClass
  ) {
    malformedReport(`${label} criterionCategories are incomplete or do not match its registration`);
  }
  if (!Number.isSafeInteger(entry.iterations) || entry.iterations !== registered.iterations) {
    malformedReport(`${label} iterations are incomplete or do not match its registration`);
  }
  if (!isDistribution(entry.durationMs)) {
    malformedReport(`${label} durationMs is incomplete`);
  }
  if (!isDistribution(entry.resultRowCount)) {
    malformedReport(`${label} resultRowCount is incomplete`);
  }
  if (readNumericRecord(entry.invariantTotals) === null) {
    malformedReport(`${label} invariantTotals are incomplete`);
  }
  if (!Array.isArray(entry.metadata) || !entry.metadata.every((metadata) => isRecord(metadata))) {
    malformedReport(`${label} metadata is incomplete`);
  }
  if (!Array.isArray(entry.validationFailures) || stringArray(entry.validationFailures) === null) {
    malformedReport(`${label} validationFailures are incomplete`);
  }
  if (typeof entry.passed !== "boolean") {
    malformedReport(`${label} passed is incomplete`);
  }
  if (!isNullableDistribution(entry.affectedRowCount)) {
    malformedReport(`${label} affectedRowCount is incomplete`);
  }
  if (!isNullableDistribution(entry.batchCount)) {
    malformedReport(`${label} batchCount is incomplete`);
  }
  if (!isNullableDistribution(entry.queueMs)) {
    malformedReport(`${label} queueMs is incomplete`);
  }
  if (!(entry.convergence === null || isConvergenceReport(entry.convergence))) {
    malformedReport(`${label} convergence is incomplete`);
  }
  if (!(entry.plan === null || isExplainPlanAnalysis(entry.plan))) {
    malformedReport(`${label} plan is incomplete`);
  }

  if (budget === null) {
    malformedReport(`${label} budget is incomplete`);
  } else {
    const expectedBudget = PERFORMANCE_BUDGETS[registered.workClass];
    if (budget.description !== expectedBudget.description) {
      malformedReport(`${label} budget description is incomplete or incorrect`);
    }
    if (
      typeof budget.required !== "boolean" ||
      budget.required !== expectedBudget.requiredProfiles.includes(profile)
    ) {
      malformedReport(`${label} budget required flag is incomplete or incorrect`);
    }
    if (stringArray(budget.failures) === null) {
      malformedReport(`${label} budget failures are incomplete`);
    }
    if (stringArray(budget.warnings) === null) {
      malformedReport(`${label} budget warnings are incomplete`);
    }
  }
}

function validateRegisteredContracts(
  contracts: readonly unknown[],
  registeredContracts: readonly PerformanceContract[],
  profile: ScaleProfile,
  malformedReport: (message: string) => void,
): void {
  const registeredById = new Map(registeredContracts.map((contract) => [contract.id, contract]));
  const observedIds: string[] = [];
  const observedIdSet = new Set<string>();

  for (const [index, entry] of contracts.entries()) {
    if (!isRecord(entry) || typeof entry.contractId !== "string") {
      malformedReport(`profile ${profile} payload contract ${index} is incomplete`);
      continue;
    }

    const id = entry.contractId;
    observedIds.push(id);
    if (observedIdSet.has(id)) {
      malformedReport(`profile ${profile} payload contracts contain duplicate id ${id}`);
    }
    observedIdSet.add(id);

    const registered = registeredById.get(id);
    if (registered !== undefined) {
      validateRegisteredContractReport(entry, registered, profile, malformedReport);
    }
  }

  const missingIds = registeredContracts
    .filter((contract) => !observedIdSet.has(contract.id))
    .map((contract) => contract.id);
  const extraIds = [...new Set(observedIds.filter((id) => !registeredById.has(id)))];

  if (missingIds.length > 0) {
    malformedReport(
      `profile ${profile} payload contracts are missing registered ids: ${missingIds.join(", ")}`,
    );
  }
  if (extraIds.length > 0) {
    malformedReport(
      `profile ${profile} payload contracts contain extra ids: ${extraIds.join(", ")}`,
    );
  }
}

function validateCriteria(
  criteria: JsonRecord,
  registeredContracts: readonly PerformanceContract[],
  profile: ScaleProfile,
  malformedReport: (message: string) => void,
): void {
  const expectedCategories = new Set<string>(PERFORMANCE_CRITERION_CATEGORIES);

  for (const category of Object.keys(criteria)) {
    if (!expectedCategories.has(category)) {
      malformedReport(`profile ${profile} payload has extra criterion ${category}`);
    }
  }

  for (const category of PERFORMANCE_CRITERION_CATEGORIES) {
    const criterion = criteria[category];
    if (!isRecord(criterion)) {
      malformedReport(`profile ${profile} payload criterion ${category} is missing`);
      continue;
    }

    if (typeof criterion.addressed !== "boolean") {
      malformedReport(`profile ${profile} payload criterion ${category} is missing addressed`);
    }

    const observedIds = stringArray(criterion.contractIds);
    const expectedIds = registeredContracts
      .filter((contract) => contract.workClass === category)
      .map((contract) => contract.id);
    if (observedIds === null || !sameStringArray(observedIds, expectedIds)) {
      malformedReport(
        `profile ${profile} payload criterion ${category} has incomplete contractIds`,
      );
    }
    if (typeof criterion.passed !== "boolean") {
      malformedReport(`profile ${profile} payload criterion ${category} is missing passed`);
    }
    if (stringArray(criterion.warnings) === null) {
      malformedReport(`profile ${profile} payload criterion ${category} is missing warnings`);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function validateProfileReport(rawJson: string, profile: ScaleProfile): ProfileValidation {
  const errors: string[] = [];
  let malformed = false;
  let parsed: unknown;
  const malformedReport = (message: string): void => {
    malformed = true;
    errors.push(message);
  };

  try {
    parsed = JSON.parse(rawJson);
  } catch (error) {
    return {
      errors: [`profile ${profile} stdout is not one JSON document: ${errorMessage(error)}`],
      exactProfileCardinality: null,
      observedCardinality: null,
      report: null,
      reportPassed: null,
      warningThresholds: null,
      warnings: [],
    };
  }

  if (!isRecord(parsed)) {
    return {
      errors: [`profile ${profile} report root is not an object`],
      exactProfileCardinality: null,
      observedCardinality: null,
      report: null,
      reportPassed: null,
      warningThresholds: null,
      warnings: [],
    };
  }

  if (parsed.schemaVersion !== PERFORMANCE_REPORT_SCHEMA_VERSION) {
    malformedReport(
      `profile ${profile} report schemaVersion is not ${PERFORMANCE_REPORT_SCHEMA_VERSION}`,
    );
  }
  if (parsed.environment !== "local") {
    malformedReport(`profile ${profile} report environment is not local`);
  }
  if (!isRecord(parsed.clientBounds)) {
    malformedReport(`profile ${profile} report has no clientBounds object`);
  }
  if (!isRecord(parsed.indexAudit)) {
    malformedReport(`profile ${profile} report has malformed indexAudit evidence`);
  } else if (parsed.indexAudit.passed !== true) {
    errors.push(`profile ${profile} indexAudit.passed is not true`);
  }

  const fixture = isRecord(parsed.fixture) ? parsed.fixture : null;
  if (fixture === null) {
    malformedReport(`profile ${profile} report has no fixture object`);
  }
  const exactProfileCardinality =
    fixture !== null && typeof fixture.exactProfileCardinality === "boolean"
      ? fixture.exactProfileCardinality
      : null;
  const observedCardinality = readNumericRecord(fixture?.counts);

  if (fixture?.profile !== profile) {
    malformedReport(`profile ${profile} fixture profile does not match`);
  }
  if (exactProfileCardinality === null) {
    malformedReport(`profile ${profile} exactProfileCardinality is malformed`);
  } else if (!exactProfileCardinality) {
    errors.push(`profile ${profile} exactProfileCardinality is not true`);
  }
  if (observedCardinality === null) {
    malformedReport(`profile ${profile} fixture counts are malformed`);
  } else if (!sameCardinality(observedCardinality, getScaleManifest(profile).counts)) {
    errors.push(`profile ${profile} fixture counts do not match the exact manifest cardinality`);
  }
  if (!isNonNegativeFiniteNumber(fixture?.writeDurationMs)) {
    malformedReport(`profile ${profile} fixture writeDurationMs is malformed`);
  }
  if (readNumericRecord(fixture?.written) === null) {
    malformedReport(`profile ${profile} fixture written counts are missing`);
  }

  const report = isRecord(parsed.report) ? parsed.report : null;
  if (report === null) {
    malformedReport(`profile ${profile} report payload is missing`);
  }
  if (report?.schemaVersion !== PERFORMANCE_REPORT_SCHEMA_VERSION) {
    malformedReport(
      `profile ${profile} payload schemaVersion is not ${PERFORMANCE_REPORT_SCHEMA_VERSION}`,
    );
  }
  if (report?.profile !== profile) {
    malformedReport(`profile ${profile} payload profile does not match`);
  }
  if (typeof report?.generatedAt !== "string" || report.generatedAt.length === 0) {
    malformedReport(`profile ${profile} payload generatedAt is malformed`);
  }
  const registeredContracts = performanceRegistry.list();
  if (!Array.isArray(report?.contracts)) {
    malformedReport(`profile ${profile} payload contracts are missing`);
  } else {
    validateRegisteredContracts(report.contracts, registeredContracts, profile, malformedReport);
  }

  const criteria = isRecord(report?.criteria) ? report.criteria : null;
  if (criteria === null) {
    malformedReport(`profile ${profile} payload criteria are missing`);
  } else {
    validateCriteria(criteria, registeredContracts, profile, malformedReport);
  }

  const resources = isRecord(report?.resources) ? report.resources : null;
  if (resources === null) {
    malformedReport(`profile ${profile} payload resources are missing`);
  }
  const warningThresholds = readNumericRecord(resources?.warningThresholds);
  if (warningThresholds === null) {
    malformedReport(`profile ${profile} resource warningThresholds are malformed`);
  }
  const warnings = stringArray(resources?.warnings);
  if (warnings === null) {
    malformedReport(`profile ${profile} resource warnings are malformed`);
  }

  const reportPassed = typeof report?.passed === "boolean" ? report.passed : null;
  if (reportPassed === null) {
    malformedReport(`profile ${profile} report.passed is malformed`);
  } else if (!reportPassed) {
    errors.push(`profile ${profile} report.passed is not true`);
  }

  return {
    errors,
    exactProfileCardinality,
    observedCardinality,
    report: malformed ? null : parsed,
    reportPassed,
    warningThresholds,
    warnings: warnings ?? [],
  };
}

export function assessCategoryCompleteness(
  commandResults: readonly Pick<ReleaseCommandResult, "categories" | "id" | "status">[],
): CategoryCoverage[] {
  return REQUIRED_RELEASE_CATEGORIES.map((category) => {
    const evidence = commandResults.filter((result) => result.categories.includes(category));

    return {
      category,
      commandIds: evidence.map((result) => result.id),
      status:
        evidence.length === 0
          ? "missing"
          : evidence.every((result) => result.status === "passed")
            ? "passed"
            : "failed",
    };
  });
}

export function aggregateNoGo(
  commandResults: readonly Pick<ReleaseCommandResult, "id" | "status" | "validationFailures">[],
  categoryCoverage: readonly CategoryCoverage[],
  runnerFailures: readonly string[] = [],
): string[] {
  const reasons = new Set(runnerFailures);

  for (const command of commandResults) {
    if (command.status === "failed") {
      reasons.add(`command ${command.id} failed`);
    }
    for (const failure of command.validationFailures) {
      reasons.add(`${command.id}: ${failure}`);
    }
  }

  for (const coverage of categoryCoverage) {
    if (coverage.status === "missing") {
      reasons.add(`required category ${coverage.category} is missing`);
    } else if (coverage.status === "failed") {
      reasons.add(`required category ${coverage.category} failed`);
    }
  }

  return [...reasons];
}

function requiresExplicitComponentAssignment(evidence: EvidenceLocation): boolean {
  return appsWebVitestPath(evidence.file) === null || evidence.file.startsWith("apps/web/scripts/");
}

export function validateDominantRegressionRuntimeCoverage(
  inventory: readonly DominantRegressionFamily[],
  commandDefinitions: readonly ReleaseCommandDefinition[],
  assignments: readonly DominantRegressionRuntimeComponentAssignment[] = DOMINANT_REGRESSION_RUNTIME_COMPONENT_ASSIGNMENTS,
): string[] {
  const failures: string[] = [];
  const runtimeEvidence = inventory.flatMap((family) => family.runtimeTests);
  const inventoryEvidenceKeys = new Set(
    runtimeEvidence.map((evidence) => dominantRegressionEvidenceKey(evidence)),
  );
  const dominantCommands = commandDefinitions.filter(
    (definition) =>
      definition.cwd === "apps/web" &&
      definition.categories.includes("dominant-regression-inventory"),
  );
  const assignmentByEvidence = new Map<string, DominantRegressionRuntimeComponentAssignment>();
  const validAssignmentKeys = new Set<string>();

  for (const assignment of assignments) {
    const key = dominantRegressionEvidenceKey(assignment.evidence);
    if (assignmentByEvidence.has(key)) {
      failures.push(
        `duplicate runtime component assignment for ${assignment.evidence.file}#${assignment.evidence.marker}`,
      );
    } else {
      assignmentByEvidence.set(key, assignment);
    }

    if (!inventoryEvidenceKeys.has(key)) {
      failures.push(
        `runtime component assignment ${assignment.evidence.file}#${assignment.evidence.marker} is not named by the inventory`,
      );
    }

    const command = commandDefinitions.find(({ id }) => id === assignment.commandId);
    if (command === undefined) {
      failures.push(
        `runtime component assignment ${assignment.evidence.file}#${assignment.evidence.marker} names missing command ${assignment.commandId}`,
      );
      continue;
    }

    const missingCategories = assignment.categories.filter(
      (category) => !command.categories.includes(category),
    );
    if (missingCategories.length > 0) {
      failures.push(
        `runtime component assignment ${assignment.evidence.file}#${assignment.evidence.marker} names categories missing from ${assignment.commandId}: ${missingCategories.join(", ")}`,
      );
    } else if (inventoryEvidenceKeys.has(key)) {
      validAssignmentKeys.add(key);
    }
  }

  for (const family of inventory) {
    for (const evidence of family.runtimeTests) {
      const key = dominantRegressionEvidenceKey(evidence);
      const path = appsWebVitestPath(evidence.file);
      const assignedToDominantCommand =
        path !== null && dominantCommands.some((definition) => definition.command.includes(path));
      const assignedToComponent = validAssignmentKeys.has(key);

      if (path !== null && !assignedToDominantCommand) {
        failures.push(
          `${family.id}: runtime Vitest path ${path} is not assigned to the dominant-regression command`,
        );
      }
      if (requiresExplicitComponentAssignment(evidence) && !assignmentByEvidence.has(key)) {
        failures.push(
          `${family.id}: runtime evidence ${evidence.file}#${evidence.marker} has no explicit component assignment`,
        );
      }
      if (!assignedToDominantCommand && !assignedToComponent) {
        failures.push(
          `${family.id}: runtime evidence ${evidence.file}#${evidence.marker} has no executable assignment`,
        );
      }
    }
  }

  return failures;
}

function profileCommand(profile: ScaleProfile): ReleaseCommandDefinition {
  return {
    categories: [`sql-full-fixture-${profile}`],
    command: [
      "bun",
      "run",
      "scripts/db-performance/run.ts",
      "--profile",
      profile,
      "--full-fixture",
    ],
    cwd: "apps/web",
    id: `sql-exact-${profile}`,
    profile,
  };
}

const DOMINANT_REGRESSION_EXTRA_VITEST_PATHS = [
  "src/lib/server/backfill-due-work-cutover.integration.test.ts",
  "src/lib/server/crawl-cutover.integration.test.ts",
  "src/lib/server/due-work-cutover.integration.test.ts",
  "src/lib/server/due-work-cutover-consumers.test.ts",
  "src/lib/server/due-work-finding-bio-cutover.integration.test.ts",
  "src/lib/server/due-work-image-cutovers.integration.test.ts",
  "src/lib/server/due-work-vendor-core-cutover.integration.test.ts",
  "src/lib/server/health-receipt-cutover.integration.test.ts",
] as const;

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function buildReleaseCommands(
  inventory: readonly DominantRegressionFamily[],
): ReleaseCommandDefinition[] {
  const dominantRegressionVitestPaths = uniqueStrings([
    "scripts/db-performance/dominant-regression-inventory.test.ts",
    "src/lib/server/database-operation-registry.test.ts",
    ...DOMINANT_REGRESSION_EXTRA_VITEST_PATHS,
    ...deriveDominantRegressionVitestPaths(inventory),
  ]);

  return [
    ...SCALE_PROFILES.map(profileCommand),
    {
      categories: [
        "dominant-regression-inventory",
        "operation-registry-classification",
        "compatibility-cutovers",
      ],
      command: [
        "node",
        "../../node_modules/vitest/vitest.mjs",
        "run",
        ...dominantRegressionVitestPaths,
      ],
      cwd: "apps/web",
      id: "component-registry-and-cutovers",
    },
    {
      categories: ["mixed-load"],
      command: [
        "node",
        "../../node_modules/vitest/vitest.mjs",
        "run",
        "scripts/db-performance/mixed-load.test.ts",
      ],
      cwd: "apps/web",
      id: "component-mixed-load",
    },
    {
      categories: ["admission-enforced", "admission-schema", "admission-shadow"],
      command: [
        "node",
        "../../node_modules/vitest/vitest.mjs",
        "run",
        "src/lib/server/database-admission.integration.test.ts",
        "src/lib/server/database-admission-schema.integration.test.ts",
        "src/lib/server/database-admission-shadow.integration.test.ts",
      ],
      cwd: "apps/web",
      id: "component-admission",
    },
    {
      categories: [
        "operation-receipt-schema",
        "operation-receipt-ambiguity",
        "operation-receipt-restart",
      ],
      command: [
        "node",
        "../../node_modules/vitest/vitest.mjs",
        "run",
        "src/lib/server/operation-receipts-schema.integration.test.ts",
        "src/lib/server/operation-receipts.integration.test.ts",
      ],
      cwd: "apps/web",
      id: "component-operation-receipts",
    },
    {
      categories: ["public-projection-convergence"],
      command: [
        "node",
        "../../node_modules/vitest/vitest.mjs",
        "run",
        "src/lib/server/public-projections.integration.test.ts",
      ],
      cwd: "apps/web",
      id: "component-public-projections",
    },
    {
      categories: ["device-derivation"],
      command: [
        "node",
        "../../node_modules/vitest/vitest.mjs",
        "run",
        "scripts/lib/device-db-schema.test.ts",
        "scripts/lib/device-db-derivation.test.ts",
      ],
      cwd: "apps/web",
      id: "component-device-derivation",
    },
    {
      categories: ["device-mirror", "device-scaled-convergence", "device-resource-bounds"],
      command: ["bun", "test", "device-mirror-derivation.test.ts", "device-mirror.test.ts"],
      cwd: "docs/agents/hermes/scripts",
      id: "component-device-mirror",
    },
    {
      categories: ["sonar-rust", "sonar-scaled-delta-full-rebuild"],
      command: [
        "cargo",
        "test",
        "--locked",
        "--offline",
        "--manifest-path",
        "apps/sonar/Cargo.toml",
      ],
      cwd: ".",
      id: "component-sonar-rust",
    },
  ];
}

export function releaseCommands(
  inventory: readonly DominantRegressionFamily[] = DOMINANT_REGRESSION_INVENTORY,
): ReleaseCommandDefinition[] {
  const definitions = buildReleaseCommands(inventory);
  const coverageFailures = validateDominantRegressionRuntimeCoverage(inventory, definitions);
  if (coverageFailures.length > 0) {
    throw new Error(
      `dominant-regression runtime coverage is incomplete: ${coverageFailures.join("; ")}`,
    );
  }
  return definitions;
}

function childEnvironment(): Record<string, string> {
  const safeNames = [
    "BUN_INSTALL",
    "CARGO_HOME",
    "CI",
    "FORCE_COLOR",
    "HOME",
    "LANG",
    "LC_ALL",
    "NO_COLOR",
    "PATH",
    "RUSTUP_HOME",
    "TEMP",
    "TERM",
    "TMP",
    "TMPDIR",
    "XDG_CACHE_HOME",
  ];
  const environment: Record<string, string> = {
    CARGO_NET_OFFLINE: "true",
    FLUNCLE_DB_PERFORMANCE_RELEASE_PROOF: "true",
  };

  for (const name of safeNames) {
    const value = process.env[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }

  return environment;
}

async function captureChild(definition: ReleaseCommandDefinition): Promise<ChildResult> {
  const startedAtMs = performance.now();

  try {
    const process = Bun.spawn(definition.command, {
      cwd: join(REPOSITORY_ROOT, definition.cwd),
      env: childEnvironment(),
      stderr: "pipe",
      stdin: "ignore",
      stdout: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);

    return {
      durationMs: Math.max(0, performance.now() - startedAtMs),
      exitCode,
      spawnError: null,
      stderr,
      stdout,
    };
  } catch (error) {
    return {
      durationMs: Math.max(0, performance.now() - startedAtMs),
      exitCode: null,
      spawnError: errorMessage(error),
      stderr: "",
      stdout: "",
    };
  }
}

function timestampId(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function prepareOutputDirectory(option: string | null, startedAt: Date): Promise<string> {
  const outputDirectory =
    option === null
      ? join(DEFAULT_ARTIFACT_ROOT, timestampId(startedAt))
      : isAbsolute(option)
        ? option
        : resolve(process.cwd(), option);

  if (await pathExists(outputDirectory)) {
    throw new Error(`release artifact directory already exists: ${outputDirectory}`);
  }

  await mkdir(join(outputDirectory, "logs"), { recursive: true });
  await mkdir(join(outputDirectory, "profiles"), { recursive: true });
  return outputDirectory;
}

function manifestArtifactPath(outputDirectory: string, path: string): string {
  return relative(outputDirectory, path).split("\\").join("/");
}

async function writeText(path: string, contents: string): Promise<void> {
  await Bun.write(path, contents);
}

async function runRelease(
  options: ReleaseOptions,
): Promise<{ manifest: JsonRecord; passed: boolean }> {
  const startedAt = new Date();
  const startedAtMs = performance.now();
  const definitions = releaseCommands();
  const outputDirectory = await prepareOutputDirectory(options.outputDirectory, startedAt);
  const commandResults: ReleaseCommandResult[] = [];
  const profileEvidence: ProfileEvidence[] = [];
  const artifactFilenames = new Set<string>();

  for (const definition of definitions) {
    process.stderr.write(`[db:performance:release] running ${definition.id}\n`);
    const commandStartedAt = new Date().toISOString();
    const child = await captureChild(definition);
    const stdoutPath = join(outputDirectory, "logs", `${definition.id}.stdout.log`);
    const stderrPath = join(outputDirectory, "logs", `${definition.id}.stderr.log`);
    await Promise.all([
      writeText(stdoutPath, child.stdout),
      writeText(
        stderrPath,
        child.spawnError === null ? child.stderr : `${child.spawnError}\n${child.stderr}`,
      ),
    ]);
    const commandArtifacts = [
      manifestArtifactPath(outputDirectory, stdoutPath),
      manifestArtifactPath(outputDirectory, stderrPath),
    ];
    commandArtifacts.forEach((filename) => artifactFilenames.add(filename));

    const validationFailures = validateChildResult(child);

    if (definition.profile !== undefined) {
      const profile = definition.profile;
      const validation = validateProfileReport(child.stdout, profile);
      validationFailures.push(...validation.errors);
      let reportArtifact: string | null = null;

      if (validation.report !== null) {
        const reportPath = join(outputDirectory, "profiles", `${profile}.json`);
        await writeText(reportPath, `${JSON.stringify(validation.report, null, 2)}\n`);
        reportArtifact = manifestArtifactPath(outputDirectory, reportPath);
        commandArtifacts.push(reportArtifact);
        artifactFilenames.add(reportArtifact);
      }

      profileEvidence.push({
        commandId: definition.id,
        exactProfileCardinality: validation.exactProfileCardinality,
        expectedCardinality: getScaleManifest(profile).counts,
        observedCardinality: validation.observedCardinality,
        profile,
        reportArtifact,
        reportPassed: validation.reportPassed,
        status: validationFailures.length === 0 ? "passed" : "failed",
        validationFailures: [...validationFailures],
        warningThresholds: validation.warningThresholds,
        warnings: validation.warnings,
      });
    }

    const result: ReleaseCommandResult = {
      artifactFilenames: commandArtifacts,
      categories: definition.categories,
      command: definition.command,
      cwd: definition.cwd,
      durationMs: child.durationMs,
      exitCode: child.exitCode,
      id: definition.id,
      profile: definition.profile ?? null,
      spawnError: child.spawnError,
      startedAt: commandStartedAt,
      status: validationFailures.length === 0 ? "passed" : "failed",
      validationFailures,
    };
    commandResults.push(result);
    process.stderr.write(`[db:performance:release] ${definition.id} ${result.status}\n`);
  }

  const categoryCoverage = assessCategoryCompleteness(commandResults);
  const noGoReasons = aggregateNoGo(commandResults, categoryCoverage);
  const completedAt = new Date();
  const manifestPath = join(outputDirectory, "release-manifest.json");
  const manifestFilename = manifestArtifactPath(outputDirectory, manifestPath);
  artifactFilenames.add(manifestFilename);
  const manifest = {
    artifactDirectory: outputDirectory,
    artifactFilenames: [...artifactFilenames].sort(),
    categoryCoverage,
    commands: commandResults,
    completedAt: completedAt.toISOString(),
    durationMs: Math.max(0, performance.now() - startedAtMs),
    kind: "fluncle.database-performance.release-proof",
    noGoReasons,
    passed: noGoReasons.length === 0,
    profiles: profileEvidence,
    safety: {
      credentials: "not passed to child processes",
      database: "disposable local libSQL fixtures only",
      deploys: false,
      hostedDatabase: false,
      migrations: false,
      network: "not sandboxed; proof commands are expected to remain offline",
      production: false,
      timers: false,
    },
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    startedAt: startedAt.toISOString(),
    verdict: noGoReasons.length === 0 ? "pass" : "no-go",
    warningThresholds: Object.fromEntries(
      profileEvidence.map((evidence) => [evidence.profile, evidence.warningThresholds]),
    ),
  };

  await writeText(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, passed: manifest.passed };
}

async function main(): Promise<void> {
  try {
    const options = parseReleaseArguments(process.argv.slice(2));
    const result = await runRelease(options);
    process.stdout.write(`${JSON.stringify(result.manifest, null, 2)}\n`);
    process.exitCode = result.passed ? 0 : 1;
  } catch (error) {
    process.stderr.write(
      `db:performance:release failed before the manifest could be completed: ${errorMessage(error)}\n`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
