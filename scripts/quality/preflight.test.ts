import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { repositoryRoot } from "./classifier.mjs";
import {
  acquireLaunchLock,
  changedPaths,
  comparisonBase,
  executionWaves,
  fingerprintWorktree,
  planForWorktree,
  reapProcessGroup,
  releaseLaunchLock,
  resultIsReusable,
  runSupervisedWave,
  waitForQuietPeriod,
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
    const lanes = ["static", "packages", "scripts", "go-ssh", "e2e"];
    const waves = executionWaves(lanes);

    expect(waves).toEqual([["static", "go-ssh"], ["packages"], ["scripts"], ["e2e"]]);
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

function fixtureRepository() {
  const root = join(tmpdir(), `fluncle-preflight-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Preflight Test");
  writeFileSync(join(root, "base.txt"), "base\n");
  git(root, "add", "base.txt");
  git(root, "-c", "commit.gpgsign=false", "commit", "-qm", "base");
  return root;
}

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("preflight change scope", () => {
  test("a committed branch is classified against its merge-base with origin/main", () => {
    const root = fixtureRepository();
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    expect(changedPaths(root)).toEqual([]);

    writeFileSync(join(root, "committed.txt"), "branch\n");
    git(root, "add", "committed.txt");
    git(root, "-c", "commit.gpgsign=false", "commit", "-qm", "branch work");
    writeFileSync(join(root, "untracked.txt"), "draft\n");

    expect(comparisonBase(root).source).toBe("merge-base");
    expect(changedPaths(root)).toEqual(["committed.txt", "untracked.txt"]);
    rmSync(root, { force: true, recursive: true });
  });

  test("without an origin/main ref the comparison falls back to HEAD", () => {
    const root = fixtureRepository();

    expect(comparisonBase(root)).toEqual({ ref: "HEAD", source: "HEAD" });
    rmSync(root, { force: true, recursive: true });
  });

  test("a tree identical to its merge-base selects no lanes locally", () => {
    const plan = planForWorktree(
      { base: { ref: "abc123", source: "merge-base" }, paths: [] },
      repositoryRoot(),
    );

    expect(plan.full).toBe(false);
    expect(plan.packages).toEqual([]);
    expect(Object.values(plan.lanes).some(Boolean)).toBe(false);
  });

  test("without a merge-base every local change set fails closed to the full matrix", () => {
    for (const paths of [[], ["docs/quality-system.md"]]) {
      const plan = planForWorktree(
        { base: { ref: "HEAD", source: "HEAD" }, paths },
        repositoryRoot(),
      );

      expect(plan.full).toBe(true);
      expect(plan.lanes.e2e).toBe(true);
      expect(plan.lanes.sonar).toBe(true);
    }
  });

  test("a changed comparison base invalidates a result for the same tree", () => {
    const root = fixtureRepository();
    const withoutBase = fingerprintWorktree(root).fingerprint;
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    const withBase = fingerprintWorktree(root).fingerprint;

    expect(withBase).not.toBe(withoutBase);
    rmSync(root, { force: true, recursive: true });
  });
});

describe("preflight edit settling", () => {
  test("the worker waits until the desired fingerprint has been quiet", async () => {
    let clock = 10_000;
    const slept: number[] = [];
    const desired = { fingerprint: "a", requestedAt: new Date(9_000).toISOString() };

    const settled = await waitForQuietPeriod(() => desired, {
      now: () => clock,
      quietMs: 4_000,
      sleep: async (milliseconds: number) => {
        slept.push(milliseconds);
        clock += milliseconds;
      },
    });

    expect(settled).toBe(desired);
    expect(slept).toEqual([3_000]);
  });

  test("a later edit restarts the quiet period", async () => {
    let clock = 0;
    let reads = 0;
    const slept: number[] = [];

    const settled = await waitForQuietPeriod(
      () => {
        reads += 1;
        return {
          fingerprint: reads === 1 ? "a" : "b",
          requestedAt: new Date(reads === 1 ? 0 : 2_000).toISOString(),
        };
      },
      {
        now: () => clock,
        quietMs: 4_000,
        sleep: async (milliseconds: number) => {
          slept.push(milliseconds);
          clock += milliseconds;
        },
      },
    );

    expect(settled?.fingerprint).toBe("b");
    expect(slept).toEqual([4_000, 2_000]);
  });
});

describe("preflight supersession", () => {
  test("a superseded wave terminates each lane's whole process group", async () => {
    const directory = join(tmpdir(), `fluncle-preflight-group-${crypto.randomUUID()}`);
    mkdirSync(directory, { recursive: true });
    const pidFile = join(directory, "grandchild.pid");
    let current = true;
    setTimeout(() => {
      current = false;
    }, 200);
    const started = Date.now();

    const outcome = await runSupervisedWave(["lane"], {
      graceMs: 500,
      isCurrent: () => current,
      pollMs: 20,
      start: () => {
        const child = spawn("sh", ["-c", `sleep 30 & echo $! > "${pidFile}"; wait`], {
          detached: true,
          stdio: "ignore",
        });
        const done = new Promise<number>((resolvePromise) => {
          child.on("exit", (code) => resolvePromise(code ?? 1));
        });
        return { child, done };
      },
    });

    expect(outcome.superseded).toBe(true);
    expect(outcome.results[0]).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(existsSync(pidFile)).toBe(true);
    const grandchild = Number(readFileSync(pidFile, "utf8").trim());
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    expect(processExists(grandchild)).toBe(false);
    rmSync(directory, { force: true, recursive: true });
  });

  test("a group that ignores the interrupt is killed after the grace period", async () => {
    const child = spawn("sh", ["-c", "trap '' INT; sleep 30 & wait"], {
      detached: true,
      stdio: "ignore",
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    const started = Date.now();

    await reapProcessGroup(child.pid ?? 0, { graceMs: 300, pollMs: 20 });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));

    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(processExists(-(child.pid ?? 0))).toBe(false);
  });

  test("a current wave runs to completion untouched", async () => {
    const outcome = await runSupervisedWave(["one", "two"], {
      isCurrent: () => true,
      pollMs: 20,
      start: (lane: string) => {
        const child = spawn("sh", ["-c", "exit 0"], { detached: true, stdio: "ignore" });
        const done = new Promise<string>((resolvePromise) => {
          child.on("exit", () => resolvePromise(lane));
        });
        return { child, done };
      },
    });

    expect(outcome).toEqual({ results: ["one", "two"], superseded: false });
  });
});
