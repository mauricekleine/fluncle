#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { spawn as spawnChild } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
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
import { ISOLATED_LOCAL_LIBSQL_RESOURCE_SOURCE } from "./local-sidecar";
import { expectedFixtureTableCardinalities } from "./fixture";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const DEFAULT_ARTIFACT_ROOT = join(REPOSITORY_ROOT, "apps/web/.dev/db-performance-release");

export const RELEASE_MANIFEST_SCHEMA_VERSION = 4 as const;
const PROCESS_STOP_GRACE_MS = 2_000;
const GIT_INSPECTION_TIMEOUT_MS = 30_000;
const WORKTREE_SETUP_TIMEOUT_MS = 60_000;
const WORKTREE_CLEANUP_TIMEOUT_MS = 30_000;
const FILESYSTEM_CLEANUP_TIMEOUT_MS = 10_000;
const CHILD_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;
const COMPONENT_COMMAND_TIMEOUT_MS = 5 * 60_000;
const SONAR_COMMAND_TIMEOUT_MS = 10 * 60_000;
const PROFILE_COMMAND_TIMEOUT_MS: Record<ScaleProfile, number> = {
  "1x": 5 * 60_000,
  "2x": 8 * 60_000,
  "4x": 12 * 60_000,
};

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
  candidateCommit: string | null;
  outputDirectory: string | null;
};

export type RepositorySnapshot = {
  clean: boolean | null;
  commit: string | null;
  failure: string | null;
  indexHash: string | null;
  treeHash: string | null;
};

export type ReleaseSourceCheckpoint = {
  commandId: string;
  phase: "after-command" | "before-command";
  snapshot: RepositorySnapshot;
};

export type ReleaseSourceEvidence = {
  actualCommit: string | null;
  candidateCommit: string | null;
  candidateSelection: "current-head" | "explicit";
  clean: boolean;
  checkpoints: ReleaseSourceCheckpoint[];
  completed: RepositorySnapshot;
  failures: string[];
  invocation: RepositorySnapshot;
  passed: boolean;
  started: RepositorySnapshot;
};

export type ChildResult = {
  durationMs: number;
  exitCode: number | null;
  spawnError: string | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
};

export type ReleaseCommandResult = {
  artifactFilenames: string[];
  categories: ReleaseCategory[];
  command: string[];
  cwd: string;
  durationMs: number;
  deadlineMs: number;
  exitCode: number | null;
  executionRoot: "detached-candidate-worktree";
  id: string;
  profile: ScaleProfile | null;
  spawnError: string | null;
  startedAt: string;
  status: "failed" | "passed";
  timedOut: boolean;
  validationFailures: string[];
};

export type ReleaseArtifactEvidence = {
  byteSize: number;
  filename: string;
  sha256: string;
};

export type ReleaseArtifactRoot = {
  algorithm: "sha256";
  artifactCount: number;
  candidateCommit: string | null;
  sha256: string;
};

export type ProfileEvidence = {
  candidateCommit: string | null;
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
  timeoutMs: number;
};

export type DetachedExecution = {
  candidateCommit: string;
  cargoTargetDirectory: string;
  dependencyLockSha256: string;
  dependencySource: "shared-install-bound-by-candidate-lockfile";
  rootDirectory: string;
  scratchDirectory: string;
  sourceDirectory: string;
};

export type DetachedExecutionEvidence = {
  candidateCommit: string | null;
  cleanupFailures: string[];
  dependencyLockSha256: string | null;
  dependencySource: DetachedExecution["dependencySource"];
  mode: "detached-candidate-worktree";
  passed: boolean;
  sourceRoot: "detached-candidate-worktree";
};

export type CaptureChildOptions = {
  environment?: Readonly<Record<string, string>>;
  repositoryRoot?: string;
};

export type DetachedExecutionRuntime = {
  makeTemporaryDirectory: (prefix: string) => Promise<string>;
  makeDirectory: (path: string) => Promise<void>;
  removeDirectory: (path: string) => Promise<void>;
  symlinkDirectory: (target: string, path: string) => Promise<void>;
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
  let candidateCommit: string | null = null;
  let outputDirectory: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--candidate-commit") {
      const value = args[index + 1];

      if (!value || !/^[0-9a-f]{40}$/.test(value)) {
        throw new Error("--candidate-commit requires one lowercase 40-character git SHA");
      }
      if (candidateCommit !== null) {
        throw new Error("--candidate-commit may be supplied only once");
      }

      candidateCommit = value;
      index += 1;
      continue;
    }

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

  return { candidateCommit, outputDirectory };
}

export function validateChildResult(result: ChildResult): string[] {
  const failures: string[] = [];

  if (!Number.isFinite(result.durationMs) || result.durationMs < 0) {
    failures.push("child duration is not a non-negative finite number");
  }
  if (result.spawnError !== null) {
    failures.push(`process could not start: ${result.spawnError}`);
  }
  if (result.timedOut) {
    failures.push("child process exceeded its absolute deadline");
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
  expected: Record<string, number>,
): boolean {
  if (observed === null) {
    return false;
  }

  const observedKeys = Object.keys(observed).sort();
  const expectedKeys = Object.keys(expected).sort();

  return (
    observedKeys.length === expectedKeys.length &&
    observedKeys.every(
      (key, index) => key === expectedKeys[index] && observed[key] === expected[key],
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

function redactLocalPath(message: string, path: string, replacement: string): string {
  return path.length === 0 ? message : message.split(path).join(replacement);
}

function validateExactLocalDatabaseEvidence(
  value: unknown,
  profile: ScaleProfile,
  malformedReport: (message: string) => void,
): string[] {
  if (!isRecord(value)) {
    malformedReport(`profile ${profile} report has no database isolation evidence`);
    return [];
  }

  const errors: string[] = [];
  for (const [field, expected] of [
    ["isolation", "local-sidecar-process"],
    ["resourceScope", "benchmark-client-process"],
    ["transport", "local-http"],
  ] as const) {
    if (value[field] !== expected) {
      errors.push(`profile ${profile} database ${field} is not ${expected}`);
    }
  }

  return errors;
}

function validateExactLocalResourceEvidence(
  value: unknown,
  profile: ScaleProfile,
  errors: string[],
  malformedReport: (message: string) => void,
): {
  warningThresholds: Record<string, number> | null;
  warnings: string[];
} {
  const resources = isRecord(value) ? value : null;
  if (resources === null) {
    malformedReport(`profile ${profile} payload resources are missing`);
  } else if (resources.sampleSource !== ISOLATED_LOCAL_LIBSQL_RESOURCE_SOURCE) {
    errors.push(
      `profile ${profile} resource sampleSource is not ${ISOLATED_LOCAL_LIBSQL_RESOURCE_SOURCE}`,
    );
  }

  const warningThresholds = readNumericRecord(resources?.warningThresholds);
  if (warningThresholds === null) {
    malformedReport(`profile ${profile} resource warningThresholds are malformed`);
  }
  const warnings = stringArray(resources?.warnings);
  if (warnings === null) {
    malformedReport(`profile ${profile} resource warnings are malformed`);
  }

  return { warningThresholds, warnings: warnings ?? [] };
}

function validateFixtureCensus(options: {
  errors: string[];
  malformedReport: (message: string) => void;
  profile: ScaleProfile;
  value: unknown;
}): void {
  const { errors, malformedReport, profile } = options;
  const census = isRecord(options.value) ? options.value : null;
  const censusTables = isRecord(census?.tables) ? census.tables : null;
  const censusDistributions = isRecord(census?.distributions) ? census.distributions : null;
  const expectedCensusTables = readNumericRecord(censusTables?.expected);
  const observedCensusTables = readNumericRecord(censusTables?.observed);
  const expectedCensusDistributions = readNumericRecord(censusDistributions?.expected);
  const observedCensusDistributions = readNumericRecord(censusDistributions?.observed);
  const manifestCounts = getScaleManifest(profile).counts;

  if (census === null) {
    malformedReport(`profile ${profile} fixture census is missing`);
  } else {
    if (census.passed !== true) {
      errors.push(`profile ${profile} fixture census.passed is not true`);
    }
    if (stringArray(census.mismatches) === null) {
      malformedReport(`profile ${profile} fixture census mismatches are malformed`);
    } else if (census.mismatches.length > 0) {
      errors.push(`profile ${profile} fixture census reports mismatches`);
    }
  }
  if (
    expectedCensusTables === null ||
    !sameCardinality(expectedCensusTables, expectedFixtureTableCardinalities(manifestCounts))
  ) {
    malformedReport(`profile ${profile} fixture census expected tables are incomplete`);
  }
  if (
    observedCensusTables === null ||
    expectedCensusTables === null ||
    !sameCardinality(observedCensusTables, expectedCensusTables)
  ) {
    errors.push(`profile ${profile} fixture census observed tables do not match expected`);
  }
  if (
    expectedCensusDistributions === null ||
    !sameCardinality(expectedCensusDistributions, manifestCounts)
  ) {
    malformedReport(`profile ${profile} fixture census expected distributions are incomplete`);
  }
  if (
    observedCensusDistributions === null ||
    expectedCensusDistributions === null ||
    !sameCardinality(observedCensusDistributions, expectedCensusDistributions)
  ) {
    errors.push(`profile ${profile} fixture census observed distributions do not match expected`);
  }
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
  errors.push(...validateExactLocalDatabaseEvidence(parsed.database, profile, malformedReport));
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
  validateFixtureCensus({ errors, malformedReport, profile, value: fixture?.census });

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

  const { warningThresholds, warnings } = validateExactLocalResourceEvidence(
    report?.resources,
    profile,
    errors,
    malformedReport,
  );

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
    warnings,
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
    timeoutMs: PROFILE_COMMAND_TIMEOUT_MS[profile],
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
      timeoutMs: COMPONENT_COMMAND_TIMEOUT_MS,
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
      timeoutMs: COMPONENT_COMMAND_TIMEOUT_MS,
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
      timeoutMs: COMPONENT_COMMAND_TIMEOUT_MS,
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
      timeoutMs: COMPONENT_COMMAND_TIMEOUT_MS,
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
      timeoutMs: COMPONENT_COMMAND_TIMEOUT_MS,
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
      timeoutMs: COMPONENT_COMMAND_TIMEOUT_MS,
    },
    {
      categories: ["device-mirror", "device-scaled-convergence", "device-resource-bounds"],
      command: ["bun", "test", "device-mirror-derivation.test.ts", "device-mirror.test.ts"],
      cwd: "docs/agents/hermes/scripts",
      id: "component-device-mirror",
      timeoutMs: COMPONENT_COMMAND_TIMEOUT_MS,
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
      timeoutMs: SONAR_COMMAND_TIMEOUT_MS,
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

async function captureGitCommand(
  repositoryRoot: string,
  args: readonly string[],
  timeoutMs = GIT_INSPECTION_TIMEOUT_MS,
): Promise<{
  exitCode: number;
  failure: string | null;
  stderr: string;
  stdout: string;
}> {
  const result = await captureChild(
    {
      categories: [],
      command: ["git", ...args],
      cwd: ".",
      id: "source-inspection",
      timeoutMs,
    },
    {
      repositoryRoot,
    },
  );
  const failures = validateChildResult(result);
  return {
    exitCode: result.exitCode ?? 1,
    failure: failures.length === 0 ? null : failures.join("; "),
    stderr: result.spawnError === null ? result.stderr : `${result.spawnError}\n${result.stderr}`,
    stdout: result.stdout,
  };
}

function sourcePathExclusion(repositoryRoot: string, path: string): string | null {
  const candidate = relative(repositoryRoot, path).split("\\").join("/");
  return candidate.length > 0 && candidate !== ".." && !candidate.startsWith("../")
    ? `:(exclude)${candidate}/**`
    : null;
}

export async function readRepositorySnapshot(
  repositoryRoot: string,
  outputDirectory: string | null = null,
): Promise<RepositorySnapshot> {
  try {
    const exclusion =
      outputDirectory === null ? null : sourcePathExclusion(repositoryRoot, outputDirectory);
    const statusArguments = ["status", "--porcelain=v1", "--untracked-files=all", "--", "."];
    if (exclusion !== null) {
      statusArguments.push(exclusion);
    }

    const [commit, tree, index, status] = await Promise.all([
      captureGitCommand(repositoryRoot, ["rev-parse", "--verify", "HEAD^{commit}"]),
      captureGitCommand(repositoryRoot, ["rev-parse", "--verify", "HEAD^{tree}"]),
      captureGitCommand(repositoryRoot, ["ls-files", "--stage", "-z"]),
      captureGitCommand(repositoryRoot, statusArguments),
    ]);
    const failures: string[] = [];
    if (commit.exitCode !== 0) {
      failures.push(`git rev-parse failed: ${commit.stderr.trim() || `exit ${commit.exitCode}`}`);
    }
    if (status.exitCode !== 0) {
      failures.push(`git status failed: ${status.stderr.trim() || `exit ${status.exitCode}`}`);
    }
    if (tree.exitCode !== 0) {
      failures.push(`git tree inspection failed: ${tree.stderr.trim() || `exit ${tree.exitCode}`}`);
    }
    if (index.exitCode !== 0) {
      failures.push(
        `git index inspection failed: ${index.stderr.trim() || `exit ${index.exitCode}`}`,
      );
    }

    return {
      clean: status.exitCode === 0 ? status.stdout.trim().length === 0 : null,
      commit: commit.exitCode === 0 ? commit.stdout.trim() : null,
      failure:
        failures.length === 0
          ? null
          : redactLocalPath(failures.join("; "), repositoryRoot, "<repository-root>"),
      indexHash:
        index.exitCode === 0 ? createHash("sha256").update(index.stdout).digest("hex") : null,
      treeHash: tree.exitCode === 0 ? tree.stdout.trim() : null,
    };
  } catch (error) {
    return {
      clean: null,
      commit: null,
      failure: redactLocalPath(errorMessage(error), repositoryRoot, "<repository-root>"),
      indexHash: null,
      treeHash: null,
    };
  }
}

export function assessReleaseSourceEvidence(options: {
  candidateCommit: string | null;
  candidateSelection: ReleaseSourceEvidence["candidateSelection"];
  checkpoints?: readonly ReleaseSourceCheckpoint[];
  completed: RepositorySnapshot;
  invocation?: RepositorySnapshot;
  started: RepositorySnapshot;
}): ReleaseSourceEvidence {
  const failures = new Set<string>();
  const candidateCommit = options.candidateCommit;
  const checkpoints = [...(options.checkpoints ?? [])];
  const invocation = options.invocation ?? options.started;
  const startedTreeHash = options.started.treeHash;
  const startedIndexHash = options.started.indexHash;

  for (const [label, snapshot] of [
    ["invocation", invocation],
    ["execution start", options.started],
    ...checkpoints.map(
      (checkpoint) => [`${checkpoint.phase} ${checkpoint.commandId}`, checkpoint.snapshot] as const,
    ),
    ["completion", options.completed],
  ] as const) {
    if (snapshot.failure !== null) {
      failures.add(`source ${label} inspection failed: ${snapshot.failure}`);
    }
    if (snapshot.commit === null) {
      failures.add(`source ${label} commit is unavailable`);
    }
    if (snapshot.treeHash === null) {
      failures.add(`source ${label} tree hash is unavailable`);
    } else if (startedTreeHash !== null && snapshot.treeHash !== startedTreeHash) {
      failures.add(`source ${label} tree hash changed during proof`);
    }
    if (snapshot.indexHash === null) {
      failures.add(`source ${label} index hash is unavailable`);
    } else if (startedIndexHash !== null && snapshot.indexHash !== startedIndexHash) {
      failures.add(`source ${label} index hash changed during proof`);
    }
    if (snapshot.clean !== true) {
      failures.add(`source tree is not clean at ${label}`);
    }
    if (candidateCommit !== null && snapshot.commit !== candidateCommit) {
      failures.add(
        `source ${label} commit ${snapshot.commit ?? "<unavailable>"} does not match candidate ${candidateCommit}`,
      );
    }
  }

  if (candidateCommit === null) {
    failures.add("candidate commit is unavailable");
  }
  if (
    options.started.commit !== null &&
    options.completed.commit !== null &&
    options.started.commit !== options.completed.commit
  ) {
    failures.add(
      `source commit changed during proof: ${options.started.commit} -> ${options.completed.commit}`,
    );
  }

  const sourceFailures = [...failures];
  const actualCommit =
    options.started.commit !== null && options.started.commit === options.completed.commit
      ? options.started.commit
      : null;

  return {
    actualCommit,
    candidateCommit,
    candidateSelection: options.candidateSelection,
    checkpoints,
    clean:
      invocation.clean === true &&
      options.started.clean === true &&
      checkpoints.every((checkpoint) => checkpoint.snapshot.clean === true) &&
      options.completed.clean === true,
    completed: options.completed,
    failures: sourceFailures,
    invocation,
    passed: sourceFailures.length === 0,
    started: options.started,
  };
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (!signalProcessGroup(pid, 0)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !signalProcessGroup(pid, 0);
}

export async function captureChild(
  definition: ReleaseCommandDefinition,
  options: CaptureChildOptions = {},
): Promise<ChildResult> {
  const startedAtMs = performance.now();
  const executable = definition.command[0];
  if (executable === undefined) {
    return {
      durationMs: 0,
      exitCode: null,
      spawnError: "child command is empty",
      stderr: "",
      stdout: "",
      timedOut: false,
    };
  }

  let stdout = "";
  let stderr = "";
  let spawnError: string | null = null;
  let observedExitCode: number | null = null;
  const append = (current: string, chunk: Uint8Array): string => {
    const combined = current + Buffer.from(chunk).toString("utf8");
    return Buffer.byteLength(combined, "utf8") <= CHILD_OUTPUT_LIMIT_BYTES
      ? combined
      : `[output truncated to final ${CHILD_OUTPUT_LIMIT_BYTES} bytes]\n${combined.slice(-CHILD_OUTPUT_LIMIT_BYTES)}`;
  };

  try {
    const subprocess = spawnChild(executable, definition.command.slice(1), {
      cwd: join(options.repositoryRoot ?? REPOSITORY_ROOT, definition.cwd),
      detached: true,
      env: { ...childEnvironment(), ...options.environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    subprocess.stdout.on("data", (chunk: Uint8Array) => {
      stdout = append(stdout, chunk);
    });
    subprocess.stderr.on("data", (chunk: Uint8Array) => {
      stderr = append(stderr, chunk);
    });
    const exited = new Promise<void>((resolve) => {
      subprocess.once("error", (error) => {
        spawnError = errorMessage(error);
        resolve();
      });
      subprocess.once("exit", (code) => {
        observedExitCode = code;
        resolve();
      });
    });
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      exited.then(() => false),
      new Promise<true>((resolve) => {
        deadlineTimer = setTimeout(() => resolve(true), definition.timeoutMs);
      }),
    ]);
    if (deadlineTimer !== undefined) {
      clearTimeout(deadlineTimer);
    }

    if (timedOut) {
      const pid = subprocess.pid;
      if (pid !== undefined) {
        if (!signalProcessGroup(pid, "SIGTERM")) {
          try {
            subprocess.kill("SIGTERM");
          } catch {
            // The child exited between the liveness observation and the signal.
          }
        }
      }
      await Promise.race([
        exited,
        new Promise<void>((resolve) => setTimeout(resolve, PROCESS_STOP_GRACE_MS)),
      ]);
      if (pid !== undefined && signalProcessGroup(pid, 0)) {
        if (!signalProcessGroup(pid, "SIGKILL")) {
          try {
            subprocess.kill("SIGKILL");
          } catch {
            // The child exited between the liveness observation and the signal.
          }
        }
        await Promise.race([
          exited,
          new Promise<void>((resolve) => setTimeout(resolve, PROCESS_STOP_GRACE_MS)),
        ]);
        if (!(await waitForProcessGroupExit(pid, PROCESS_STOP_GRACE_MS))) {
          spawnError ??= "owned child process group survived SIGKILL";
        }
      }
    }

    return {
      durationMs: Math.max(0, performance.now() - startedAtMs),
      exitCode: observedExitCode,
      spawnError,
      stderr,
      stdout,
      timedOut,
    };
  } catch (error) {
    return {
      durationMs: Math.max(0, performance.now() - startedAtMs),
      exitCode: null,
      spawnError: errorMessage(error),
      stderr,
      stdout,
      timedOut: false,
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

async function withAbsoluteTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

const DEFAULT_DETACHED_EXECUTION_RUNTIME: DetachedExecutionRuntime = {
  async makeDirectory(path) {
    await mkdir(path, { recursive: true });
  },
  makeTemporaryDirectory: mkdtemp,
  async removeDirectory(path) {
    await rm(path, { force: true, recursive: true });
  },
  async symlinkDirectory(target, path) {
    await symlink(target, path, "dir");
  },
};

function gitCommandFailure(command: string, result: Awaited<ReturnType<typeof captureGitCommand>>) {
  return result.failure === null
    ? null
    : `${command} failed: ${result.failure}${result.stderr.trim().length > 0 ? `; ${result.stderr.trim()}` : ""}`;
}

export async function cleanupDetachedExecution(
  execution: Pick<DetachedExecution, "rootDirectory" | "sourceDirectory">,
  options: {
    cleanupTimeoutMs?: number;
    invocationRoot?: string;
    runtime?: DetachedExecutionRuntime;
  } = {},
): Promise<string[]> {
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? FILESYSTEM_CLEANUP_TIMEOUT_MS;
  const invocationRoot = options.invocationRoot ?? REPOSITORY_ROOT;
  const runtime = options.runtime ?? DEFAULT_DETACHED_EXECUTION_RUNTIME;
  const failures: string[] = [];
  const removeWorktree = await captureGitCommand(
    invocationRoot,
    ["worktree", "remove", "--force", execution.sourceDirectory],
    WORKTREE_CLEANUP_TIMEOUT_MS,
  );
  const worktreeFailure = gitCommandFailure("git worktree remove", removeWorktree);
  if (worktreeFailure !== null) {
    failures.push(worktreeFailure);
  }
  try {
    await withAbsoluteTimeout(
      runtime.removeDirectory(execution.rootDirectory),
      cleanupTimeoutMs,
      "detached execution directory cleanup",
    );
  } catch (error) {
    failures.push(`detached execution directory cleanup failed: ${errorMessage(error)}`);
  }
  return failures.map((failure) =>
    redactLocalPath(
      redactLocalPath(failure, execution.rootDirectory, "<detached-execution-root>"),
      invocationRoot,
      "<invocation-root>",
    ),
  );
}

export async function prepareDetachedExecution(options: {
  candidateCommit: string;
  invocationRoot?: string;
  runtime?: DetachedExecutionRuntime;
}): Promise<DetachedExecution> {
  const invocationRoot = options.invocationRoot ?? REPOSITORY_ROOT;
  const runtime = options.runtime ?? DEFAULT_DETACHED_EXECUTION_RUNTIME;
  const rootDirectory = await withAbsoluteTimeout(
    runtime.makeTemporaryDirectory(join(tmpdir(), "fluncle-db-release-source-")),
    WORKTREE_SETUP_TIMEOUT_MS,
    "detached execution directory creation",
  );
  const sourceDirectory = join(rootDirectory, "source");
  const partialExecution = { rootDirectory, sourceDirectory };

  try {
    const dependencyDirectory = join(invocationRoot, "node_modules");
    const dependencyStat = await stat(dependencyDirectory);
    if (!dependencyStat.isDirectory()) {
      throw new Error("the shared dependency install is not a directory");
    }
    const addWorktree = await captureGitCommand(
      invocationRoot,
      ["worktree", "add", "--detach", sourceDirectory, options.candidateCommit],
      WORKTREE_SETUP_TIMEOUT_MS,
    );
    const addFailure = gitCommandFailure("git worktree add", addWorktree);
    if (addFailure !== null) {
      throw new Error(addFailure);
    }

    const scratchDirectory = join(rootDirectory, "scratch");
    const cargoTargetDirectory = join(rootDirectory, "cargo-target");
    await Promise.all([
      withAbsoluteTimeout(
        runtime.makeDirectory(scratchDirectory),
        WORKTREE_SETUP_TIMEOUT_MS,
        "detached database scratch creation",
      ),
      withAbsoluteTimeout(
        runtime.makeDirectory(cargoTargetDirectory),
        WORKTREE_SETUP_TIMEOUT_MS,
        "detached Cargo target creation",
      ),
      withAbsoluteTimeout(
        runtime.symlinkDirectory(dependencyDirectory, join(sourceDirectory, "node_modules")),
        WORKTREE_SETUP_TIMEOUT_MS,
        "detached dependency binding",
      ),
    ]);
    const [candidateLockfile, invocationLockfile] = await Promise.all([
      readFile(join(sourceDirectory, "bun.lock")),
      readFile(join(invocationRoot, "bun.lock")),
    ]);
    const candidateLockSha256 = createHash("sha256").update(candidateLockfile).digest("hex");
    const invocationLockSha256 = createHash("sha256").update(invocationLockfile).digest("hex");
    if (candidateLockSha256 !== invocationLockSha256) {
      throw new Error(
        "shared dependency install is not bound to the candidate bun.lock; install the candidate dependencies before release proof",
      );
    }

    return {
      candidateCommit: options.candidateCommit,
      cargoTargetDirectory,
      dependencyLockSha256: candidateLockSha256,
      dependencySource: "shared-install-bound-by-candidate-lockfile",
      rootDirectory,
      scratchDirectory,
      sourceDirectory,
    };
  } catch (error) {
    const cleanupFailures = await cleanupDetachedExecution(partialExecution, {
      invocationRoot,
      runtime,
    });
    const failure = [errorMessage(error), ...cleanupFailures]
      .filter((value) => value.length > 0)
      .join("; ");
    throw new Error(
      redactLocalPath(
        redactLocalPath(failure, rootDirectory, "<detached-execution-root>"),
        invocationRoot,
        "<invocation-root>",
      ),
    );
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

export function validatePortableArtifactFilename(filename: string): string {
  if (
    filename.length === 0 ||
    isAbsolute(filename) ||
    filename.includes("\\") ||
    filename
      .split("/")
      .some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error(`release artifact filename is not a portable relative path: ${filename}`);
  }
  return filename;
}

function manifestArtifactPath(outputDirectory: string, path: string): string {
  return validatePortableArtifactFilename(relative(outputDirectory, path).split("\\").join("/"));
}

export function buildArtifactEvidence(
  filename: string,
  contents: string | Uint8Array,
): ReleaseArtifactEvidence {
  const bytes = typeof contents === "string" ? Buffer.from(contents, "utf8") : contents;
  return {
    byteSize: bytes.byteLength,
    filename: validatePortableArtifactFilename(filename),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function validateArtifactContents(
  evidence: ReleaseArtifactEvidence,
  contents: string | Uint8Array,
): string[] {
  const observed = buildArtifactEvidence(evidence.filename, contents);
  const failures: string[] = [];
  if (observed.byteSize !== evidence.byteSize) {
    failures.push(
      `artifact ${evidence.filename} byte size ${observed.byteSize} does not match ${evidence.byteSize}`,
    );
  }
  if (observed.sha256 !== evidence.sha256) {
    failures.push(`artifact ${evidence.filename} SHA-256 does not match`);
  }
  return failures;
}

export function buildArtifactRoot(
  artifacts: readonly ReleaseArtifactEvidence[],
  candidateCommit: string | null,
): ReleaseArtifactRoot {
  const sorted = [...artifacts].sort((left, right) => left.filename.localeCompare(right.filename));
  return {
    algorithm: "sha256",
    artifactCount: sorted.length,
    candidateCommit,
    sha256: createHash("sha256")
      .update(JSON.stringify({ artifacts: sorted, candidateCommit }))
      .digest("hex"),
  };
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
  const invocationSource = await readRepositorySnapshot(REPOSITORY_ROOT, outputDirectory);
  const candidateSelection = options.candidateCommit === null ? "current-head" : "explicit";
  const candidateCommit = options.candidateCommit ?? invocationSource.commit;
  const commandResults: ReleaseCommandResult[] = [];
  const profileEvidence: ProfileEvidence[] = [];
  const sourceCheckpoints: ReleaseSourceCheckpoint[] = [];
  const artifactFilenames = new Set<string>();
  const artifacts = new Map<string, ReleaseArtifactEvidence>();
  const runnerFailures: string[] = [];
  let execution: DetachedExecution | null = null;
  let startedSource: RepositorySnapshot = {
    clean: null,
    commit: null,
    failure: "detached candidate execution was not prepared",
    indexHash: null,
    treeHash: null,
  };
  let completedSource = startedSource;

  if (invocationSource.failure !== null) {
    runnerFailures.push(`invocation source inspection failed: ${invocationSource.failure}`);
  } else if (invocationSource.clean !== true) {
    runnerFailures.push("invocation source tree is not clean");
  } else if (candidateCommit === null) {
    runnerFailures.push("detached execution candidate commit is unavailable");
  } else if (invocationSource.commit !== candidateCommit) {
    runnerFailures.push(
      `invocation commit ${invocationSource.commit ?? "<unavailable>"} does not match candidate ${candidateCommit}`,
    );
  } else {
    try {
      execution = await prepareDetachedExecution({ candidateCommit });
      startedSource = await readRepositorySnapshot(execution.sourceDirectory);
      completedSource = startedSource;
    } catch (error) {
      runnerFailures.push(`detached execution setup failed: ${errorMessage(error)}`);
    }
  }

  try {
    for (const definition of execution === null ? [] : definitions) {
      sourceCheckpoints.push({
        commandId: definition.id,
        phase: "before-command",
        snapshot: await readRepositorySnapshot(execution.sourceDirectory),
      });
      process.stderr.write(`[db:performance:release] running ${definition.id}\n`);
      const commandStartedAt = new Date().toISOString();
      const child = await captureChild(definition, {
        environment: {
          CARGO_TARGET_DIR: execution.cargoTargetDirectory,
          FLUNCLE_DB_PERFORMANCE_SCRATCH_ROOT: execution.scratchDirectory,
          TEMP: execution.scratchDirectory,
          TMP: execution.scratchDirectory,
          TMPDIR: execution.scratchDirectory,
        },
        repositoryRoot: execution.sourceDirectory,
      });
      const stdoutPath = join(outputDirectory, "logs", `${definition.id}.stdout.log`);
      const stderrPath = join(outputDirectory, "logs", `${definition.id}.stderr.log`);
      const stderrContents =
        child.spawnError === null ? child.stderr : `${child.spawnError}\n${child.stderr}`;
      await Promise.all([
        writeText(stdoutPath, child.stdout),
        writeText(stderrPath, stderrContents),
      ]);
      const commandArtifacts = [
        manifestArtifactPath(outputDirectory, stdoutPath),
        manifestArtifactPath(outputDirectory, stderrPath),
      ];
      for (const [filename, contents] of [
        [commandArtifacts[0], child.stdout],
        [commandArtifacts[1], stderrContents],
      ] as const) {
        artifactFilenames.add(filename);
        artifacts.set(filename, buildArtifactEvidence(filename, contents));
      }

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
          artifacts.set(
            reportArtifact,
            buildArtifactEvidence(
              reportArtifact,
              `${JSON.stringify(validation.report, null, 2)}\n`,
            ),
          );
        }

        profileEvidence.push({
          candidateCommit,
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
        deadlineMs: definition.timeoutMs,
        durationMs: child.durationMs,
        executionRoot: "detached-candidate-worktree",
        exitCode: child.exitCode,
        id: definition.id,
        profile: definition.profile ?? null,
        spawnError: child.spawnError,
        startedAt: commandStartedAt,
        status: validationFailures.length === 0 ? "passed" : "failed",
        timedOut: child.timedOut,
        validationFailures,
      };
      commandResults.push(result);
      sourceCheckpoints.push({
        commandId: definition.id,
        phase: "after-command",
        snapshot: await readRepositorySnapshot(execution.sourceDirectory),
      });
      process.stderr.write(`[db:performance:release] ${definition.id} ${result.status}\n`);
    }
    if (execution !== null) {
      completedSource = await readRepositorySnapshot(execution.sourceDirectory);
    }
  } catch (error) {
    runnerFailures.push(`detached execution failed: ${errorMessage(error)}`);
    if (execution !== null) {
      completedSource = await readRepositorySnapshot(execution.sourceDirectory);
    }
  }

  const categoryCoverage = assessCategoryCompleteness(commandResults);
  const source = assessReleaseSourceEvidence({
    candidateCommit,
    candidateSelection,
    checkpoints: sourceCheckpoints,
    completed: completedSource,
    invocation: invocationSource,
    started: startedSource,
  });
  let cleanupFailures: string[] = [];
  if (execution !== null) {
    cleanupFailures = await cleanupDetachedExecution(execution);
    runnerFailures.push(...cleanupFailures.map((failure) => `detached execution ${failure}`));
  }
  const artifactFailures: string[] = [];
  for (const evidence of artifacts.values()) {
    try {
      artifactFailures.push(
        ...validateArtifactContents(
          evidence,
          new Uint8Array(await readFile(join(outputDirectory, evidence.filename))),
        ),
      );
    } catch (error) {
      artifactFailures.push(
        `artifact ${evidence.filename} could not be verified: ${errorMessage(error)}`,
      );
    }
  }
  const noGoReasons = aggregateNoGo(commandResults, categoryCoverage, [
    ...runnerFailures,
    ...source.failures,
    ...artifactFailures,
  ]);
  const completedAt = new Date();
  const manifestPath = join(outputDirectory, "release-manifest.json");
  const sortedArtifacts = [...artifacts.values()].sort((left, right) =>
    left.filename.localeCompare(right.filename),
  );
  const manifest = {
    artifactFilenames: [...artifactFilenames].sort(),
    artifactRoot: buildArtifactRoot(sortedArtifacts, candidateCommit),
    artifacts: sortedArtifacts,
    categoryCoverage,
    commands: commandResults,
    completedAt: completedAt.toISOString(),
    durationMs: Math.max(0, performance.now() - startedAtMs),
    execution: {
      candidateCommit,
      cleanupFailures,
      dependencyLockSha256: execution?.dependencyLockSha256 ?? null,
      dependencySource: "shared-install-bound-by-candidate-lockfile",
      mode: "detached-candidate-worktree",
      passed: execution !== null && cleanupFailures.length === 0 && source.passed,
      sourceRoot: "detached-candidate-worktree",
    } satisfies DetachedExecutionEvidence,
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
    source,
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
