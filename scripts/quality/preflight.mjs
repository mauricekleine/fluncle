#!/usr/bin/env node
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyPaths, repositoryRoot } from "./classifier.mjs";

const LANES = [
  "static",
  "packages",
  "scripts",
  "skills",
  "go-ssh",
  "go-dns",
  "sonar",
  "workflows",
  "e2e",
];

const RESOURCE_HEAVY_LANES = new Set(["packages", "scripts", "e2e"]);

export function withoutGitEnvironment(environment = process.env) {
  const isolated = { ...environment };
  for (const name of Object.keys(isolated)) {
    if (name.startsWith("GIT_")) {
      delete isolated[name];
    }
  }
  return isolated;
}

export function executionWaves(lanes = LANES) {
  const light = lanes.filter((lane) => !RESOURCE_HEAVY_LANES.has(lane));
  const heavy = lanes.filter((lane) => RESOURCE_HEAVY_LANES.has(lane));
  return [light, ...heavy.map((lane) => [lane])].filter((wave) => wave.length > 0);
}

function gitWithEnvironment(root, extraEnvironment, ...args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...withoutGitEnvironment(), ...extraEnvironment },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout;
}

function git(root, ...args) {
  return gitWithEnvironment(root, {}, ...args);
}

function stateDirectory(root) {
  const gitDirectory = git(root, "rev-parse", "--absolute-git-dir").trim();
  return join(gitDirectory, "quality-preflight");
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

function readJson(path) {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function launchLockPath(directory) {
  return join(directory, "launch.lock");
}

export function acquireLaunchLock(
  directory,
  { now = () => Date.now(), staleAfterMs = 30_000 } = {},
) {
  mkdirSync(directory, { recursive: true });
  const path = launchLockPath(directory);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = randomUUID();
    let descriptor;
    try {
      descriptor = openSync(path, "wx");
      writeFileSync(descriptor, `${JSON.stringify({ startedAt: now(), token })}\n`);
      closeSync(descriptor);
      return token;
    } catch (error) {
      if (descriptor !== undefined) {
        closeSync(descriptor);
      }
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
        throw error;
      }

      const owner = readJson(path);
      let createdAt = typeof owner?.startedAt === "number" ? owner.startedAt : null;
      if (createdAt === null) {
        try {
          createdAt = statSync(path).mtimeMs;
        } catch {
          continue;
        }
      }
      if (now() - createdAt <= staleAfterMs) {
        return null;
      }
      try {
        unlinkSync(path);
      } catch {
        // Another hook recovered the same abandoned lock first; retry the atomic claim once.
      }
    }
  }

  return null;
}

export function releaseLaunchLock(directory, token) {
  if (!token) {
    return;
  }
  const path = launchLockPath(directory);
  if (readJson(path)?.token !== token) {
    return;
  }
  try {
    unlinkSync(path);
  } catch {
    // A vanished lock is already released.
  }
}

function changedPaths(root) {
  const tracked = git(root, "diff", "--name-only", "--diff-filter=ACDMRTUXB", "HEAD", "--")
    .trim()
    .split("\n")
    .filter(Boolean);
  const untracked = git(root, "ls-files", "--others", "--exclude-standard", "-z")
    .split("\0")
    .filter(Boolean);
  return [...new Set([...tracked, ...untracked])].sort((left, right) => left.localeCompare(right));
}

export function fingerprintWorktree(root = repositoryRoot()) {
  const hash = createHash("sha256");
  hash.update("quality-preflight-v1\0");
  hash.update(process.version);
  hash.update("\0");
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "fluncle-quality-tree-"));
  try {
    const environment = { GIT_INDEX_FILE: join(temporaryDirectory, "index") };
    gitWithEnvironment(root, environment, "read-tree", "HEAD");
    gitWithEnvironment(root, environment, "add", "-A", "--");
    hash.update(gitWithEnvironment(root, environment, "write-tree"));
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }

  const paths = changedPaths(root);

  return { fingerprint: hash.digest("hex"), paths };
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function workerIsActive(worker, alive = processAlive) {
  return Boolean(worker && !worker.finishedAt && alive(worker.pid));
}

export function resultIsReusable(result, fingerprint) {
  return Boolean(result && result.fingerprint === fingerprint && result.outcome === "success");
}

function launchWorker(root, directory) {
  mkdirSync(directory, { recursive: true });
  const logPath = join(directory, "worker.log");
  const descriptor = openSync(logPath, "a");
  const child = spawn(
    process.execPath,
    [new URL(import.meta.url).pathname, "worker", "--root", root],
    {
      cwd: root,
      detached: true,
      env: withoutGitEnvironment(),
      stdio: ["ignore", descriptor, descriptor],
    },
  );
  child.unref();
  closeSync(descriptor);
  atomicJson(join(directory, "worker.json"), {
    pid: child.pid,
    startedAt: new Date().toISOString(),
  });
  return child.pid;
}

function requestStart(root, quiet = false) {
  const directory = stateDirectory(root);
  mkdirSync(directory, { recursive: true });
  const fingerprint = fingerprintWorktree(root);
  const plan = classifyPaths(fingerprint.paths, {
    fullReason: "local empty change set",
    root,
  });
  atomicJson(join(directory, "desired.json"), {
    fingerprint: fingerprint.fingerprint,
    plan,
    requestedAt: new Date().toISOString(),
  });

  const result = readJson(join(directory, "result.json"));
  if (resultIsReusable(result, fingerprint.fingerprint)) {
    if (!quiet) {
      process.stdout.write(
        `quality preflight: ${fingerprint.fingerprint.slice(0, 12)} already passed\n`,
      );
    }
    return fingerprint;
  }

  let worker = readJson(join(directory, "worker.json"));
  let pid = workerIsActive(worker) ? worker.pid : null;
  if (pid === null) {
    const token = acquireLaunchLock(directory);
    if (token) {
      try {
        worker = readJson(join(directory, "worker.json"));
        pid = workerIsActive(worker) ? worker.pid : launchWorker(root, directory);
      } finally {
        releaseLaunchLock(directory, token);
      }
    } else {
      worker = readJson(join(directory, "worker.json"));
      pid = workerIsActive(worker) ? worker.pid : "starting";
    }
  }
  if (!quiet) {
    process.stdout.write(
      `quality preflight: ${fingerprint.fingerprint.slice(0, 12)} queued (worker ${pid})\n`,
    );
  }
  return fingerprint;
}

async function runLane(root, directory, planPath, lane, fingerprint) {
  const logPath = join(directory, `${fingerprint}.${lane}.log`);
  const descriptor = openSync(logPath, "w");
  const started = Date.now();
  const child = spawn(
    process.execPath,
    [join(root, "scripts/quality/run-lane.mjs"), "--plan", planPath, "--lane", lane, "--local"],
    { cwd: root, env: process.env, stdio: ["ignore", descriptor, descriptor] },
  );
  const status = await new Promise((resolvePromise) => {
    child.on("error", () => resolvePromise(1));
    child.on("exit", (code) => resolvePromise(code ?? 1));
  });
  closeSync(descriptor);
  return {
    durationSeconds: Number(((Date.now() - started) / 1000).toFixed(3)),
    lane,
    logPath,
    outcome: status === 0 ? "success" : "failure",
    status,
  };
}

async function workerLoop(root) {
  const directory = stateDirectory(root);
  try {
    while (true) {
      const desired = readJson(join(directory, "desired.json"));
      if (!desired) {
        return;
      }
      const planPath = join(directory, `${desired.fingerprint}.plan.json`);
      atomicJson(planPath, desired.plan);
      atomicJson(join(directory, "result.json"), {
        fingerprint: desired.fingerprint,
        outcome: "running",
        startedAt: new Date().toISOString(),
      });

      const results = [];
      for (const wave of executionWaves()) {
        const waveResults = await Promise.all(
          wave.map((lane) => runLane(root, directory, planPath, lane, desired.fingerprint)),
        );
        results.push(...waveResults);
        atomicJson(join(directory, "result.json"), {
          fingerprint: desired.fingerprint,
          outcome: "running",
          plan: desired.plan,
          results,
          startedAt: desired.requestedAt,
        });
        if (waveResults.some((result) => result.status !== 0)) {
          break;
        }
      }
      const current = fingerprintWorktree(root);
      const latestDesired = readJson(join(directory, "desired.json"));
      if (
        current.fingerprint !== desired.fingerprint ||
        latestDesired?.fingerprint !== desired.fingerprint
      ) {
        appendFileSync(
          join(directory, "worker.log"),
          `quality preflight: rejected stale result ${desired.fingerprint}\n`,
        );
        const currentPlan = classifyPaths(current.paths, { root });
        atomicJson(join(directory, "desired.json"), {
          fingerprint: current.fingerprint,
          plan: currentPlan,
          requestedAt: new Date().toISOString(),
        });
        continue;
      }

      const failures = results.filter((result) => result.status !== 0);
      atomicJson(join(directory, "result.json"), {
        completedAt: new Date().toISOString(),
        fingerprint: desired.fingerprint,
        outcome: failures.length === 0 ? "success" : "failure",
        plan: desired.plan,
        results,
      });
      return;
    }
  } finally {
    atomicJson(join(directory, "worker.json"), {
      finishedAt: new Date().toISOString(),
      pid: process.pid,
    });
  }
}

function showFailure(result) {
  for (const lane of result.results ?? []) {
    if (lane.status === 0) {
      continue;
    }
    process.stderr.write(`\nquality preflight failed: ${lane.lane}\n`);
    if (existsSync(lane.logPath)) {
      process.stderr.write(readFileSync(lane.logPath, "utf8"));
    }
  }
}

async function joinPreflight(root, timeoutSeconds) {
  let requested = requestStart(root, true);
  const directory = stateDirectory(root);
  const deadline = Date.now() + timeoutSeconds * 1000;
  let reportedStale = false;

  while (Date.now() < deadline) {
    const current = fingerprintWorktree(root);
    if (current.fingerprint !== requested.fingerprint) {
      if (!reportedStale) {
        process.stdout.write("quality preflight: worktree changed; rejecting stale results\n");
        reportedStale = true;
      }
      requested = requestStart(root, true);
    }

    const result = readJson(join(directory, "result.json"));
    if (result?.fingerprint === requested.fingerprint && result.outcome !== "running") {
      if (result.outcome === "success") {
        process.stdout.write(
          `quality preflight: ${requested.fingerprint.slice(0, 12)} passed (${result.results.length} lanes)\n`,
        );
        return 0;
      }
      showFailure(result);
      return 1;
    }

    const worker = readJson(join(directory, "worker.json"));
    if (!workerIsActive(worker)) {
      requested = requestStart(root, true);
    }

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }

  process.stderr.write(`quality preflight: timed out after ${timeoutSeconds}s\n`);
  return 1;
}

function parseRoot(argv) {
  const rootIndex = argv.indexOf("--root");
  return rootIndex >= 0 ? resolve(argv[rootIndex + 1]) : repositoryRoot();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [operation = "status", ...argv] = process.argv.slice(2);
  const root = parseRoot(argv);

  try {
    if (operation === "worker") {
      await workerLoop(root);
    } else if (operation === "start") {
      requestStart(root, argv.includes("--quiet"));
    } else if (operation === "join") {
      const timeoutIndex = argv.indexOf("--timeout");
      const timeout = timeoutIndex >= 0 ? Number(argv[timeoutIndex + 1]) : 1_800;
      process.exitCode = await joinPreflight(root, timeout);
    } else if (operation === "status") {
      const directory = stateDirectory(root);
      const current = fingerprintWorktree(root);
      const result = readJson(join(directory, "result.json"));
      process.stdout.write(
        `${JSON.stringify({ current: current.fingerprint, result }, null, 2)}\n`,
      );
    } else {
      throw new Error(`Unknown operation: ${operation}`);
    }
  } catch (error) {
    process.stderr.write(
      `quality preflight: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
