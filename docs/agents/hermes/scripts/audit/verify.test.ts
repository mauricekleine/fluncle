// The box-sized verification ladder's contract: what it runs, what it refuses to run, and the
// record it leaves behind for the driver to fold into the run ledger.
//
// Every check command is a temp-PATH stub writing to a log file, and the cgroup accounting is a
// pair of fixture files, so the suite never runs a real lint, typecheck, or test and never reads
// the host's memory state.
//
//   bun test docs/agents/hermes/scripts/audit/verify.test.ts

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VERIFY = join(import.meta.dir, "verify.sh");
const MIB = 1_048_576;
const temporaryDirectories: string[] = [];

type Record = {
  failed: number;
  ran: number;
  skipped: number;
  steps: { reason: string; state: string; step: string }[];
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function executable(path: string, body: string): void {
  writeFileSync(path, body, "utf8");
  chmodSync(path, 0o755);
}

function git(cwd: string, ...args: string[]): void {
  // The fixture repo must be independent of whatever the developer's own git config does — no
  // signing key, no hook path, no template dir.
  const result = spawnSync(
    "git",
    ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=", ...args],
    {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_AUTHOR_NAME: "fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "fixture",
      },
      stdio: "ignore",
    },
  );
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in the fixture repo`);
  }
}

type Box = {
  bin: string;
  calls: () => string[];
  cgroupCurrentBytes: (value: number) => void;
  repo: string;
  run: (extraEnv?: Record_Env) => { record: Record; status: number };
};
type Record_Env = Readonly<{ [key: string]: string }>;

function box(options: { stubExitCode?: number; stubSleepSeconds?: number } = {}): Box {
  const root = mkdtempSync(join(tmpdir(), "fluncle-audit-verify-"));
  temporaryDirectories.push(root);
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  mkdirSync(repo, { recursive: true });
  mkdirSync(bin, { recursive: true });

  git(repo, "init", "--quiet", "--initial-branch=main");
  writeFileSync(join(repo, "README.md"), "fixture\n", "utf8");
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", "fixture");

  const callLog = join(root, "calls.log");
  writeFileSync(callLog, "", "utf8");
  // One stub stands in for every check command. It records the invocation, then obeys the
  // fixture's chosen exit code and delay.
  const stub = `#!/usr/bin/env bash
printf '%s %s\\n' "$(basename "$0")" "$*" >>"${callLog}"
sleep ${options.stubSleepSeconds ?? 0}
exit ${options.stubExitCode ?? 0}
`;
  executable(join(bin, "bun"), stub);
  executable(join(bin, "bunx"), stub);

  const cgroupMax = join(root, "memory.max");
  const cgroupCurrent = join(root, "memory.current");
  writeFileSync(cgroupMax, `${6 * 1024 * MIB}\n`, "utf8");
  writeFileSync(cgroupCurrent, "0\n", "utf8");

  return {
    bin,
    calls: () => readFileSync(callLog, "utf8").split("\n").filter(Boolean),
    cgroupCurrentBytes: (value) => writeFileSync(cgroupCurrent, `${value}\n`, "utf8"),
    repo,
    run: (extraEnv = {}) => {
      const result = spawnSync("bash", [VERIFY], {
        cwd: repo,
        encoding: "utf8",
        env: {
          ...process.env,
          AUDIT_VERIFY_CGROUP_CURRENT: cgroupCurrent,
          AUDIT_VERIFY_CGROUP_MAX: cgroupMax,
          PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
          ...extraEnv,
        },
      });
      const output = join(repo, ".audit", "verify.json");
      if (!existsSync(output)) {
        throw new Error(`verify.sh wrote no record; stderr=${result.stderr}`);
      }
      return {
        record: JSON.parse(readFileSync(output, "utf8")) as Record,
        status: result.status ?? -1,
      };
    },
  };
}

describe("the audit verification ladder", () => {
  test("a night that changed nothing records the fact instead of running checks", () => {
    const fixture = box();
    const { record, status } = fixture.run();

    expect(status).toBe(0);
    expect(record).toMatchObject({ failed: 0, ran: 0, skipped: 1 });
    expect(record.steps[0]).toMatchObject({ reason: "no-changed-paths", state: "skipped" });
    expect(fixture.calls()).toEqual([]);
  });

  test("formatting and the lint rules run scoped to the changed paths, never the whole repo", () => {
    const fixture = box();
    writeFileSync(join(fixture.repo, "touched.ts"), "export const a = 1;\n", "utf8");

    const { record, status } = fixture.run();

    expect(status).toBe(0);
    expect(record).toMatchObject({ failed: 0, ran: 2 });
    const calls = fixture.calls();
    expect(calls).toContain("bunx oxfmt --check touched.ts");
    expect(calls).toContain("bunx oxlint touched.ts");
    // The whole-repo forms are what the box cannot afford; none of them may appear.
    expect(calls.some((call) => /^bunx oxlint$/.test(call))).toBe(false);
    expect(calls.some((call) => call.includes("run check"))).toBe(false);
    expect(calls.some((call) => call.endsWith("typecheck") && !call.includes("--cwd"))).toBe(false);
  });

  test("a changed package brings its own typecheck and tests, and only its own", () => {
    const fixture = box();
    mkdirSync(join(fixture.repo, "apps", "cli"), { recursive: true });
    writeFileSync(
      join(fixture.repo, "apps", "cli", "package.json"),
      JSON.stringify({ name: "cli", scripts: { test: "x", typecheck: "y" } }),
      "utf8",
    );
    writeFileSync(join(fixture.repo, "apps", "cli", "index.ts"), "export const a = 1;\n", "utf8");

    const { record } = fixture.run();

    expect(record.steps.map((step) => step.step)).toEqual([
      "format",
      "lint",
      "typecheck:apps/cli",
      "test:apps/cli",
    ]);
    expect(fixture.calls()).toContain("bun run --cwd apps/cli typecheck");
  });

  test("a package whose whole-program pass does not fit the box is left to CI", () => {
    const fixture = box();
    mkdirSync(join(fixture.repo, "apps", "web"), { recursive: true });
    writeFileSync(
      join(fixture.repo, "apps", "web", "package.json"),
      JSON.stringify({ name: "web", scripts: { test: "x", typecheck: "y" } }),
      "utf8",
    );
    writeFileSync(join(fixture.repo, "apps", "web", "index.ts"), "export const a = 1;\n", "utf8");

    const { record, status } = fixture.run();

    expect(status).toBe(0);
    expect(record.steps).toContainEqual({
      reason: "ci-only",
      state: "skipped",
      step: "typecheck:apps/web",
    });
    expect(fixture.calls().some((call) => call.includes("apps/web typecheck"))).toBe(false);
  });

  test("a step with no memory headroom is skipped rather than started into an OOM kill", () => {
    const fixture = box();
    writeFileSync(join(fixture.repo, "touched.ts"), "export const a = 1;\n", "utf8");
    // Leaves well under the lint step's headroom requirement, and under the format step's too.
    fixture.cgroupCurrentBytes(6 * 1024 * MIB - 64 * MIB);

    const { record } = fixture.run();

    expect(record.steps).toContainEqual({ reason: "no-headroom", state: "skipped", step: "lint" });
    expect(fixture.calls().some((call) => call.startsWith("bunx oxlint"))).toBe(false);
  });

  test("a failing check fails the ladder so the driver can call the branch red", () => {
    const fixture = box({ stubExitCode: 2 });
    writeFileSync(join(fixture.repo, "touched.ts"), "export const a = 1;\n", "utf8");

    const { record, status } = fixture.run();

    expect(status).not.toBe(0);
    expect(record.failed).toBeGreaterThan(0);
    expect(record.steps[0]).toMatchObject({ reason: "exit-2", state: "failed", step: "format" });
  });

  test("a wedged check costs one step, never the night", () => {
    const fixture = box({ stubSleepSeconds: 30 });
    writeFileSync(join(fixture.repo, "touched.ts"), "export const a = 1;\n", "utf8");

    const { record } = fixture.run({ AUDIT_VERIFY_STEP_BUDGET_SECS: "1" });

    expect(record.steps[0]).toMatchObject({ reason: "budget-exceeded", state: "failed" });
  }, 60_000);
});
