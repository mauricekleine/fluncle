#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { repositoryRoot } from "./classifier.mjs";

const CLI_PATHS = ["apps/cli/package.json", "apps/cli/src"];
const CLI_TEST_SUFFIXES = [".test.ts"];

function git(...args) {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot(),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.trim();
}

function changedFiles(base, sha) {
  if (!base) {
    return [];
  }
  const output = git("diff", "--name-only", `${base}..${sha}`, "--");
  return output ? output.split("\n") : [];
}

function latestTag(pattern) {
  const output = git("tag", "--list", pattern, "--sort=-v:refname");
  return output?.split("\n").filter(Boolean)[0] ?? null;
}

function cliShippingPath(path) {
  if (path === CLI_PATHS[0]) {
    return true;
  }
  return (
    path.startsWith(`${CLI_PATHS[1]}/`) &&
    !CLI_TEST_SUFFIXES.some((suffix) => path.endsWith(suffix))
  );
}

export function selectReleases({ force = "auto", sha = "HEAD" } = {}) {
  const cliBase = latestTag("v[0-9]*.[0-9]*.[0-9]*");
  const sonarBase = git("rev-parse", "--verify", "refs/tags/sonar-latest");
  const cliChanges = cliBase ? changedFiles(cliBase, sha) : ["apps/cli/src/cli.ts"];
  const sonarChanges = sonarBase ? changedFiles(sonarBase, sha) : ["apps/sonar/src/main.rs"];
  const automatic = {
    cli: cliChanges.some(cliShippingPath),
    sonar: sonarChanges.some((path) => path.startsWith("apps/sonar/")),
  };

  return {
    bases: { cli: cliBase, sonar: sonarBase },
    cli: force === "all" || force === "cli" || (force === "auto" && automatic.cli),
    sha,
    sonar: force === "all" || force === "sonar" || (force === "auto" && automatic.sonar),
  };
}

function parseArguments(argv) {
  const parsed = { force: "auto", sha: "HEAD" };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--sha") {
      parsed.sha = argv[++index];
    } else if (argv[index] === "--force") {
      parsed.force = argv[++index];
    } else if (argv[index] === "--github-output") {
      parsed.githubOutput = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${argv[index]}`);
    }
  }
  if (!["all", "auto", "cli", "sonar"].includes(parsed.force)) {
    throw new Error(`Invalid --force value: ${parsed.force}`);
  }
  return parsed;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const selection = selectReleases(options);
    if (options.githubOutput) {
      appendFileSync(
        options.githubOutput,
        `cli=${selection.cli}\nsonar=${selection.sonar}\nsha=${selection.sha}\n`,
      );
    }
    process.stdout.write(`${JSON.stringify(selection, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      `release selection: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
