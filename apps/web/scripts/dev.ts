#!/usr/bin/env bun
/**
 * Local dev orchestrator.
 *
 * When TURSO_DATABASE_URL points at a local libSQL server (http://127.0.0.1:…),
 * this boots that server (`turso dev` over this worktree's .dev/local.db),
 * waits for it, applies any pending Drizzle migrations, then runs Vite. On a
 * remote URL it just runs Vite (the legacy behaviour). The local server is
 * cleaned up on exit.
 */
import { $, type Subprocess } from "bun";
import { createClient } from "@libsql/client/web";
import { config } from "dotenv";
import { existsSync } from "node:fs";

config({ path: ".dev.vars" });

const url = process.env.TURSO_DATABASE_URL ?? "";
const isLocal = /^http:\/\/(127\.0\.0\.1|localhost):\d+/.test(url);
const children: Subprocess[] = [];

function spawn(cmd: string[]): Subprocess {
  const proc = Bun.spawn(cmd, {
    env: process.env,
    stdio: ["inherit", "inherit", "inherit"],
  });

  children.push(proc);

  return proc;
}

function shutdown(): void {
  for (const child of children) {
    try {
      child.kill();
    } catch {
      // Already gone.
    }
  }
}

async function waitForDb(dbUrl: string, attempts = 50): Promise<void> {
  const client = createClient({
    authToken: process.env.TURSO_AUTH_TOKEN ?? "local-dev",
    url: dbUrl,
  });

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await client.execute("SELECT 1");

      return;
    } catch {
      await Bun.sleep(100);
    }
  }

  throw new Error(`Local libSQL server did not come up at ${dbUrl}`);
}

process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});
process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});
process.on("exit", shutdown);

if (isLocal) {
  const port = new URL(url).port;

  if (!existsSync(".dev/local.db")) {
    console.log("No local database yet — seeding…");
    await $`bun run scripts/db-refresh.ts`;
  }

  console.log(`Starting local libSQL server on :${port}…`);
  spawn(["turso", "dev", "--db-file", ".dev/local.db", "--port", port]);

  await waitForDb(url);

  console.log("Applying migrations…");
  await $`bun run db:migrate`;
} else if (url) {
  console.warn(
    `TURSO_DATABASE_URL is remote (${new URL(url).host}). Running Vite against it directly. Run \`bun run db:refresh-dev\` to switch to a local database.`,
  );
} else {
  console.warn("No TURSO_DATABASE_URL set in .dev.vars.");
}

spawn(["bun", "run", "dev:vite"]);
