#!/usr/bin/env bun

import { $ } from "bun";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DEV_DIR = ".dev";
const LOCAL_DB = join(DEV_DIR, "local.db");
const LOCAL_SEED = join(DEV_DIR, "seed.sql");

function portForWorktree(): number {
  const hash = createHash("sha256").update(process.cwd()).digest();

  return 8100 + (hash.readUInt16BE(0) % 900);
}

function upsertEnvLine(text: string, key: string, value: string): string {
  const line = new RegExp(`^${key}=.*$`, "m");

  if (line.test(text)) {
    return text.replace(line, `${key}=${value}`);
  }

  return `${text.replace(/\n*$/, "")}\n${key}=${value}\n`;
}

async function resolveSeed(): Promise<string> {
  const rootPath = process.env.SUPERSET_ROOT_PATH;

  if (rootPath) {
    const rootSeed = join(rootPath, "apps", "web", DEV_DIR, "seed.sql");

    if (existsSync(rootSeed)) {
      return rootSeed;
    }
  }

  if (existsSync(LOCAL_SEED)) {
    return LOCAL_SEED;
  }

  console.log("No dev snapshot found — bootstrapping from production…");
  await $`bun run scripts/db-pull-prod.ts`;

  return LOCAL_SEED;
}

async function pointDevVarsAtLocal(port: number): Promise<void> {
  const path = ".dev.vars";

  if (!existsSync(path)) {
    console.warn("No .dev.vars found; skipping local URL rewrite.");

    return;
  }

  let text = await readFile(path, "utf8");

  text = upsertEnvLine(text, "TURSO_DATABASE_URL", `http://127.0.0.1:${port}`);
  text = upsertEnvLine(text, "TURSO_AUTH_TOKEN", "local-dev");

  await writeFile(path, text, "utf8");
}

const port = portForWorktree();
const seed = await resolveSeed();

await mkdir(DEV_DIR, { recursive: true });

await $`rm -f ${LOCAL_DB} ${LOCAL_DB}-shm ${LOCAL_DB}-wal`.quiet();
await $`cat ${seed} | sqlite3 ${LOCAL_DB}`;

await pointDevVarsAtLocal(port);

console.log(`Local dev database ready at ${LOCAL_DB} (server port ${port}).`);
console.log("Start dev with: bun run dev");
