#!/usr/bin/env bun
import { mkdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PERFORMANCE_CRITERION_CATEGORIES } from "./budgets";
import {
  getScaleManifest,
  SCALE_PROFILES,
  type FixtureCounts,
  type ScaleProfile,
} from "./manifest";
import { PERFORMANCE_REPORT_SCHEMA_VERSION } from "./registry";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const DEFAULT_ARTIFACT_ROOT = join(REPOSITORY_ROOT, "apps/web/.dev/db-performance-release");

export const RELEASE_MANIFEST_SCHEMA_VERSION = 1 as const;

export const REQUIRED_RELEASE_CATEGORIES = [
  "sql-full-fixture-1x",
  "sql-full-fixture-2x",
  "sql-full-fixture-4x",
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

type CommandDefinition = {
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
      errors: [
        `profile ${profile} stdout is not one JSON document: ${error instanceof Error ? error.message : String(error)}`,
      ],
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
  if (!(parsed.indexAudit === null || isRecord(parsed.indexAudit))) {
    malformedReport(`profile ${profile} report has malformed indexAudit evidence`);
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
  if (!Array.isArray(report?.contracts)) {
    malformedReport(`profile ${profile} payload contracts are missing`);
  }

  const criteria = isRecord(report?.criteria) ? report.criteria : null;
  if (criteria === null) {
    malformedReport(`profile ${profile} payload criteria are missing`);
  } else {
    for (const category of PERFORMANCE_CRITERION_CATEGORIES) {
      if (!isRecord(criteria[category])) {
        malformedReport(`profile ${profile} payload criterion ${category} is missing`);
      }
    }
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

function profileCommand(profile: ScaleProfile): CommandDefinition {
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

function releaseCommands(): CommandDefinition[] {
  return [
    ...SCALE_PROFILES.map(profileCommand),
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

async function captureChild(definition: CommandDefinition): Promise<ChildResult> {
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
      spawnError: error instanceof Error ? error.message : String(error),
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
  const outputDirectory = await prepareOutputDirectory(options.outputDirectory, startedAt);
  const commandResults: ReleaseCommandResult[] = [];
  const profileEvidence: ProfileEvidence[] = [];
  const artifactFilenames = new Set<string>();

  for (const definition of releaseCommands()) {
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
      credentials: "not inherited",
      database: "disposable local libSQL fixtures only",
      deploys: false,
      hostedDatabase: false,
      migrations: false,
      network: false,
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
      `db:performance:release failed before the manifest could be completed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
