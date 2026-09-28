#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { classifyPaths } from "./classifier.mjs";
import { pollForDeployment, correlatesWithOriginMain } from "./wait-for-deploy.mjs";

function git(...args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  }
  return result.stdout.trim();
}

function failedProbe(target) {
  const response = spawnSync(
    "gh",
    [
      "api",
      `repos/mauricekleine/fluncle/actions/workflows/post-deploy-probe.yml/runs?head_sha=${target}&event=push&per_page=20`,
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  if (response.status !== 0) {
    return null;
  }
  try {
    const runs = JSON.parse(response.stdout).workflow_runs;
    const latest = runs.find((run) => run.head_sha === target && run.event === "push");
    return latest?.conclusion === "failure" || latest?.conclusion === "timed_out"
      ? `post-deploy probe ${latest.id} ${latest.conclusion} for ${target}`
      : null;
  } catch {
    return null;
  }
}

try {
  const target = process.argv[2];
  if (process.argv.length !== 3 || !/^[0-9a-f]{40}$/.test(target ?? "")) {
    throw new Error("expected one full 40-character commit SHA");
  }
  const timeout = Number(process.env.DEPLOY_VERIFY_TIMEOUT ?? 1200);
  if (!Number.isSafeInteger(timeout) || timeout < 1) {
    throw new Error("DEPLOY_VERIFY_TIMEOUT must be a positive number of seconds");
  }
  git("fetch", "--quiet", "origin", "main");
  if (
    spawnSync("git", ["cat-file", "-e", `${target}^{commit}`]).status !== 0 ||
    spawnSync("git", ["merge-base", "--is-ancestor", target, "origin/main"]).status !== 0
  ) {
    throw new Error(`${target} is not a commit on origin/main`);
  }

  const paths = git("diff", "--name-only", `${target}^`, target, "--").split("\n").filter(Boolean);
  if (!classifyPaths(paths).deploy) {
    process.stdout.write(`No Worker deployment is required for ${target} (excluded paths).\n`);
  } else {
    const result = await pollForDeployment({
      deadlineSeconds: timeout,
      isAncestor: correlatesWithOriginMain,
      onMiss: () => {
        const failure = failedProbe(target);
        if (failure) {
          throw new Error(failure);
        }
      },
      target,
    });
    process.stdout.write(`Live Worker ${result.served} contains ${target}.\n`);
  }
} catch (error) {
  process.stderr.write(
    `deploy:verify: ${String(error instanceof Error ? error.message : error).replace(/\s+/g, " ")}\n`,
  );
  process.exitCode = 1;
}
