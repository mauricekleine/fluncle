import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const source = resolve(import.meta.dir, "../..");
const otherCheckouts: string[] = [];

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
  return result.stdout.trim();
}

function otherCheckout() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fluncle-build-commit-")));
  otherCheckouts.push(root);
  git(root, "init", "-b", "main");
  writeFileSync(join(root, "README.md"), "another repository\n");
  git(root, "add", ".");
  git(
    root,
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "user.name=Fixture",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "fixture",
  );
  return root;
}

function buildCommitFrom(cwd: string, workersBuildsValue: string) {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `import("${join(source, "scripts/quality/build-commit.ts")}").then((module) => process.stdout.write(module.buildCommitSha()))`,
    ],
    { cwd, encoding: "utf8", env: { ...process.env, WORKERS_CI_COMMIT_SHA: workersBuildsValue } },
  );
  expect(result.status).toBe(0);
  return result.stdout;
}

afterEach(() => {
  for (const root of otherCheckouts.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a branch name resolves the commit of the repository being built, not the caller's checkout", () => {
  const caller = otherCheckout();
  const resolved = buildCommitFrom(caller, "main");
  expect(resolved).toBe(git(source, "rev-parse", "HEAD"));
  expect(resolved).not.toBe(git(caller, "rev-parse", "HEAD"));
});

test("a full commit SHA from Workers Builds is stamped as given", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  expect(buildCommitFrom(otherCheckout(), sha)).toBe(sha);
});
