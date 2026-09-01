#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { classifyPaths } from "./classifier.mjs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TERMINAL_STATUSES = new Set(["canceled", "failed", "succeeded"]);

function git(...args) {
  const result = spawnSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function gitResult(...args) {
  const result = spawnSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return { output: result.stdout.trim(), status: result.status ?? 1 };
}

export function validateDeployTarget(sha, gitImpl = gitResult) {
  const fetched = gitImpl("fetch", "--quiet", "origin", "main");
  if (fetched.status !== 0) {
    throw new Error(
      `could not refresh origin/main before validating deploy target: ${fetched.output}`,
    );
  }
  if (gitImpl("cat-file", "-e", `${sha}^{commit}`).status !== 0) {
    throw new Error(`deploy event target is not a repository commit: ${sha}`);
  }
  if (gitImpl("merge-base", "--is-ancestor", sha, "origin/main").status !== 0) {
    throw new Error(`deploy event target is not on pushed origin/main: ${sha}`);
  }
}

function changedFiles(base, head) {
  const output = git("diff", "--name-only", "--diff-filter=ACDMRTUXB", base, head, "--");
  return output ? output.split("\n") : [];
}

export function resolveDeployInput({ event, eventName }) {
  if (eventName === "push") {
    const head = event.after;
    const base = event.before && !/^0+$/.test(event.before) ? event.before : `${head}^`;
    const commitCount = Number(git("rev-list", "--count", `${base}..${head}`));
    const plan = classifyPaths(changedFiles(base, head), { base, commitCount, head });
    return {
      buildUuid: `fallback-${head}`,
      enabled: plan.deploy,
      mode: "poll-fallback",
      sha: head,
      status: "succeeded",
    };
  }

  const payload = eventName === "repository_dispatch" ? event.client_payload : event.inputs;
  const sha = payload?.sha;
  const status = payload?.status;
  const buildUuid = payload?.build_uuid;
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error("deploy event SHA must be a full 40-character lowercase commit hash");
  }
  if (typeof status !== "string" || !TERMINAL_STATUSES.has(status)) {
    throw new Error(`deploy event status must be one of: ${[...TERMINAL_STATUSES].join(", ")}`);
  }
  if (typeof buildUuid !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/.test(buildUuid)) {
    throw new Error("deploy event requires a safe 3-128 character build_uuid");
  }
  return { buildUuid, enabled: true, mode: "event", sha, status };
}

function parseArguments(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--event") {
      parsed.eventPath = argv[++index];
    } else if (argv[index] === "--event-name") {
      parsed.eventName = argv[++index];
    } else if (argv[index] === "--github-output") {
      parsed.githubOutput = argv[++index];
    } else if (argv[index] === "--output") {
      parsed.output = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${argv[index]}`);
    }
  }
  if (!parsed.eventPath || !parsed.eventName) {
    throw new Error("--event and --event-name are required");
  }
  return parsed;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const event = JSON.parse(readFileSync(options.eventPath, "utf8"));
    const resolved = resolveDeployInput({ event, eventName: options.eventName });
    if (resolved.enabled) {
      validateDeployTarget(resolved.sha);
    }
    if (options.output) {
      writeFileSync(options.output, `${JSON.stringify(resolved, null, 2)}\n`);
    }
    if (options.githubOutput) {
      appendFileSync(
        options.githubOutput,
        `build_uuid=${resolved.buildUuid}\nenabled=${resolved.enabled}\nmode=${resolved.mode}\nsha=${resolved.sha}\nstatus=${resolved.status}\n`,
      );
    }
    process.stdout.write(`${JSON.stringify(resolved, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      `deploy resolution: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
