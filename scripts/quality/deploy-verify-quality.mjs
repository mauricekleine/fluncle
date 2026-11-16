#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = "mauricekleine/fluncle";
const workflow = ".github/workflows/quality-checks.yml";

export async function waitForMainQuality({
  sha,
  token,
  deadlineMs = 20 * 60 * 1000,
  intervalMs = 30_000,
  fetchImpl = (url, options) => fetch(url, options),
  now = Date.now,
  sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)),
  write = (text) => {
    process.stdout.write(text);
  },
}) {
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error("main Quality requires a full built commit SHA");
  }
  const deadline = now() + deadlineMs;
  const url = `https://api.github.com/repos/${repository}/actions/workflows/quality-checks.yml/runs?event=push&branch=main&head_sha=${sha}&per_page=100`;
  let lastRun = "no matching run";
  while (now() < deadline) {
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(Math.min(15_000, deadline - now())),
    });
    if (!response.ok) {
      throw new Error(`main Quality lookup failed: HTTP ${response.status}; ${url}; ${lastRun}`);
    }
    const body = await response.json();
    const run = body.workflow_runs
      .filter(
        (candidate) =>
          candidate.head_sha === sha &&
          candidate.head_branch === "main" &&
          candidate.event === "push" &&
          candidate.path === workflow &&
          candidate.head_repository?.full_name === repository,
      )
      .sort((left, right) => right.id - left.id)[0];
    if (run) {
      lastRun = `https://github.com/${repository}/actions/runs/${run.id} (attempt ${run.run_attempt}, ${run.status}/${run.conclusion ?? "pending"})`;
      if (run.status === "completed") {
        if (run.conclusion !== "success") {
          throw new Error(`main Quality refused publication for ${sha}: ${lastRun}`);
        }
        write(`main Quality succeeded for built SHA ${sha}: ${lastRun}\n`);
        return { verified: true };
      }
    }
    write(`waiting for main Quality for ${sha}: ${lastRun}\n`);
    await sleep(Math.min(intervalMs, Math.max(0, deadline - now())));
  }
  throw new Error(
    `main Quality timed out after ${deadlineMs / 1000}s for ${sha}: ${lastRun}; ${url}`,
  );
}

export async function verifyMainQuality({
  env = process.env,
  write = (text) => {
    process.stdout.write(text);
  },
} = {}) {
  if (env.FLUNCLE_DEPLOY_SKIP_MAIN_QUALITY === "1") {
    write("WARNING: incident override FLUNCLE_DEPLOY_SKIP_MAIN_QUALITY=1 bypasses main Quality.\n");
    return { verified: false };
  }
  if (!env.FLUNCLE_DEPLOY_GITHUB_TOKEN) {
    write(
      "WARNING: FLUNCLE_DEPLOY_GITHUB_TOKEN is absent; publishing without main Quality proof. The build retains its full deploy gate. Configure Actions read access to enable the wait.\n",
    );
    return { verified: false };
  }
  const commit = spawnSync("bun", [fileURLToPath(new URL("./build-commit.ts", import.meta.url))], {
    encoding: "utf8",
    env,
  });
  if (commit.status !== 0) {
    throw new Error("cannot resolve the built commit for main Quality");
  }
  return waitForMainQuality({
    sha: commit.stdout.trim(),
    token: env.FLUNCLE_DEPLOY_GITHUB_TOKEN,
    write,
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    await verifyMainQuality();
  } catch (error) {
    process.stderr.write(
      `deploy Quality: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
