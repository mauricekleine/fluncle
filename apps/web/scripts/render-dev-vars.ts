#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const templatePath = join(webRoot, ".dev.vars.tpl");
const account = process.env.FLUNCLE_1PASSWORD_ACCOUNT?.trim();
const item = process.env.FLUNCLE_1PASSWORD_ENV_ITEM?.trim();
const args = process.argv.slice(2);
const command = args[0] === "--" ? args.slice(1) : args;
const processOnly = process.platform === "linux" || command.length > 0;

if (!item) {
  console.error(
    "Missing FLUNCLE_1PASSWORD_ENV_ITEM. Set the local-dev 1Password item path, then retry.",
  );
  process.exit(1);
}

if (!existsSync(templatePath)) {
  console.error(`Missing ${templatePath}.`);
  process.exit(1);
}

if (processOnly && existsSync(join(webRoot, ".dev.vars"))) {
  console.error(
    "Process-only secrets require a worktree without apps/web/.dev.vars, which overrides the process environment in the Worker runtime.",
  );
  process.exit(1);
}

const opArgs = account ? ["--account", account] : [];

if (processOnly) {
  console.log("Starting with 1Password secrets in the process environment.");
  opArgs.push(
    "run",
    "--env-file",
    templatePath,
    "--",
    ...(command.length > 0 ? command : ["bun", "run", "dev"]),
  );
} else {
  opArgs.push("run", "--env-file", templatePath, "--", "bun", "run", "scripts/write-dev-vars.ts");
}

const result = spawnSync("op", opArgs, {
  cwd: webRoot,
  env: { ...process.env, ...(processOnly ? { CLOUDFLARE_INCLUDE_PROCESS_ENV: "true" } : {}) },
  stdio: "inherit",
});

if (result.error) {
  console.error(`Failed to run op: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
