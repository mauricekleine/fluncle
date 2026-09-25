#!/usr/bin/env bun
import { type Subprocess } from "bun";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { seedE2eData } from "../tests/e2e/seed";
import { startFakeSonar } from "../tests/e2e/fake-sonar";
import { LOCAL_DB_CONCURRENCY } from "../src/lib/database-concurrency";
import {
  isPortListening,
  killProc,
  LIBSQL_PORT,
  LIBSQL_URL,
  materializeDevVars,
  reapPorts,
  restoreDevVars,
  runScript,
  SONAR_PORT,
  startLibsql,
  VITE_PORT,
  WEB_ROOT,
} from "../tests/e2e/stack";

let turso: Subprocess | undefined;
let vite: Subprocess | undefined;
let sonar: ReturnType<typeof startFakeSonar> | undefined;
let cleanedUp = false;

async function cleanup(): Promise<void> {
  if (cleanedUp) {
    return;
  }

  cleanedUp = true;
  await sonar?.stop(true);
  killProc(vite);
  killProc(turso);

  await Bun.sleep(1000);
  await reapPorts();
  restoreDevVars();
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void cleanup().then(() => process.exit(0));
  });
}

async function main(): Promise<void> {
  for (const port of [VITE_PORT, LIBSQL_PORT, SONAR_PORT]) {
    if (await isPortListening(port)) {
      throw new Error(
        `port ${port} is already in use — stop what's on it and retry the e2e suite.`,
      );
    }
  }

  materializeDevVars();

  rmSync(join(WEB_ROOT, ".wrangler", "state", "v3", "cache"), { force: true, recursive: true });

  console.log(`e2e-stack: starting libSQL on :${LIBSQL_PORT}…`);
  turso = await startLibsql();

  console.log("e2e-stack: applying migrations + FTS index…");
  await runScript("db:migrate");

  console.log("e2e-stack: seeding synthetic fixtures…");
  const { createClient } = await import("@libsql/client");
  const client = createClient({
    authToken: "e2e-local",
    concurrency: LOCAL_DB_CONCURRENCY,
    url: LIBSQL_URL,
  });
  await seedE2eData(client);

  console.log(`e2e-stack: starting fake Sonar on :${SONAR_PORT}…`);
  sonar = startFakeSonar(client);

  console.log(`e2e-stack: booting Vite on :${VITE_PORT}…`);
  vite = Bun.spawn(
    ["bun", "run", "dev:vite", "--", "--host", "127.0.0.1", "--port", String(VITE_PORT)],
    {
      cwd: WEB_ROOT,

      env: { ...process.env, FLUNCLE_E2E_BLOCK_OUTBOUND: "1" },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );

  const code = await vite.exited;
  await cleanup();
  client.close();
  process.exit(code);
}

try {
  await main();
} catch (error) {
  console.error(`e2e-stack: ${error instanceof Error ? error.message : String(error)}`);
  await cleanup();
  process.exit(1);
}
