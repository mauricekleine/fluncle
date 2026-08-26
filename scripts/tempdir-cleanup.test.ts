import { describe, expect, test } from "bun:test";

import { join } from "node:path";

import {
  findRepositoryTempDirCleanupViolations,
  findTempDirCleanupViolations,
} from "./tempdir-cleanup";

const REPO_ROOT = join(import.meta.dir, "..");

describe("temporary-directory source guard", () => {
  test("covers every repository test allocation with failure-safe cleanup", async () => {
    expect(await findRepositoryTempDirCleanupViolations(REPO_ROOT)).toEqual([]);
  });

  test("checks each allocation, not only whether the file has some cleanup", () => {
    const source = [
      'import { afterAll } from "bun:test";',
      'import { mkdtempSync, rmSync } from "node:fs";',
      'const first = mkdtempSync("first-");',
      'const second = mkdtempSync("second-");',
      "afterAll(() => {",
      "  rmSync(first, { force: true, recursive: true });",
      "});",
    ].join("\n");

    expect(findTempDirCleanupViolations(source, "synthetic.test.ts")).toEqual([
      {
        file: "synthetic.test.ts",
        line: 4,
        owner: "second",
        reason: "no failure-safe recursive cleanup for second",
      },
    ]);
  });

  test("does not reuse one direct cleanup for repeated allocations", () => {
    const source = [
      'import { afterAll } from "bun:test";',
      'import { mkdtempSync, rmSync } from "node:fs";',
      "let dir;",
      'dir = mkdtempSync("first-");',
      'dir = mkdtempSync("second-");',
      "afterAll(() => {",
      "  rmSync(dir, { force: true, recursive: true });",
      "});",
    ].join("\n");

    expect(findTempDirCleanupViolations(source, "reused-owner.test.ts")).toEqual([
      {
        file: "reused-owner.test.ts",
        line: 5,
        owner: "dir",
        reason: "no failure-safe recursive cleanup for dir",
      },
    ]);
  });

  test("does not reuse one registry push for repeated allocations", () => {
    const source = [
      'import { afterEach } from "bun:test";',
      'import { mkdtempSync, rmSync } from "node:fs";',
      "const temporaryDirectories = [];",
      "let dir;",
      'dir = mkdtempSync("first-");',
      'dir = mkdtempSync("second-");',
      "temporaryDirectories.push(dir);",
      "afterEach(() => {",
      "  for (const directory of temporaryDirectories.splice(0)) {",
      "    rmSync(directory, { force: true, recursive: true });",
      "  }",
      "});",
    ].join("\n");

    expect(findTempDirCleanupViolations(source, "reused-push.test.ts")).toEqual([
      {
        file: "reused-push.test.ts",
        line: 6,
        owner: "dir",
        reason: "no failure-safe recursive cleanup for dir",
      },
    ]);
  });

  test("rejects cleanup that runs only after the assertion path", () => {
    const source = [
      'import { mkdtempSync, rmSync } from "node:fs";',
      'const dir = mkdtempSync("tail-only-");',
      "expect(dir).toBeTruthy();",
      "rmSync(dir, { force: true, recursive: true });",
    ].join("\n");

    expect(findTempDirCleanupViolations(source, "tail-only.test.ts")).toEqual([
      {
        file: "tail-only.test.ts",
        line: 2,
        owner: "dir",
        reason: "no failure-safe recursive cleanup for dir",
      },
    ]);
  });
});
