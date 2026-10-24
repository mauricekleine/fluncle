import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { classifyPaths, readPackageGraph, repositoryRoot } from "./classifier.mjs";
import { commandsForLane } from "./run-lane.mjs";

const root = repositoryRoot();
const testPath = /(?:[._](?:test|spec))\.[cm]?[jt]sx?$/;
const javascriptPath = /\.[cm]?[jt]sx?$/;

function git(...args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout;
}

function list(text) {
  return text.split("\0").filter(Boolean);
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function treeState() {
  const untracked = list(git("ls-files", "--others", "--exclude-standard", "-z"));
  const contents = untracked.map((path) => {
    const file = join(root, path);
    return [
      path,
      lstatSync(file).mode,
      hash(lstatSync(file).isSymbolicLink() ? readlinkSync(file) : readFileSync(file)),
    ];
  });
  const staged = hash(git("diff", "--cached", "--binary", "HEAD", "--"));
  const unstaged = hash(git("diff", "--binary", "--"));
  const status = git("status", "--porcelain=v1", "-z", "--untracked-files=all");
  const commit = git("rev-parse", "HEAD").trim();
  return {
    commit,
    fingerprint: hash(JSON.stringify([commit, staged, unstaged, contents])),
    headTree: git("rev-parse", "HEAD^{tree}").trim(),
    staged,
    status: list(status),
    unstaged,
    untracked: contents,
  };
}

function selectedPaths(args) {
  const paths = [];
  for (const argument of args) {
    const path = relative(root, resolve(root, argument));
    if (path === ".." || path.startsWith("../")) {
      throw new Error(`Path must be inside the repository: ${argument}`);
    }
    const files = list(
      git("ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", path || "."),
    );
    if (files.length === 0) {
      throw new Error(`No tracked or unignored files match: ${argument}`);
    }
    paths.push(...files);
  }
  return [...new Set(paths)].sort((left, right) => left.localeCompare(right));
}

function step(lane, program, args, cwd = ".", options = {}) {
  return { args, cwd, lane, options, program };
}

function leafSteps(plan, lane) {
  return commandsForLane(plan, lane).map((command) =>
    step(lane, command.program, command.args, ".", command.options),
  );
}

function scriptTestRoots() {
  const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;
  return [scripts["test:scripts:worker"], scripts["test:scripts:box"]].flatMap((script) => {
    if (!script) {
      return [];
    }
    return script.split(" && ").map((command) => {
      const match = /^bun test --cwd ([\w./-]+)$/.exec(command);
      if (!match) {
        throw new Error(`Unsupported script test command: ${command}`);
      }
      return match[1];
    });
  });
}

function bunTests(cwd, paths, changed, all) {
  const own = paths.filter((path) => path.startsWith(`${cwd}/`));
  const exact =
    !all &&
    own.length > 0 &&
    paths.every((path) => testPath.test(path) && existsSync(join(root, path)));
  const filters = exact ? own.map((path) => `./${relative(cwd, path)}`) : [];
  const needsBackstop =
    all ||
    paths.some(
      (path) =>
        !javascriptPath.test(path) || !existsSync(join(root, path)) || !changed.includes(path),
    );
  return step(
    `test:${cwd}`,
    "bun",
    [
      "test",
      "--bail=1",
      "--pass-with-no-tests",
      ...(!exact && !needsBackstop ? ["--changed=origin/main"] : []),
      ...filters,
    ],
    cwd,
  );
}

function webTests(paths, changed, all) {
  const cwd = "apps/web";
  const own = paths.filter((path) => path.startsWith(`${cwd}/`));
  const exact =
    !all &&
    own.length > 0 &&
    paths.every((path) => testPath.test(path) && existsSync(join(root, path)));
  const backstop =
    all || paths.some((path) => !javascriptPath.test(path) || !existsSync(join(root, path)));
  if (exact || backstop || paths.every((path) => changed.includes(path))) {
    return step(
      "test:apps/web",
      "bun",
      [
        "run",
        "test",
        "--bail=1",
        "--passWithNoTests",
        ...(backstop
          ? []
          : exact
            ? own.map((path) => `./${relative(cwd, path)}`)
            : ["--changed=origin/main"]),
      ],
      cwd,
    );
  }
  return step(
    "test:apps/web",
    "node",
    [
      "../../node_modules/vitest/vitest.mjs",
      "related",
      "--run",
      "--coverage.enabled=false",
      "--bail=1",
      "--passWithNoTests",
      ...paths.map((path) => relative(cwd, path)),
    ],
    cwd,
  );
}

function toolPaths(script, paths, flags = []) {
  if (paths.length === 0) {
    return [];
  }
  const result = spawnSync(
    "bun",
    ["run", script, "--list-files", "--no-error-on-unmatched-pattern", ...flags, ...paths],
    { cwd: root, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`Could not select ${script} files: ${result.stderr || result.error?.message}`);
  }
  const selected = new Set(
    result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((path) => relative(root, resolve(root, path))),
  );
  return paths.filter((path) => selected.has(path));
}

function focusedSteps(plan, changed) {
  const paths = plan.changedFiles;
  const live = paths.filter((path) => existsSync(join(root, path)));
  const steps = [];
  const formatted = toolPaths("format:check", live, ["--ignore-unknown"]);
  if (formatted.length > 0) {
    steps.push(step("format", "bun", ["run", "format:check", ...formatted]));
  }
  const js = toolPaths(
    "lint",
    live.filter((path) => javascriptPath.test(path)),
  );
  if (js.length > 0) {
    steps.push(step("lint", "bun", ["run", "lint", ...js]));
  }
  const packages = readPackageGraph(root);
  const owners = [...packages.values()].filter((pkg) => plan.packages.includes(pkg.name));
  const native = ["go-ssh", "go-dns", "sonar"].flatMap((lane) => leafSteps(plan, lane));
  steps.push(
    ...native.filter(
      (command) => !command.args.includes("test") && !command.args.includes("build"),
    ),
  );
  if (owners.length > 0) {
    steps.push(step("workspace", "node", ["scripts/quality/workspace-install.mjs"]));
  }
  for (const pkg of owners) {
    const manifest = JSON.parse(readFileSync(join(root, pkg.path, "package.json"), "utf8"));
    if (manifest.scripts?.typecheck) {
      steps.push(step(`typecheck:${pkg.path}`, "bun", ["run", "typecheck"], pkg.path));
    }
  }
  steps.push(...native.filter((command) => command.args.includes("build")));
  for (const pkg of owners) {
    const manifest = JSON.parse(readFileSync(join(root, pkg.path, "package.json"), "utf8"));
    if (!manifest.scripts?.test) {
      continue;
    }
    if (pkg.path === "apps/web") {
      steps.push(webTests(paths, changed, plan.full));
    } else if (manifest.scripts.test === "bun test") {
      steps.push(bunTests(pkg.path, paths, changed, plan.full));
    } else {
      throw new Error(`Unsupported test runner in ${pkg.path}: ${manifest.scripts.test}`);
    }
  }
  if (plan.lanes.scripts) {
    const roots = scriptTestRoots();
    const hasOwner = roots.some((cwd) => paths.some((path) => path.startsWith(`${cwd}/`)));
    for (const cwd of roots) {
      const own = paths.some((path) => path.startsWith(`${cwd}/`));
      if (own || plan.full || !hasOwner) {
        steps.push(bunTests(cwd, paths, changed, plan.full));
      }
    }
  }
  steps.push(...native.filter((command) => command.args.includes("test")));
  steps.push(...leafSteps(plan, "label-triage-python"));
  if (plan.lanes.workflows && !plan.lanes.scripts) {
    steps.push(...leafSteps(plan, "workflows"));
  }
  return steps;
}

function bunTestConfig(command, logPath) {
  const cwd = resolve(root, command.cwd);
  let config = {};
  for (const directory of new Set([root, cwd])) {
    const path = join(directory, "bunfig.toml");
    if (existsSync(path)) {
      const local = Bun.TOML.parse(readFileSync(path, "utf8"));
      config = { ...config, ...local, test: { ...config.test, ...local.test } };
    }
  }
  const preloads = config.test?.preload ?? [];
  config.test = {
    ...config.test,
    coverage: false,
    preload: (Array.isArray(preloads) ? preloads : [preloads]).map((path) =>
      Bun.resolveSync(path, cwd),
    ),
    root: resolve(cwd, config.test?.root ?? "."),
  };
  const path = `${logPath}.bunfig.toml`;
  writeFileSync(path, Bun.TOML.stringify(config));
  return path;
}

function runStep(command, logPath, focused) {
  const log = openSync(logPath, "w");
  try {
    if (focused && command.program === "bun" && command.args[0] === "test") {
      command.args.splice(1, 0, `--config=${bunTestConfig(command, logPath)}`);
    }
    const result = spawnSync(command.program, command.args, {
      cwd: resolve(root, command.cwd),
      env: {
        ...process.env,
        ...(focused ? { FLUNCLE_VITEST_COVERAGE: "false" } : {}),
        WORKERS_CI_COMMIT_SHA: process.env.WORKERS_CI_COMMIT_SHA || git("rev-parse", "HEAD").trim(),
      },
      stdio: ["ignore", log, log],
    });
    if (result.error) {
      appendFileSync(logPath, `${result.error.message}\n`);
    }
    return {
      exitCode:
        result.status === 0 &&
        command.options.requireEmptyStdout &&
        readFileSync(logPath, "utf8").trim()
          ? 1
          : (result.status ?? 1),
      signal: result.signal,
    };
  } catch (error) {
    appendFileSync(logPath, `${error instanceof Error ? error.message : String(error)}\n`);
    return { exitCode: 1, signal: null };
  } finally {
    closeSync(log);
  }
}

function main() {
  const args = process.argv.slice(2).filter((argument) => argument !== "--");
  if (args.includes("--help")) {
    process.stdout.write(
      "Usage: bun run verify [paths...] | --full\nFocused defaults to origin/main plus staged, unstaged and untracked changes.\n",
    );
    return 0;
  }
  const full = args.includes("--full");
  if (
    (full && args.length !== 1) ||
    args.some((argument) => argument.startsWith("-") && argument !== "--full")
  ) {
    throw new Error("Usage: bun run verify [paths...] | --full");
  }
  const directory = join(root, ".turbo", "verify");
  mkdirSync(directory, { recursive: true });
  const runDirectory = mkdtempSync(join(directory, "run-"));
  const receiptPath = join(runDirectory, "receipt.json");
  const receipt = {
    firstFailure: null,
    lanes: [],
    logPath: null,
    mode: full ? "full" : "focused",
    startedAt: new Date().toISOString(),
    status: "running",
    version: 1,
  };
  let exitCode = 1;
  try {
    receipt.tree = treeState();
    receipt.commit = receipt.tree.commit;
    let commands;
    if (full) {
      commands = [step("check", "bun", ["run", "check"])];
    } else {
      const base = git("merge-base", "origin/main", "HEAD").trim();
      const changed = [
        ...new Set([
          ...list(git("diff", "--no-renames", "--name-only", "-z", base, "--")),
          ...list(git("ls-files", "--others", "--exclude-standard", "-z")),
        ]),
      ];
      receipt.base = base;
      receipt.plan = classifyPaths(args.length > 0 ? selectedPaths(args) : changed, {
        base,
        emptyChangeSet: "pass",
        head: receipt.commit,
      });
      commands = focusedSteps(receipt.plan, changed);
    }
    receipt.plannedLanes = commands.map((command) => command.lane);
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    exitCode = 0;
    for (const [index, command] of commands.entries()) {
      const logPath = join(runDirectory, `${String(index + 1).padStart(2, "0")}.log`);
      process.stdout.write(`verify: ${command.lane}\n`);
      const started = Date.now();
      receipt.currentLane = { ...command, logPath };
      receipt.logPath = logPath;
      writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
      const result = runStep(command, logPath, !full);
      const lane = { ...command, ...result, durationMs: Date.now() - started, logPath };
      delete receipt.currentLane;
      receipt.lanes.push(lane);
      receipt.logPath = logPath;
      writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
      if (result.exitCode !== 0) {
        receipt.firstFailure = lane;
        exitCode = result.exitCode;
        break;
      }
    }
    receipt.finishedTree = treeState();
    receipt.changedDuringRun = receipt.tree.fingerprint !== receipt.finishedTree.fingerprint;
  } catch (error) {
    const logPath = join(runDirectory, "setup.log");
    const message = error instanceof Error ? error.message : String(error);
    writeFileSync(logPath, `${message}\n`);
    receipt.firstFailure = { command: "verify setup", error: message, exitCode: 1, logPath };
    receipt.logPath = logPath;
    process.stderr.write(`verify: ${message}\n`);
    exitCode = 1;
  }
  receipt.status = exitCode === 0 ? "passed" : "failed";
  receipt.exitCode = exitCode;
  receipt.finishedAt = new Date().toISOString();
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(
    `verify: ${receipt.status}; lanes: ${receipt.lanes.map((lane) => lane.lane).join(", ") || "none"}\n`,
  );
  if (receipt.firstFailure) {
    const failure = receipt.firstFailure;
    process.stderr.write(
      `verify: first failure: ${failure.cwd ?? "."}: ${failure.program ?? failure.command} ${(failure.args ?? []).join(" ")} (exit ${failure.exitCode})\n`,
    );
  }
  if (receipt.changedDuringRun) {
    process.stderr.write(
      "verify: tree changed during the run; receipt does not verify the finished tree\n",
    );
  }
  process.stdout.write(
    `verify: log: ${receipt.logPath ?? "none"}\nverify: receipt: ${receiptPath}\n`,
  );
  return exitCode;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`verify: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
