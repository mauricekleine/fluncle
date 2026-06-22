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

config({ path: ".dev.vars", quiet: true });

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

// `turso dev` is a launcher: it boots an embedded `sqld` child and runs a
// startup version check against GitHub. On a freshly provisioned worktree's
// first run — competing with the rest of the concurrent turbo dev fan-out for
// CPU/IO — that cold start can take well over a few seconds. Once warm it's
// ~200ms. Budget for the cold case (30s) so the first `bun run dev` doesn't
// lose the race, and bail immediately with turso's own output if it exits.
async function waitForDb(dbUrl: string, server: Subprocess, attempts = 300): Promise<void> {
  const client = createClient({
    authToken: process.env.TURSO_AUTH_TOKEN ?? "local-dev",
    url: dbUrl,
  });

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (server.exitCode !== null) {
      throw new Error(
        `\`turso dev\` exited (code ${server.exitCode}) before the local libSQL server became reachable at ${dbUrl}. See its output above; check that the \`turso\` CLI is installed and can reach the network on first run.`,
      );
    }

    try {
      await client.execute("SELECT 1");

      return;
    } catch {
      await Bun.sleep(100);
    }
  }

  throw new Error(
    `Local libSQL server did not come up at ${dbUrl} within ${(attempts * 100) / 1000}s`,
  );
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
  const server = spawn(["turso", "dev", "--db-file", ".dev/local.db", "--port", port]);

  await waitForDb(url, server);

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
