import { describe, expect, it } from "vitest";

import { PERFORMANCE_CRITERION_CATEGORIES } from "./budgets";
import { getScaleManifest } from "./manifest";
import {
  aggregateNoGo,
  assessCategoryCompleteness,
  parseReleaseArguments,
  REQUIRED_RELEASE_CATEGORIES,
  type ChildResult,
  type ReleaseCommandResult,
  validateChildResult,
  validateProfileReport,
} from "./release";

function validProfileReport(profile: "1x" | "2x" | "4x"): string {
  return JSON.stringify({
    clientBounds: { local: 1 },
    environment: "local",
    fixture: {
      counts: getScaleManifest(profile).counts,
      exactProfileCardinality: true,
      profile,
      writeDurationMs: 1,
      written: { perf_tracks: getScaleManifest(profile).counts.tracks },
    },
    indexAudit: { passed: true },
    report: {
      contracts: [],
      criteria: Object.fromEntries(
        PERFORMANCE_CRITERION_CATEGORIES.map((category) => [
          category,
          { addressed: true, contractIds: [], passed: true, warnings: [] },
        ]),
      ),
      generatedAt: "2026-08-27T00:00:00.000Z",
      passed: true,
      profile,
      resources: {
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
