// The E2E stack primitives, used by the Bun orchestrator `scripts/e2e-stack.ts`.
//
// The e2e suite runs against a fully ISOLATED, throwaway stack — a `turso dev`
// libSQL server over a fresh empty db file (seeded with COMMITTED synthetic
// fixtures, never the gitignored prod snapshot), plus a Vite dev server. The
// pattern is lifted from `scripts/smoke-routine.ts`; the differences are
// deliberate:
//
//   - DEDICATED ports (Vite :3140, libSQL :9440) that collide with nothing else
//     in the repo — not dev (:3000), not the smoke routine (:3120/:8899), not
//     the per-worktree libSQL range (:8100–:8999).
//   - A DUMMY env. CI has no `.dev.vars` and no secrets, so the stack
//     materializes `.dev.vars.e2e.tpl` (plainly-fake placeholders) into
//     `.dev.vars` for the run and restores the original afterwards.
//   - A SYNTHETIC seed — a small deterministic dataset (see `seed.ts`) applied to
//     a fresh empty DB, so the suite is reproducible and safe in a public repo.
//
// WHY A WEBSERVER ORCHESTRATOR, NOT A `globalSetup`: Playwright starts its
// `webServer` BEFORE `globalSetup` runs (globalSetup is even allowed to fetch the
// server), and the Playwright runner is Node — no `Bun` globals. So the whole
// stack (materialize `.dev.vars` → boot libSQL → migrate → seed → boot Vite) is
// built by ONE Bun script that IS the `webServer` command, and Playwright simply
// waits for `/api/health`. That also fixes the DB-URL trap below cleanly: the file
// is materialized before Vite ever reads it.
//
// THE DB-URL CONTRACT (proven by smoke-routine, not assumed): the dev worker runs
// under `@cloudflare/vite-plugin`, which injects `.dev.vars` as the worker's
// bindings and IGNORES a `TURSO_DATABASE_URL` passed as a process env var. So the
// materialized `.dev.vars` — pointing `TURSO_DATABASE_URL` at our libSQL port — is
// the ONE file both the worker (via the plugin) and the seed/migrate scripts (via
// dotenv) read.

import { type Subprocess } from "bun";
import { connect } from "node:net";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** apps/web — every path below is resolved against it, so the stack works from any cwd. */
export const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Dedicated, distinctive ports. Kept in sync with `.dev.vars.e2e.tpl` (which
// hardcodes the libSQL URL) and `playwright.config.ts` (which waits on Vite here).
export const VITE_PORT = 3140;
export const LIBSQL_PORT = 9440;
export const BASE_URL = `http://127.0.0.1:${VITE_PORT}`;
export const LIBSQL_URL = `http://127.0.0.1:${LIBSQL_PORT}`;

const DEV_VARS = join(WEB_ROOT, ".dev.vars");
const DEV_VARS_TEMPLATE = join(WEB_ROOT, ".dev.vars.e2e.tpl");
// All under the gitignored `.dev/`, so a crash mid-run can never stage a stray
// file and the next run self-heals from whatever it finds.
const DEV_VARS_BACKUP = join(WEB_ROOT, ".dev", "e2e-dev-vars.backup");
// Written only when there was NO original `.dev.vars` (CI): it marks the
// materialized file as ours to delete, so teardown never removes a real one.
const DEV_VARS_OWNED = join(WEB_ROOT, ".dev", "e2e-dev-vars.owned");
export const LOCAL_DB = join(WEB_ROOT, ".dev", "e2e.db");
export const TURSO_LOG_FILE = join(WEB_ROOT, ".dev", "e2e-turso.log");

const READINESS_TIMEOUT_MS = 90_000;
const READINESS_POLL_MS = 500;

/** True if something is accepting TCP connections on `127.0.0.1:port`. */
export function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const settle = (listening: boolean): void => {
      socket.destroy();
      resolve(listening);
    };

    socket.setTimeout(500);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

/**
 * Swap `.dev.vars` to the dummy e2e env, crash-safely. Backs up an existing
 * `.dev.vars` (local) or marks the materialized one as ours (CI), so `restoreDevVars`
 * always leaves the checkout exactly as it found it.
 */
export function materializeDevVars(): void {
  if (!existsSync(DEV_VARS_TEMPLATE)) {
    throw new Error(
      `${DEV_VARS_TEMPLATE} not found — the committed dummy env template is missing.`,
    );
  }

  ensureDevDir();
  // Self-heal from a prior run that died mid-swap before restoring.
  restoreDevVars();

  if (existsSync(DEV_VARS)) {
    writeFileSync(DEV_VARS_BACKUP, readFileSync(DEV_VARS));
  } else {
    writeFileSync(DEV_VARS_OWNED, "");
  }

  writeFileSync(DEV_VARS, readFileSync(DEV_VARS_TEMPLATE));
}

/** Restore the original `.dev.vars` (or remove the one we created). Idempotent. */
export function restoreDevVars(): void {
  if (existsSync(DEV_VARS_BACKUP)) {
    writeFileSync(DEV_VARS, readFileSync(DEV_VARS_BACKUP));
    rmSync(DEV_VARS_BACKUP);
    return;
  }

  if (existsSync(DEV_VARS_OWNED)) {
    if (existsSync(DEV_VARS)) {
      rmSync(DEV_VARS);
    }

    rmSync(DEV_VARS_OWNED);
  }
}

function ensureDevDir(): void {
  // `recursive` makes this a no-op when the dir already exists.
  mkdirSync(join(WEB_ROOT, ".dev"), { recursive: true });
}

/** Boot `turso dev` on the dedicated port over a FRESH empty db file. */
export async function startLibsql(): Promise<Subprocess> {
  // A fresh DB every run is what makes the suite deterministic — no residue from
  // a prior run's seed (or a half-applied migration) can leak in.
  for (const file of [LOCAL_DB, `${LOCAL_DB}-wal`, `${LOCAL_DB}-shm`]) {
    if (existsSync(file)) {
      rmSync(file);
    }
  }

  // Start the log fresh, then append each chunk — a boot failure is diagnosed from
  // this file, so it must reflect THIS run only.
  writeFileSync(TURSO_LOG_FILE, "");

  const proc = Bun.spawn(["turso", "dev", "--db-file", LOCAL_DB, "--port", String(LIBSQL_PORT)], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    for await (const chunk of stream) {
      appendFileSync(TURSO_LOG_FILE, chunk);
    }
  };

  void pump(proc.stdout as ReadableStream<Uint8Array>);
  void pump(proc.stderr as ReadableStream<Uint8Array>);

  await waitForDb(proc);

  return proc;
}

/** The tail of this run's turso log, formatted for an error message. */
function readTursoLog(): string {
  try {
    const tail = readFileSync(TURSO_LOG_FILE, "utf8").trim().split("\n").slice(-20).join("\n");

    return tail ? `--- turso dev output ---\n${tail}` : `(${TURSO_LOG_FILE} was empty)`;
  } catch {
    return `(could not read ${TURSO_LOG_FILE})`;
  }
}

/** Wait for the local libSQL server to answer a trivial query. */
async function waitForDb(proc: Subprocess): Promise<void> {
  const { createClient } = await import("@libsql/client");
  const client = createClient({ authToken: "e2e-local", url: LIBSQL_URL });
  const deadline = Date.now() + READINESS_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      // Inline the log: on CI nobody can open the file, so a boot failure has to
      // explain itself in the job output (e.g. `turso dev` needs `sqld` on PATH).
      throw new Error(`turso dev exited (code ${proc.exitCode}) during boot.\n${readTursoLog()}`);
    }

    try {
      await client.execute("SELECT 1");
      return;
    } catch {
      await Bun.sleep(READINESS_POLL_MS);
    }
  }

  throw new Error(`local libSQL server did not come up at ${LIBSQL_URL} within the timeout`);
}

/** Run a package script to completion, inheriting stdio; throws on a non-zero exit. */
export async function runScript(script: string): Promise<void> {
  const proc = Bun.spawn(["bun", "run", script], {
    cwd: WEB_ROOT,
    env: process.env,
    stdio: ["ignore", "inherit", "inherit"],
  });

  if ((await proc.exited) !== 0) {
    throw new Error(`\`bun run ${script}\` failed`);
  }
}

/** SIGTERM a stack child process. Safe to call on an already-dead child. */
export function killProc(proc: Subprocess | undefined): void {
  if (proc) {
    try {
      proc.kill("SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

/** SIGKILL anything still bound to one of OUR dedicated ports. Best effort. */
export async function reapPorts(): Promise<void> {
  for (const port of [LIBSQL_PORT, VITE_PORT]) {
    if (!(await isPortListening(port))) {
      continue;
    }

    try {
      const pids = (await Bun.$`lsof -tiTCP:${port} -sTCP:LISTEN`.text()).trim();

      for (const pid of pids.split(/\s+/).filter(Boolean)) {
        try {
          process.kill(Number(pid), "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    } catch {
      // lsof found nothing (or is unavailable) — best effort.
    }
  }
}
