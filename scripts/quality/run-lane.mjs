#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { repositoryRoot } from "./classifier.mjs";

function parseArguments(argv) {
  const parsed = { local: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--lane") {
      parsed.lane = argv[++index];
    } else if (argument === "--plan") {
      parsed.planPath = argv[++index];
    } else if (argument === "--local") {
      parsed.local = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!parsed.lane || !parsed.planPath) {
    throw new Error("Usage: run-lane.mjs --plan <plan.json> --lane <lane> [--local]");
  }
  return parsed;
}

function command(program, args, options = {}) {
  return { args, options, program };
}

export function commandsForLane(plan, lane, options = {}) {
  if (lane === "static") {
    return [command("bun", ["run", "lint"]), command("bun", ["run", "format:check"])];
  }

  if (lane === "packages") {
    if (plan.packages.length === 0) {
      return [];
    }
    return [
      command("bunx", [
        "turbo",
        "run",
        "typecheck",
        "test",
        "build",
        ...plan.packages.map((packageName) => `--filter=${packageName}`),
      ]),
    ];
  }

  if (lane === "scripts") {
    return plan.lanes.scripts ? [command("bun", ["run", "test:scripts"])] : [];
  }

  if (lane === "skills") {
    if (!plan.lanes.skills) {
      return [];
    }
    if (options.local) {
      return [command("bun", ["run", "skills:install", "--verify"])];
    }
    return [
      command("bun", ["run", "skills:install"]),
      command("git", [
        "diff",
        "--exit-code",
        "--",
        ".agents/skills",
        ".claude/skills",
        "skills-lock.json",
      ]),
    ];
  }

  if (lane === "go-ssh" || lane === "go-dns") {
    const app = lane === "go-ssh" ? "ssh" : "dns";
    const enabled = lane === "go-ssh" ? plan.lanes.goSsh : plan.lanes.goDns;
    if (!enabled) {
      return [];
    }
    return [
      command("gofmt", ["-l", `apps/${app}`], { requireEmptyStdout: true }),
      command("go", ["vet", "-C", `apps/${app}`, "./..."]),
      command("go", ["build", "-C", `apps/${app}`, "./..."]),
      command("go", ["test", "-C", `apps/${app}`, "./..."]),
    ];
  }

  if (lane === "sonar") {
    if (!plan.lanes.sonar) {
      return [];
    }
    const manifest = "apps/sonar/Cargo.toml";
    return [
      command("cargo", ["fmt", "--manifest-path", manifest, "--check"]),
      command("cargo", [
        "clippy",
        "--manifest-path",
        manifest,
        "--all-targets",
        "--",
        "-D",
        "warnings",
      ]),
      command("cargo", ["build", "--release", "--locked", "--manifest-path", manifest]),
      command("cargo", ["test", "--locked", "--manifest-path", manifest]),
    ];
  }

  if (lane === "workflows") {
    return plan.lanes.workflows
      ? [command("bun", ["test", "scripts/quality/workflows.test.ts"])]
      : [];
  }

  if (lane === "e2e") {
    return plan.lanes.e2e ? [command("bun", ["run", "--cwd", "apps/web", "test:e2e"])] : [];
  }

  throw new Error(`Unknown lane: ${lane}`);
}

function run(commandDefinition) {
  return new Promise((resolvePromise) => {
    const child = spawn(commandDefinition.program, commandDefinition.args, {
      cwd: repositoryRoot(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("error", (error) => {
      process.stderr.write(`${error.message}\n`);
      resolvePromise(1);
    });
    child.on("exit", (code) => {
      if (code === 0 && commandDefinition.options.requireEmptyStdout && stdout.trim()) {
        process.stderr.write(`Formatting drift:\n${stdout}`);
        resolvePromise(1);
        return;
      }
      resolvePromise(code ?? 1);
    });
  });
}

export async function runLane(plan, lane, options = {}) {
  const commands = commandsForLane(plan, lane, options);
  if (commands.length === 0) {
    process.stdout.write(`quality lane ${lane}: not selected\n`);
    return 0;
  }

  for (const commandDefinition of commands) {
    process.stdout.write(
      `quality lane ${lane}: ${commandDefinition.program} ${commandDefinition.args.join(" ")}\n`,
    );
    const status = await run(commandDefinition);
    if (status !== 0) {
      return status;
    }
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const plan = JSON.parse(readFileSync(options.planPath, "utf8"));
    process.exitCode = await runLane(plan, options.lane, options);
  } catch (error) {
    process.stderr.write(
      `quality lane: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
