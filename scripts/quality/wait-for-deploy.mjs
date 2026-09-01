#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_HEALTH_URL = "https://www.fluncle.com/api/v1/health";

function git(...args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  return { output: result.stdout.trim(), status: result.status ?? 1 };
}

export function correlatesCommit(target, served, isAncestor) {
  if (served === target) {
    return true;
  }
  if (!/^[0-9a-f]{40}$/.test(served)) {
    return false;
  }
  return isAncestor(target, served);
}

export function correlatesWithOriginMain(target, served, gitImpl = git) {
  if (gitImpl("cat-file", "-e", `${served}^{commit}`).status !== 0) {
    gitImpl("fetch", "--quiet", "origin", "main");
  }
  return (
    gitImpl("cat-file", "-e", `${served}^{commit}`).status === 0 &&
    gitImpl("merge-base", "--is-ancestor", target, served).status === 0
  );
}

export async function pollForDeployment({
  deadlineSeconds,
  fetchImpl = fetch,
  healthUrl = DEFAULT_HEALTH_URL,
  intervalSeconds = 15,
  isAncestor,
  now = () => Date.now(),
  sleep = (milliseconds) =>
    new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
  target,
}) {
  const started = now();
  const deadline = started + deadlineSeconds * 1000;
  let lastServed = null;

  while (now() <= deadline) {
    try {
      const response = await fetchImpl(healthUrl, { signal: AbortSignal.timeout(10_000) });
      if (response.ok) {
        const body = await response.json();
        lastServed =
          typeof body === "object" && body !== null && typeof body.sha === "string"
            ? body.sha
            : null;
        if (lastServed && correlatesCommit(target, lastServed, isAncestor)) {
          return { served: lastServed, waitSeconds: (now() - started) / 1000 };
        }
      }
    } catch {
      // The bounded loop is the availability retry. The final error carries the last observed SHA.
    }
    await sleep(intervalSeconds * 1000);
  }

  throw new Error(
    `deployment did not correlate within ${deadlineSeconds}s: target=${target}, served=${lastServed ?? "none"}`,
  );
}

function parseArguments(argv) {
  const parsed = { deadlineSeconds: 1_200, healthUrl: DEFAULT_HEALTH_URL, intervalSeconds: 15 };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--target") {
      parsed.target = argv[++index];
    } else if (argv[index] === "--deadline") {
      parsed.deadlineSeconds = Number(argv[++index]);
    } else if (argv[index] === "--interval") {
      parsed.intervalSeconds = Number(argv[++index]);
    } else if (argv[index] === "--health-url") {
      parsed.healthUrl = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${argv[index]}`);
    }
  }
  if (!parsed.target || !/^[0-9a-f]{40}$/.test(parsed.target)) {
    throw new Error("--target must be a full 40-character commit hash");
  }
  return parsed;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const options = parseArguments(process.argv.slice(2));
    git("fetch", "--quiet", "origin", "main");
    if (git("cat-file", "-e", `${options.target}^{commit}`).status !== 0) {
      throw new Error(`target commit is not present after fetching origin/main: ${options.target}`);
    }
    if (git("merge-base", "--is-ancestor", options.target, "origin/main").status !== 0) {
      throw new Error(`target commit is not on origin/main: ${options.target}`);
    }

    const result = await pollForDeployment({
      ...options,
      isAncestor: (target, served) => correlatesWithOriginMain(target, served),
    });
    process.stdout.write(`POST_DEPLOY_WAIT ${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(
      `post-deploy wait: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
