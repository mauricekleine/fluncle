#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

function parseArguments(argv) {
  const separator = argv.indexOf("--");
  if (separator < 0 || separator === argv.length - 1) {
    throw new Error("Usage: measure.mjs --lane <name> [--metrics <path>] -- <command> [args...]");
  }
  const options = { command: argv.slice(separator + 1), lane: "unnamed" };
  for (let index = 0; index < separator; index += 1) {
    if (argv[index] === "--lane") {
      options.lane = argv[++index];
    } else if (argv[index] === "--metrics") {
      options.metrics = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${argv[index]}`);
    }
  }
  return options;
}

function summaryPath() {
  return process.env.GITHUB_STEP_SUMMARY || null;
}

try {
  const options = parseArguments(process.argv.slice(2));
  const startedAt = new Date();
  const started = performance.now();
  const child = spawn(options.command[0], options.command.slice(1), {
    env: process.env,
    stdio: "inherit",
  });
  const status = await new Promise((resolvePromise) => {
    child.on("error", () => resolvePromise(1));
    child.on("exit", (code) => resolvePromise(code ?? 1));
  });
  const completedAt = new Date();
  const durationSeconds = Number(((performance.now() - started) / 1000).toFixed(3));
  const record = {
    command: options.command,
    completedAt: completedAt.toISOString(),
    durationSeconds,
    lane: options.lane,
    outcome: status === 0 ? "success" : "failure",
    startedAt: startedAt.toISOString(),
  };
  if (options.metrics) {
    appendFileSync(options.metrics, `${JSON.stringify(record)}\n`);
  }
  const summary = summaryPath();
  if (summary) {
    appendFileSync(
      summary,
      `| ${options.lane} | ${record.outcome} | ${durationSeconds.toFixed(1)}s |\n`,
    );
  }
  process.stdout.write(`QUALITY_METRIC ${JSON.stringify(record)}\n`);
  process.exitCode = status;
} catch (error) {
  process.stderr.write(
    `quality measurement: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
