import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  acquireLaunchLock,
  executionWaves,
  fingerprintWorktree,
  releaseLaunchLock,
  resultIsReusable,
  withoutGitEnvironment,
  workerIsActive,
} from "./preflight.mjs";

function git(root: string, ...args: string[]) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: withoutGitEnvironment(),
  });
  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
}

describe("preflight fingerprints", () => {
  test("tracked, staged, untracked, and config content invalidate a result", () => {
    const root = join(tmpdir(), `fluncle-preflight-${crypto.randomUUID()}`);
    mkdirSync(root, { recursive: true });
    git(root, "init", "-q");
    git(root, "config", "user.email", "test@example.invalid");
    git(root, "config", "user.name", "Preflight Test");
    writeFileSync(join(root, "tracked.txt"), "one\n");
    git(root, "add", "tracked.txt");
    git(root, "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");

    const clean = fingerprintWorktree(root).fingerprint;
    writeFileSync(join(root, "tracked.txt"), "two\n");
    const modified = fingerprintWorktree(root).fingerprint;
    git(root, "add", "tracked.txt");
    const staged = fingerprintWorktree(root).fingerprint;
    git(root, "-c", "commit.gpgsign=false", "commit", "-qm", "changed fixture");
    const committed = fingerprintWorktree(root).fingerprint;
    writeFileSync(join(root, "untracked.txt"), "config-a\n");
    const untracked = fingerprintWorktree(root).fingerprint;
    writeFileSync(join(root, "untracked.txt"), "config-b\n");
    const rewritten = fingerprintWorktree(root).fingerprint;

    expect(staged).toBe(modified);
    expect(committed).toBe(modified);
    expect(new Set([clean, modified, untracked, rewritten]).size).toBe(4);
  });
});

describe("preflight scheduling", () => {
  test("parallelizes light leaves without contending the resource-heavy suites", () => {
    const lanes = ["static", "packages", "scripts", "skills", "go-ssh", "e2e"];
    const waves = executionWaves(lanes);

    expect(waves).toEqual([["static", "skills", "go-ssh"], ["packages"], ["scripts"], ["e2e"]]);
    expect(waves.flat().sort((left, right) => left.localeCompare(right))).toEqual(
      [...lanes].sort((left, right) => left.localeCompare(right)),
    );
  });

  test("the commit join preserves the repository's absolute-PATH contract", () => {
    const hook = readFileSync(join(import.meta.dir, "../../.husky/pre-commit"), "utf8");

    expect(hook).toContain('PATH="$preflight_path" node scripts/quality/preflight.mjs join');
    expect(hook).not.toContain("bun run quality:preflight -- join");
  });

  test("a finished or dead worker is never reused for a new fingerprint", () => {
    const alive = () => true;

    expect(workerIsActive({ pid: 42, startedAt: "now" }, alive)).toBe(true);
    expect(workerIsActive({ finishedAt: "now", pid: 42 }, alive)).toBe(false);
    expect(workerIsActive({ pid: 42 }, () => false)).toBe(false);
  });

  test("an exact successful content result is reused instead of relaunched", () => {
    expect(resultIsReusable({ fingerprint: "same", outcome: "success" }, "same")).toBe(true);
    expect(resultIsReusable({ fingerprint: "same", outcome: "failure" }, "same")).toBe(false);
    expect(resultIsReusable({ fingerprint: "same", outcome: "running" }, "same")).toBe(false);
    expect(resultIsReusable({ fingerprint: "old", outcome: "success" }, "same")).toBe(false);
  });

  test("detached work ignores repository scope inherited from a Git hook", () => {
    const environment = withoutGitEnvironment({
      GIT_DIR: "/outer/repository",
      GIT_INDEX_FILE: "/outer/index",
      PATH: "/usr/bin",
    });

    expect(environment).toEqual({ PATH: "/usr/bin" });
  });

  test("concurrent hooks elect one launcher and can recover an abandoned lock", () => {
    const directory = join(tmpdir(), `fluncle-preflight-lock-${crypto.randomUUID()}`);
    mkdirSync(directory, { recursive: true });
    const clock = Date.now();

    const first = acquireLaunchLock(directory, { now: () => clock });
    expect(first).toBeString();
    expect(acquireLaunchLock(directory, { now: () => clock + 1 })).toBeNull();

    const recovered = acquireLaunchLock(directory, { now: () => clock + 31_000 });
    expect(recovered).toBeString();
    releaseLaunchLock(directory, first);
    expect(acquireLaunchLock(directory, { now: () => clock + 31_001 })).toBeNull();
    releaseLaunchLock(directory, recovered);
    expect(acquireLaunchLock(directory, { now: () => clock + 31_002 })).toBeString();

    rmSync(directory, { force: true, recursive: true });
  });
});
