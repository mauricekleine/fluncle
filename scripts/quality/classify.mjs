#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { classifyPaths, repositoryRoot } from "./classifier.mjs";

function argumentsFrom(argv) {
  const parsed = { files: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--base") {
      parsed.base = argv[++index];
    } else if (argument === "--head") {
      parsed.head = argv[++index];
    } else if (argument === "--file") {
      parsed.files.push(argv[++index]);
    } else if (argument === "--files-from") {
      parsed.filesFrom = argv[++index];
    } else if (argument === "--force-full") {
      parsed.forceFull = true;
    } else if (argument === "--full-reason") {
      parsed.fullReason = argv[++index];
    } else if (argument === "--github-output") {
      parsed.githubOutput = argv[++index];
    } else if (argument === "--output") {
      parsed.output = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return parsed;
}

function git(...args) {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot(),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function resolveBase(base, head) {
  if (base && !/^0+$/.test(base)) {
    return base;
  }

  const parent = spawnSync("git", ["rev-parse", `${head}^`], {
    cwd: repositoryRoot(),
    encoding: "utf8",
  });
  return parent.status === 0 ? parent.stdout.trim() : "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
}

function changedFiles(options) {
  if (options.files.length > 0) {
    return options.files;
  }

  if (options.filesFrom) {
    if (options.filesFrom === "-") {
      throw new Error("--files-from - is not supported; pass a file path or repeat --file");
    }
    return readFileSync(options.filesFrom, "utf8").split(/\r?\n/).filter(Boolean);
  }

  const head = options.head ?? "HEAD";
  const base = resolveBase(options.base, head);
  options.base = base;
  options.head = head;
  const output = git("diff", "--name-only", "--diff-filter=ACDMRTUXB", base, head, "--");
  return output ? output.split("\n") : [];
}

function writeGithubOutput(path, plan) {
  const outputs = {
    base: plan.base,
    deploy: plan.deploy,
    e2e: plan.lanes.e2e,
    full: plan.full,
    go_dns: plan.lanes.goDns,
    go_ssh: plan.lanes.goSsh,
    head: plan.head,
    migrations: plan.lanes.migrations,
    packages: JSON.stringify(plan.packages),
    scripts: plan.lanes.scripts,
    skills: plan.lanes.skills,
    sonar: plan.lanes.sonar,
    turbo: plan.packages.length > 0,
    unknown: plan.unknownFiles.length > 0,
    workflows: plan.lanes.workflows,
  };
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${String(value)}`);
  appendFileSync(path, `${lines.join("\n")}\n`);
}

try {
  const options = argumentsFrom(process.argv.slice(2));
  const files = changedFiles(options);
  const plan = classifyPaths(files, options);
  const serialized = `${JSON.stringify(plan, null, 2)}\n`;
  if (options.output) {
    writeFileSync(options.output, serialized);
  }
  if (options.githubOutput) {
    writeGithubOutput(options.githubOutput, plan);
  }
  process.stdout.write(serialized);
} catch (error) {
  process.stderr.write(
    `quality classifier: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
