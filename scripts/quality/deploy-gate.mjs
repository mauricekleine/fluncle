#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { repositoryRoot } from "./classifier.mjs";

const DEPLOYED = "--filter=@fluncle/web...";

export const DEPLOY_GATE_STEPS = [
  { args: ["run", "format:check"], name: "format", program: "bun" },
  { args: ["run", "lint"], name: "lint", program: "bun" },
  {
    args: ["test", "--cwd", "scripts", "no-comments"],
    name: "lint rule",
    program: "bun",
  },
  { args: ["run", "typecheck", DEPLOYED, "--continue"], name: "typecheck", program: "bun" },
  { args: ["run", "test", DEPLOYED, "--continue"], name: "test", program: "bun" },
];

function spawnStep(step) {
  const result = spawnSync(step.program, step.args, {
    cwd: repositoryRoot(),
    stdio: "inherit",
  });
  if (result.error) {
    process.stderr.write(`${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

export function runDeployGate(
  steps = DEPLOY_GATE_STEPS,
  run = spawnStep,
  write = (text) => {
    process.stdout.write(text);
  },
) {
  const failed = [];
  for (const step of steps) {
    write(`\ndeploy gate: ${step.name}: ${step.program} ${step.args.join(" ")}\n`);
    const status = run(step);
    if (status !== 0) {
      failed.push(`${step.name} (exit ${status})`);
    }
  }
  write(
    failed.length === 0
      ? `\ndeploy gate: all ${steps.length} steps passed\n`
      : `\ndeploy gate: ${failed.length} of ${steps.length} steps failed: ${failed.join(", ")}\n`,
  );
  return failed.length === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = runDeployGate();
}
