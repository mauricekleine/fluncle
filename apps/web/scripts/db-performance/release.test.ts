import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PERFORMANCE_BUDGETS, PERFORMANCE_CRITERION_CATEGORIES } from "./budgets";
import { performanceRegistry } from "./contracts";
import {
  deriveDominantRegressionVitestPaths,
  DOMINANT_REGRESSION_INVENTORY,
} from "./dominant-regression-inventory";
import { getScaleManifest } from "./manifest";
import { expectedFixtureTableCardinalities } from "./fixture";
import { ISOLATED_LOCAL_LIBSQL_RESOURCE_SOURCE } from "./local-sidecar";
import { PERFORMANCE_REPORT_SCHEMA_VERSION } from "./registry";
import {
  aggregateNoGo,
  assessReleaseSourceEvidence,
  assessCategoryCompleteness,
  buildArtifactEvidence,
  buildArtifactRoot,
  captureChild,
  cleanupDetachedExecution,
  DOMINANT_REGRESSION_RUNTIME_COMPONENT_ASSIGNMENTS,
  parseReleaseArguments,
  prepareDetachedExecution,
  readRepositorySnapshot,
  REQUIRED_RELEASE_CATEGORIES,
  releaseCommands,
  type ChildResult,
  type DetachedExecution,
  type DetachedExecutionRuntime,
  type ReleaseCommandResult,
  validateArtifactContents,
  validateChildResult,
  validateDominantRegressionRuntimeCoverage,
  validateExternalArtifactDirectory,
  validateProfileReport,
  validatePortableArtifactFilename,
} from "./release";

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const child = spawn("git", [...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Uint8Array) => {
    stdout += Buffer.from(chunk).toString("utf8");
  });
  child.stderr.on("data", (chunk: Uint8Array) => {
    stderr += Buffer.from(chunk).toString("utf8");
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  }
  return stdout.trim();
}

async function makeCandidateRepository(testDirectory: string): Promise<{
  candidateCommit: string;
  repository: string;
}> {
  const repository = join(testDirectory, "repository");
  await mkdir(join(repository, "node_modules", "proof-dependency"), { recursive: true });
  await git(repository, ["init"]);
  await Promise.all([
    writeFile(join(repository, ".gitignore"), "node_modules\n"),
    writeFile(join(repository, "bun.lock"), "candidate-lock\n"),
    writeFile(
      join(repository, "node_modules", "proof-dependency", "value.txt"),
      "live-dependency\n",
    ),
    writeFile(join(repository, "source.txt"), "candidate-source\n"),
  ]);
  await git(repository, ["add", ".gitignore", "bun.lock", "source.txt"]);
  await git(repository, [
    "-c",
    "user.name=Release Proof Test",
    "-c",
    "user.email=release-proof@example.invalid",
    "commit",
    "--no-gpg-sign",
    "-m",
    "candidate",
  ]);
  return { candidateCommit: await git(repository, ["rev-parse", "HEAD"]), repository };
}

const FILESYSTEM_RUNTIME: DetachedExecutionRuntime = {
  async installDependencies(sourceDirectory) {
    const dependencyDirectory = join(sourceDirectory, "node_modules", "proof-dependency");
    await mkdir(dependencyDirectory, { recursive: true });
    await writeFile(join(dependencyDirectory, "value.txt"), "candidate-dependency\n");
    return { installerVersion: "test-bun" };
  },
  async makeDirectory(path) {
    await mkdir(path, { recursive: true });
  },
  makeTemporaryDirectory: mkdtemp,
  async removeDirectory(path) {
    await rm(path, { force: true, recursive: true });
  },
};

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function validProfileReport(profile: "1x" | "2x" | "4x"): string {
  const registeredContracts = performanceRegistry.list();
  const counts = getScaleManifest(profile).counts;
  const distribution = { max: 1, p50: 1, p95: 1, p99: 1 };

  return JSON.stringify({
    clientBounds: { local: 1 },
    database: {
      isolation: "local-sidecar-process",
      resourceScope: "benchmark-client-process",
      transport: "local-http",
    },
    environment: "local",
    fixture: {
      census: {
        distributions: { expected: counts, observed: counts },
        mismatches: [],
        passed: true,
        tables: {
          expected: expectedFixtureTableCardinalities(counts),
          observed: expectedFixtureTableCardinalities(counts),
        },
      },
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
        sampleSource: ISOLATED_LOCAL_LIBSQL_RESOURCE_SOURCE,
        unavailableReason: null,
        warningThresholds: {
          heapUsedBytes: 1,
          rssBytes: 2,
          wallDurationMs: 3,
        },
        warnings: [],
      },
      schemaVersion: PERFORMANCE_REPORT_SCHEMA_VERSION,
    },
    schemaVersion: PERFORMANCE_REPORT_SCHEMA_VERSION,
  });
}

function child(overrides: Partial<ChildResult> = {}): ChildResult {
  return {
    durationMs: 1,
    executionRoot: "detached-candidate-worktree",
    exitCode: 0,
    spawnError: null,
    stderr: "",
    stdout: "",
    timedOut: false,
    ...overrides,
  };
}

function commandResult(overrides: Partial<ReleaseCommandResult> = {}): ReleaseCommandResult {
  return {
    artifactFilenames: [],
    categories: ["mixed-load"],
    command: ["bun", "test"],
    cwd: ".",
    deadlineMs: 1_000,
    durationMs: 1,
    exitCode: 0,
    id: "component",
    profile: null,
    spawnError: null,
    startedAt: "2026-08-27T00:00:00.000Z",
    status: "passed",
    timedOut: false,
    validationFailures: [],
    ...overrides,
  };
}

describe("database performance release proof", () => {
  it("parses only one optional output directory", () => {
    expect(parseReleaseArguments([])).toEqual({ candidateCommit: null, outputDirectory: null });
    expect(parseReleaseArguments(["--output-dir", "/tmp/proof"])).toEqual({
      candidateCommit: null,
      outputDirectory: "/tmp/proof",
    });
    expect(
      parseReleaseArguments(["--candidate-commit", "afeec3b9c15fb2350dcc9dc34c72d1d60e9b69cf"]),
    ).toEqual({
      candidateCommit: "afeec3b9c15fb2350dcc9dc34c72d1d60e9b69cf",
      outputDirectory: null,
    });
    expect(() => parseReleaseArguments(["--output-dir"])).toThrow(
      "--output-dir requires a directory path",
    );
    expect(() => parseReleaseArguments(["--output-dir", "one", "--output-dir", "two"])).toThrow(
      "--output-dir may be supplied only once",
    );
    expect(() => parseReleaseArguments(["--candidate-commit", "afeec3b9"])).toThrow(
      "lowercase 40-character git SHA",
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
    expect(validateChildResult(child({ timedOut: true }))).toContain(
      "child process exceeded its absolute deadline",
    );
  });

  it.skipIf(process.platform === "win32")(
    "enforces an absolute command deadline and kills the owned process group",
    async () => {
      const testDirectory = await mkdtemp("/tmp/db-performance-command-deadline-");
      const descendantPidPath = join(testDirectory, "descendant.pid");
      const program = `const { spawn } = await import("node:child_process"); const { writeFile } = await import("node:fs/promises"); const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1000)"], { stdio: "ignore" }); await writeFile(${JSON.stringify(descendantPidPath)}, String(child.pid)); process.on("SIGTERM", () => undefined); setInterval(() => undefined, 1000);`;
      let descendantPid: number | null = null;

      try {
        const result = await captureChild({
          categories: [],
          command: [process.execPath, "-e", program],
          cwd: ".",
          id: "deadline-fixture",
          timeoutMs: 100,
        });
        await waitFor(() => pathExists(descendantPidPath));
        descendantPid = Number.parseInt(await readFile(descendantPidPath, "utf8"), 10);

        expect(result.timedOut).toBe(true);
        expect(validateChildResult(result)).toEqual(
          expect.arrayContaining([
            "child process exceeded its absolute deadline",
            "child process has no valid exit code",
          ]),
        );
        await waitFor(() => !processExists(descendantPid ?? -1));
        expect(processExists(descendantPid)).toBe(false);
      } finally {
        if (descendantPid !== null && processExists(descendantPid)) {
          try {
            process.kill(descendantPid, "SIGKILL");
          } catch {
            // The process exited between the liveness check and signal.
          }
        }
        await rm(testDirectory, { force: true, recursive: true });
      }
    },
    8_000,
  );

  it.skipIf(process.platform === "win32")(
    "executes candidate source and dependencies while the invocation worktree mutates and restores",
    async () => {
      const testDirectory = await mkdtemp("/tmp/db-performance-detached-source-");
      const { candidateCommit, repository } = await makeCandidateRepository(testDirectory);
      let execution: DetachedExecution | null = null;

      try {
        const invocation = await readRepositorySnapshot(repository);
        execution = await prepareDetachedExecution({
          candidateCommit,
          invocationRoot: repository,
          runtime: FILESYSTEM_RUNTIME,
        });
        const started = await readRepositorySnapshot(execution.sourceDirectory);
        const childPromise = captureChild(
          {
            categories: [],
            command: [
              process.execPath,
              "-e",
              'const { readFile } = await import("node:fs/promises"); await new Promise((resolve) => setTimeout(resolve, 150)); const [source, dependency] = await Promise.all([readFile("source.txt", "utf8"), readFile("node_modules/proof-dependency/value.txt", "utf8")]); process.stdout.write(JSON.stringify({ dependency, source }));',
            ],
            cwd: ".",
            id: "detached-source-fixture",
            timeoutMs: 2_000,
          },
          { repositoryRoot: execution.sourceDirectory },
        );

        await writeFile(join(repository, "source.txt"), "transient-live-mutation\n");
        await writeFile(
          join(repository, "node_modules", "proof-dependency", "value.txt"),
          "transient-live-dependency-mutation\n",
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        await writeFile(join(repository, "source.txt"), "candidate-source\n");
        await writeFile(
          join(repository, "node_modules", "proof-dependency", "value.txt"),
          "live-dependency\n",
        );
        const child = await childPromise;
        const completed = await readRepositorySnapshot(execution.sourceDirectory);
        const evidence = assessReleaseSourceEvidence({
          candidateCommit,
          candidateSelection: "explicit",
          completed,
          invocation,
          started,
        });

        expect(JSON.parse(child.stdout)).toEqual({
          dependency: "candidate-dependency\n",
          source: "candidate-source\n",
        });
        expect(validateChildResult(child)).toEqual([]);
        expect(execution).toMatchObject({
          dependencyInstallMethod: "bun-install-offline-frozen-copyfile-ignore-scripts",
          dependencyInstallerVersion: "test-bun",
          dependencySource: "candidate-local-offline-install",
        });
        expect(evidence).toMatchObject({
          actualCommit: candidateCommit,
          candidateCommit,
          clean: true,
          failures: [],
          passed: true,
        });
        expect(await cleanupDetachedExecution(execution, { invocationRoot: repository })).toEqual(
          [],
        );
        expect(await pathExists(execution.rootDirectory)).toBe(false);
        expect(await git(repository, ["worktree", "list", "--porcelain"])).not.toContain(
          execution.sourceDirectory,
        );
        execution = null;
      } finally {
        if (execution !== null) {
          await cleanupDetachedExecution(execution, { invocationRoot: repository });
        }
        await rm(testDirectory, { force: true, recursive: true });
      }
    },
    10_000,
  );

  it.skipIf(process.platform === "win32")(
    "removes a partially prepared worktree when the offline dependency install fails",
    async () => {
      const testDirectory = await mkdtemp("/tmp/db-performance-detached-setup-");
      const { candidateCommit, repository } = await makeCandidateRepository(testDirectory);
      const runtime: DetachedExecutionRuntime = {
        ...FILESYSTEM_RUNTIME,
        async installDependencies() {
          throw new Error("offline install refused");
        },
      };

      try {
        await expect(
          prepareDetachedExecution({ candidateCommit, invocationRoot: repository, runtime }),
        ).rejects.toThrow("offline install refused");
        const worktrees = await git(repository, ["worktree", "list", "--porcelain"]);
        expect(worktrees.match(/^worktree /gm)).toHaveLength(1);
      } finally {
        await rm(testDirectory, { force: true, recursive: true });
      }
    },
    10_000,
  );

  it.skipIf(process.platform === "win32")(
    "rejects an offline dependency install that changes the candidate lockfile",
    async () => {
      const testDirectory = await mkdtemp("/tmp/db-performance-detached-lock-");
      const { candidateCommit, repository } = await makeCandidateRepository(testDirectory);
      const runtime: DetachedExecutionRuntime = {
        ...FILESYSTEM_RUNTIME,
        async installDependencies(sourceDirectory, scratchDirectory) {
          const installed = await FILESYSTEM_RUNTIME.installDependencies(
            sourceDirectory,
            scratchDirectory,
          );
          await writeFile(join(sourceDirectory, "bun.lock"), "mutated-candidate-lock\n");
          return installed;
        },
      };

      try {
        await expect(
          prepareDetachedExecution({ candidateCommit, invocationRoot: repository, runtime }),
        ).rejects.toThrow(
          "offline frozen candidate dependency install changed the candidate bun.lock",
        );
        const worktrees = await git(repository, ["worktree", "list", "--porcelain"]);
        expect(worktrees.match(/^worktree /gm)).toHaveLength(1);
      } finally {
        await rm(testDirectory, { force: true, recursive: true });
      }
    },
    10_000,
  );

  it.skipIf(process.platform === "win32")(
    "bounds detached-directory cleanup and reports it as a failure",
    async () => {
      const testDirectory = await mkdtemp("/tmp/db-performance-detached-cleanup-");
      const { candidateCommit, repository } = await makeCandidateRepository(testDirectory);
      const execution = await prepareDetachedExecution({
        candidateCommit,
        invocationRoot: repository,
        runtime: FILESYSTEM_RUNTIME,
      });
      const runtime: DetachedExecutionRuntime = {
        ...FILESYSTEM_RUNTIME,
        removeDirectory: async () => await new Promise<void>(() => undefined),
      };

      try {
        const failures = await cleanupDetachedExecution(execution, {
          cleanupTimeoutMs: 10,
          invocationRoot: repository,
          runtime,
        });
        expect(failures).toEqual([
          "detached execution directory cleanup failed: detached execution directory cleanup timed out after 10ms",
        ]);
        expect(await git(repository, ["worktree", "list", "--porcelain"])).not.toContain(
          execution.sourceDirectory,
        );
      } finally {
        await rm(testDirectory, { force: true, recursive: true });
      }
    },
    10_000,
  );

  it("binds portable relative artifacts to their exact bytes", () => {
    const evidence = buildArtifactEvidence("profiles/2x.json", '{"passed":true}\n');

    expect(evidence).toEqual({
      byteSize: 16,
      filename: "profiles/2x.json",
      sha256: "1ea63e7fda68e7ce49b013af8410102e9228f7591e79ef602dd23d95556d03bc",
    });
    expect(validateArtifactContents(evidence, '{"passed":true}\n')).toEqual([]);
    expect(validateArtifactContents(evidence, '{"passed":false}\n')).toEqual([
      "artifact profiles/2x.json byte size 17 does not match 16",
      "artifact profiles/2x.json SHA-256 does not match",
    ]);
  });

  it("rejects absolute, traversing, and platform-specific artifact paths", () => {
    expect(validatePortableArtifactFilename("logs/command.stdout.log")).toBe(
      "logs/command.stdout.log",
    );
    for (const filename of [
      "/tmp/proof.log",
      "../proof.log",
      "logs\\proof.log",
      "logs//proof.log",
    ]) {
      expect(() => validatePortableArtifactFilename(filename)).toThrow(
        "not a portable relative path",
      );
    }
  });

  it("requires artifact output outside the repository without interpreting pathspec characters", () => {
    for (const name of ["proof*", "proof?", "proof[1]"]) {
      expect(() => validateExternalArtifactDirectory("/repo", `/repo/${name}`)).toThrow(
        "release artifact directory must be outside the invocation repository",
      );
      expect(() => validateExternalArtifactDirectory("/repo", `/outside/${name}`)).not.toThrow();
    }
  });

  it("root-binds the complete artifact set and candidate commit", () => {
    const artifacts = [
      buildArtifactEvidence("logs/command.stderr.log", ""),
      buildArtifactEvidence("profiles/1x.json", "{}\n"),
    ];
    const candidate = "afeec3b9c15fb2350dcc9dc34c72d1d60e9b69cf";
    const root = buildArtifactRoot(artifacts, candidate);

    expect(root).toMatchObject({
      algorithm: "sha256",
      artifactCount: 2,
      candidateCommit: candidate,
    });
    expect(root.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(buildArtifactRoot([...artifacts].reverse(), candidate)).toEqual(root);
    expect(buildArtifactRoot(artifacts, "356463239bb2e927766dae9239cb98703cf5ab05")).not.toEqual(
      root,
    );
    expect(
      buildArtifactRoot([buildArtifactEvidence("profiles/1x.json", "tampered")], candidate),
    ).not.toEqual(root);
  });

  it("requires a complete passing isolated report with a post-write census", () => {
    const valid = validateProfileReport(validProfileReport("2x"), "2x");
    expect(valid.errors).toEqual([]);
    expect(valid.exactProfileCardinality).toBe(true);
    expect(valid.observedCardinality).toEqual(getScaleManifest("2x").counts);
    expect(valid.reportPassed).toBe(true);

    const inexact = JSON.parse(validProfileReport("4x"));
    inexact.fixture.exactProfileCardinality = false;
    inexact.fixture.counts.tracks -= 1;
    inexact.fixture.census.passed = false;
    inexact.fixture.census.mismatches = ["table perf_tracks mismatch"];
    inexact.fixture.census.tables.observed.perf_tracks -= 1;
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
        "profile 4x fixture census.passed is not true",
        "profile 4x fixture census reports mismatches",
        "profile 4x fixture census observed tables do not match expected",
      ]),
    );
    expect(validateProfileReport("not-json", "1x").errors[0]).toContain(
      "stdout is not one JSON document",
    );
  });

  it("rejects embedded or adjusted resource evidence for an exact release profile", () => {
    const embedded = JSON.parse(validProfileReport("2x"));
    embedded.database.isolation = "embedded-client-process";
    embedded.database.resourceScope = "benchmark-client-and-database-process";
    embedded.report.resources.sampleSource = "process.memoryUsage.fixture-baseline-adjusted";

    expect(validateProfileReport(JSON.stringify(embedded), "2x").errors).toEqual(
      expect.arrayContaining([
        "profile 2x database isolation is not local-sidecar-process",
        "profile 2x database resourceScope is not benchmark-client-process",
        `profile 2x resource sampleSource is not ${ISOLATED_LOCAL_LIBSQL_RESOURCE_SOURCE}`,
      ]),
    );
  });

  it("binds evidence to one clean candidate commit for the complete run", () => {
    const candidate = "afeec3b9c15fb2350dcc9dc34c72d1d60e9b69cf";
    const clean = {
      clean: true,
      commit: candidate,
      failure: null,
      indexHash: "index-a",
      treeHash: "tree-a",
    };

    expect(
      assessReleaseSourceEvidence({
        candidateCommit: candidate,
        candidateSelection: "explicit",
        completed: clean,
        started: clean,
      }),
    ).toMatchObject({
      actualCommit: candidate,
      candidateCommit: candidate,
      clean: true,
      failures: [],
      passed: true,
    });

    const dirtyAndChanged = assessReleaseSourceEvidence({
      candidateCommit: candidate,
      candidateSelection: "explicit",
      completed: {
        clean: true,
        commit: "356463239bb2e927766dae9239cb98703cf5ab05",
        failure: null,
        indexHash: "index-b",
        treeHash: "tree-b",
      },
      started: {
        clean: false,
        commit: candidate,
        failure: null,
        indexHash: "index-a",
        treeHash: "tree-a",
      },
    });
    expect(dirtyAndChanged.passed).toBe(false);
    expect(dirtyAndChanged.actualCommit).toBeNull();
    expect(dirtyAndChanged.failures).toEqual(
      expect.arrayContaining([
        "source tree is not clean at invocation",
        "source completion commit 356463239bb2e927766dae9239cb98703cf5ab05 does not match candidate afeec3b9c15fb2350dcc9dc34c72d1d60e9b69cf",
        "source commit changed during proof: afeec3b9c15fb2350dcc9dc34c72d1d60e9b69cf -> 356463239bb2e927766dae9239cb98703cf5ab05",
      ]),
    );
  });

  it("fails source binding when any command checkpoint sees dirty or changed source", () => {
    const candidate = "afeec3b9c15fb2350dcc9dc34c72d1d60e9b69cf";
    const clean = {
      clean: true,
      commit: candidate,
      failure: null,
      indexHash: "index-a",
      treeHash: "tree-a",
    };
    const evidence = assessReleaseSourceEvidence({
      candidateCommit: candidate,
      candidateSelection: "explicit",
      checkpoints: [
        {
          commandId: "sql-exact-2x",
          phase: "before-command",
          snapshot: { ...clean, clean: false, indexHash: "index-b" },
        },
      ],
      completed: clean,
      started: clean,
    });

    expect(evidence.clean).toBe(false);
    expect(evidence.passed).toBe(false);
    expect(evidence.failures).toEqual(
      expect.arrayContaining([
        "source before-command sql-exact-2x index hash changed during proof",
        "source tree is not clean at before-command sql-exact-2x",
      ]),
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
