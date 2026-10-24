import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const fixtures: string[] = [];
const source = resolve(import.meta.dir, "../..");

function write(root: string, path: string, contents: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), contents);
}

function git(root: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
  return result.stdout.trim();
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fluncle-verify-")));
  fixtures.push(root);
  for (const file of ["verify.mjs", "classifier.mjs", "run-lane.mjs", "deploy-watch-paths.json"]) {
    const target = join(root, "scripts/quality", file);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(source, "scripts/quality", file), target);
  }
  write(root, "scripts/quality/workspace-install.mjs", "process.exitCode = 0;\n");
  cpSync(join(source, ".oxfmtrc.json"), join(root, ".oxfmtrc.json"));
  cpSync(join(source, ".prettierignore"), join(root, ".prettierignore"));
  write(
    root,
    ".oxlintrc.json",
    JSON.stringify({
      ignorePatterns: JSON.parse(readFileSync(join(source, ".oxlintrc.json"), "utf8"))
        .ignorePatterns,
    }),
  );
  write(root, ".gitignore", ".turbo/\nbin/\n");
  write(root, "package.json", JSON.stringify({ scripts: {}, workspaces: ["apps/*"] }));
  for (const app of ["cli", "web"]) {
    write(
      root,
      `apps/${app}/package.json`,
      JSON.stringify({
        name: `@fluncle/${app}`,
        scripts: {
          test: app === "web" ? "bun run scripts/test.ts" : "bun test",
          typecheck: "bun --check",
        },
      }),
    );
    write(root, `apps/${app}/src/value.ts`, "export const value = 1;\n");
    write(root, `apps/${app}/src/value.test.ts`, 'import { value } from "./value";\n');
  }
  write(
    root,
    "bin/bun",
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const stage = args[0] === "test" ? "test" : args[1];
const root = process.env.FIXTURE_ROOT;
if (["format:check", "lint"].includes(stage) && (args.includes("--list-files") || fs.existsSync(path.join(root, ".turbo/real-static")))) {
  const argv = stage === "format:check"
    ? ["fmt", "--check", ...args.slice(2)]
    : [process.env.FIXTURE_LINT_SCRIPT, "lint", "--no-script", ...args.slice(2)];
  const result = require("node:child_process").spawnSync(process.env.FIXTURE_BUN, argv, { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
if (stage === "format:check" && args.slice(2).some(file => fs.readFileSync(file, "utf8").includes("BAD_FORMAT"))) {
  console.error("format sentinel"); process.exit(17);
}
if (stage === "typecheck" && fs.existsSync(path.join(process.cwd(), "FAIL_TYPECHECK"))) {
  console.error("type sentinel"); process.exit(19);
}
if (stage === "test" && fs.existsSync(path.join(root, ".turbo/real-bun"))) {
  const result = require("node:child_process").spawnSync(fs.readFileSync(path.join(root, ".turbo/real-bun"), "utf8"), args, { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
if (stage === "test") {
  if (!process.cwd().startsWith(path.join(root, "apps"))) process.exit(31);
  if (process.env.FLUNCLE_VITEST_COVERAGE !== "false") process.exit(32);
  if (!args.includes("--bail=1")) process.exit(33);
}
fs.appendFileSync(path.join(root, ".turbo", "events"), stage + "\\n");
console.log(stage === "check" ? "coverage=" + process.env.FLUNCLE_VITEST_COVERAGE : "fixture passed");
`,
  );
  spawnSync("chmod", ["+x", join(root, "bin/bun")]);
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "user.name", "Fixture");
  git(root, "add", ".");
  git(root, "-c", "commit.gpgsign=false", "commit", "-m", "fixture");
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  return root;
}

function verify(root: string, ...args: string[]) {
  const result = spawnSync(process.execPath, ["scripts/quality/verify.mjs", ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      FIXTURE_BUN: process.execPath,
      FIXTURE_LINT_SCRIPT: join(source, "scripts/bun-canary.ts"),
      FIXTURE_ROOT: root,
      FLUNCLE_VITEST_COVERAGE: "true",
      PATH: `${root}/bin:${process.env.PATH}`,
    },
  });
  const receiptPath = /verify: receipt: (.+)/.exec(result.stdout)?.[1];
  if (!receiptPath) {
    throw new Error(result.stdout + result.stderr);
  }
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  return { output: result.stdout + result.stderr, receipt, status: result.status };
}

afterEach(() => {
  for (const root of fixtures.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

test("an explicit Bun test runs in its package after cheap checks and typecheck", () => {
  const root = fixture();
  const { receipt, status } = verify(root, "apps/cli/src/value.test.ts");
  expect(status).toBe(0);
  expect(receipt.lanes.map((lane: { lane: string }) => lane.lane)).toEqual([
    "format",
    "lint",
    "workspace",
    "typecheck:apps/cli",
    "test:apps/cli",
  ]);
  expect(receipt.firstFailure).toBeNull();
  expect(receipt.changedDuringRun).toBe(false);
  expect(receipt.commit).toBe(git(root, "rev-parse", "HEAD"));
  expect(receipt.tree.fingerprint).toMatch(/^[a-f0-9]{64}$/);
});

test("an explicit web test reaches the coverage-free package runner", () => {
  const { receipt, status } = verify(fixture(), "apps/web/src/value.test.ts");
  expect(status).toBe(0);
  expect(readFileSync(receipt.logPath, "utf8")).toContain("fixture passed");
  expect(receipt.lanes.at(-1).lane).toBe("test:apps/web");
});

for (const [label, path, content, owner] of [
  ["Go", "apps/ssh/main.go", "package main\n", "go-ssh"],
  ["Rust", "apps/sonar/src/main.rs", "fn main() {}\n", "sonar"],
  [
    "Python",
    "packages/skills/fluncle-label-triage/scripts/helper.py",
    "value = 1\n",
    "label-triage-python",
  ],
  ["Raycast", "apps/raycast/src/example.ts", "export const value = 1;\n", "lint:apps/raycast"],
  [
    "ignored skills",
    ".agents/skills/fluncle-example/scripts/helper.ts",
    "export const value = 1;\n",
    null,
  ],
] as const) {
  test(`${label}-only paths reach their owner without a mismatched formatter`, () => {
    const root = fixture();
    write(root, ".turbo/real-static", "enabled");
    write(root, path, content);
    if (label === "Raycast") {
      write(
        root,
        "apps/raycast/package.json",
        JSON.stringify({
          name: "@fluncle/raycast",
          scripts: { lint: "ray lint" },
        }),
      );
    }
    for (const program of ["go", "gofmt", "cargo"]) {
      write(root, `bin/${program}`, "#!/usr/bin/env node\nprocess.exitCode = 0;\n");
      spawnSync("chmod", ["+x", join(root, "bin", program)]);
    }
    const { output, receipt, status } = verify(root, path);
    expect(status, output + JSON.stringify(receipt.firstFailure)).toBe(0);
    const lanes = receipt.lanes.map((lane: { lane: string }) => lane.lane);
    expect(lanes).not.toContain("format");
    if (label !== "Raycast") {
      expect(lanes).not.toContain("lint");
    }
    if (owner) {
      expect(lanes).toContain(owner);
    }
  });
}

test("default selection excludes commits added only to origin/main", () => {
  const root = fixture();
  const branch = git(root, "branch", "--show-current");
  git(root, "switch", "-c", "upstream");
  write(root, "apps/web/src/upstream.ts", "export const upstream = 1;\n");
  git(root, "add", ".");
  git(root, "-c", "commit.gpgsign=false", "commit", "-m", "upstream change");
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(root, "switch", branch);
  write(root, "apps/cli/src/value.ts", "export const value = 2;\n");
  const { receipt, status } = verify(root);
  expect(status).toBe(0);
  expect(receipt.plan.changedFiles).toEqual(["apps/cli/src/value.ts"]);
  expect(receipt.base).toBe(git(root, "merge-base", "origin/main", "HEAD"));
});

test("the default comparison includes committed, staged, unstaged, untracked and deleted paths", () => {
  const root = fixture();
  write(root, "apps/cli/src/committed.ts", "export {};\n");
  git(root, "add", ".");
  git(root, "-c", "commit.gpgsign=false", "commit", "-m", "change");
  write(root, "apps/cli/src/staged.ts", "export {};\n");
  git(root, "add", ".");
  write(root, "apps/cli/src/untracked.ts", "export {};\n");
  write(root, "apps/cli/src/value.ts", "export const value = 2;\n");
  rmSync(join(root, "apps/cli/src/value.test.ts"));
  const { receipt, status } = verify(root);
  expect(status).toBe(0);
  expect(receipt.plan.changedFiles).toEqual([
    "apps/cli/src/committed.ts",
    "apps/cli/src/staged.ts",
    "apps/cli/src/untracked.ts",
    "apps/cli/src/value.test.ts",
    "apps/cli/src/value.ts",
  ]);
  expect(receipt.tree.status.length).toBeGreaterThan(0);
  expect(receipt.lanes.at(-1).args).not.toContain("--changed=origin/main");
});

test("format failure stops before lint, types and tests and keeps the diagnostic", () => {
  const root = fixture();
  write(root, "apps/cli/src/value.ts", "BAD_FORMAT\n");
  const { output, receipt, status } = verify(root);
  expect(status).toBe(17);
  expect(receipt.lanes).toHaveLength(1);
  expect(receipt.firstFailure.lane).toBe("format");
  expect(readFileSync(receipt.firstFailure.logPath, "utf8")).toContain("format sentinel");
  expect(output).toContain("first failure");
  expect(output).toContain(receipt.firstFailure.logPath);
});

test("typecheck failure prevents tests", () => {
  const root = fixture();
  write(root, "apps/cli/FAIL_TYPECHECK", "");
  const { receipt, status } = verify(root, "apps/cli/src/value.test.ts");
  expect(status).toBe(19);
  expect(receipt.firstFailure.lane).toBe("typecheck:apps/cli");
  expect(readFileSync(join(root, ".turbo/events"), "utf8")).not.toContain("test\n");
});

test("full mode delegates check with its original coverage environment and no comparison ref", () => {
  const root = fixture();
  git(root, "update-ref", "-d", "refs/remotes/origin/main");
  const { receipt, status } = verify(root, "--full");
  expect(status).toBe(0);
  expect(receipt.lanes).toHaveLength(1);
  expect(receipt.lanes[0].lane).toBe("check");
  expect(readFileSync(receipt.logPath, "utf8")).toContain("coverage=true");
});

test("a clean comparison passes without launching commands", () => {
  const { receipt, status } = verify(fixture());
  expect(status).toBe(0);
  expect(receipt.lanes).toEqual([]);
  expect(receipt.plan.full).toBe(false);
});

test("a missing comparison base fails with a durable setup receipt", () => {
  const root = fixture();
  git(root, "update-ref", "-d", "refs/remotes/origin/main");
  const { receipt, status } = verify(root);
  expect(status).toBe(1);
  expect(receipt.status).toBe("failed");
  expect(receipt.firstFailure.command).toBe("verify setup");
  expect(existsSync(receipt.firstFailure.logPath)).toBe(true);
});

test("real Bun executes passing and failing tests with the package root and preload and coverage disabled", () => {
  for (const failing of [false, true]) {
    const root = fixture();
    write(root, ".turbo/real-bun", process.execPath);
    write(
      root,
      "apps/cli/bunfig.toml",
      '[test]\nroot = "./spec"\npreload = ["./preload.ts"]\ncoverage = true\ncoverageThreshold = 1\n',
    );
    write(root, "apps/cli/preload.ts", 'globalThis.preloaded = "armed";\n');
    write(
      root,
      "apps/cli/spec/coverage.test.ts",
      `import { expect, test } from "bun:test";
      test("preload is armed", () => expect(globalThis.preloaded).toBe("armed"));
      test("test body executes", () => expect(1).toBe(${failing ? 2 : 1}));
      test("bail stops later tests", () => { if (${failing}) throw new Error("BAIL_DID_NOT_STOP"); });
    `,
    );
    const { receipt, status } = verify(root, "apps/cli/spec/coverage.test.ts");
    const log = readFileSync(receipt.logPath, "utf8");
    expect(status).toBe(failing ? 1 : 0);
    expect(log).toContain(failing ? "1 fail" : "3 pass");
    expect(log).not.toContain("BAIL_DID_NOT_STOP");
    expect(log).not.toContain("% Lines");
  }
});

test("source edits use Bun's affected-file selector and untracked bytes change the fingerprint", () => {
  const root = fixture();
  write(root, "apps/cli/src/value.ts", "export const value = 2;\n");
  write(root, "apps/cli/src/new.ts", "export const added = 1;\n");
  const first = verify(root);
  expect(first.status).toBe(0);
  expect(first.receipt.lanes.at(-1).args).toContain("--changed=origin/main");
  write(root, "apps/cli/src/new.ts", "export const added = 2;\n");
  const second = verify(root);
  expect(second.receipt.tree.status).toEqual(first.receipt.tree.status);
  expect(second.receipt.tree.fingerprint).not.toBe(first.receipt.tree.fingerprint);
});

test("real Bun affected selection executes the test that imports a changed source", () => {
  const root = fixture();
  write(root, ".turbo/real-bun", process.execPath);
  write(
    root,
    "apps/cli/src/value.test.ts",
    'import { expect, test } from "bun:test";\nimport { value } from "./value";\ntest("affected source", () => expect(value).toBe(2));\n',
  );
  git(root, "add", ".");
  git(root, "-c", "commit.gpgsign=false", "commit", "-m", "test baseline");
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  write(root, "apps/cli/src/value.ts", "export const value = 2;\n");
  const passing = verify(root);
  expect(passing.status).toBe(0);
  expect(readFileSync(passing.receipt.logPath, "utf8")).toContain("1 pass");
  write(root, "apps/cli/src/value.ts", "export const value = 3;\n");
  const failing = verify(root);
  expect(failing.status).toBe(1);
  expect(readFileSync(failing.receipt.logPath, "utf8")).toContain("1 fail");
});
