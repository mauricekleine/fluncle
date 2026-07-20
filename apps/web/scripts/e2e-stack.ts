#!/usr/bin/env bun
/**
 * The E2E stack orchestrator — the process Playwright runs as its `webServer`
 * (see `playwright.config.ts`). It builds the whole isolated stack in order, then
 * runs Vite in the FOREGROUND so it becomes the long-lived server Playwright owns:
 *
 *   1. preflight the dedicated ports (refuse, never kill, if either is taken)
 *   2. materialize `.dev.vars` from the committed dummy template (backing up a
 *      real one) — the file the Cloudflare vite plugin AND the scripts below read
 *   3. boot `turso dev` on :9440 over a FRESH empty db file
 *   4. `db:migrate` — the real generated migrations + the FTS5 index (the exact
 *      step prod / dev / the integration harness all run)
 *   5. seed the committed synthetic dataset
 *   6. boot Vite on :3140 (foreground) and stay alive as its parent
 *
 * Playwright waits for `/api/health`, runs the suite, then SIGTERMs this process
 * on teardown. The signal traps below kill turso + Vite and restore `.dev.vars`,
 * so the checkout is left exactly as it was found. A crash that skips the traps is
 * still self-healing: the next `materializeDevVars` restores from the backup it
 * finds under the gitignored `.dev/`.
 *
 * WHY THIS IS THE WEBSERVER COMMAND, NOT A PLAYWRIGHT `globalSetup`: Playwright
 * starts the `webServer` BEFORE `globalSetup` (globalSetup may even fetch it), and
 * the Playwright runner is Node — no `Bun` globals. So the Bun-driven stack build
 * lives here, ahead of Vite, where it can prepare `.dev.vars` before Vite reads it.
 */
import { type Subprocess } from "bun";
import { seedE2eData } from "../tests/e2e/seed";
import {
  isPortListening,
  killProc,
  LIBSQL_PORT,
  LIBSQL_URL,
  materializeDevVars,
  reapPorts,
  restoreDevVars,
  runScript,
  startLibsql,
  VITE_PORT,
  WEB_ROOT,
} from "../tests/e2e/stack";

let turso: Subprocess | undefined;
let vite: Subprocess | undefined;
let cleanedUp = false;

async function cleanup(): Promise<void> {
  if (cleanedUp) {
    return;
  }

  cleanedUp = true;
  killProc(vite);
  killProc(turso);
  // Let the children release the ports, then reap any straggler holding ours.
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
  // Refuse (never kill) if either dedicated port is already taken — that is
  // another stack, and clobbering it would be worse than a clear failure.
  for (const port of [VITE_PORT, LIBSQL_PORT]) {
    if (await isPortListening(port)) {
      throw new Error(
        `port ${port} is already in use — stop what's on it and retry the e2e suite.`,
      );
    }
  }

  materializeDevVars();

  console.log(`e2e-stack: starting libSQL on :${LIBSQL_PORT}…`);
  turso = await startLibsql();

  console.log("e2e-stack: applying migrations + FTS index…");
  await runScript("db:migrate");

  console.log("e2e-stack: seeding synthetic fixtures…");
  const { createClient } = await import("@libsql/client");
  const client = createClient({ authToken: "e2e-local", url: LIBSQL_URL });
  await seedE2eData(client);
  client.close();

  console.log(`e2e-stack: booting Vite on :${VITE_PORT}…`);
  vite = Bun.spawn(
    ["bun", "run", "dev:vite", "--", "--host", "127.0.0.1", "--port", String(VITE_PORT)],
    {
      cwd: WEB_ROOT,
      // Arms the SERVER half of the no-network rail (vite.config.ts's
      // `e2eNoNetworkGuard`). The browser stub in tests/e2e/browser.ts covers what the
      // page asks for; this covers what the dev server does behind those requests —
      // otherwise a `/podcast.xml` render HEADs the production CDN and a preview lookup
      // reaches itunes.apple.com, with the template's fake creds in hand.
      env: { ...process.env, FLUNCLE_E2E_BLOCK_OUTBOUND: "1" },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );

  // Block on Vite: this keeps the orchestrator (and thus turso) alive for the
  // whole test session. If Vite exits on its own, tear the rest down and mirror
  // its code so the failure surfaces.
  const code = await vite.exited;
  await cleanup();
  process.exit(code);
}

try {
  await main();
} catch (error) {
  console.error(`e2e-stack: ${error instanceof Error ? error.message : String(error)}`);
  await cleanup();
  process.exit(1);
}
