#!/usr/bin/env bun
/**
 * The nightly admin-smoke routine's deterministic wrapper (docs/agents/smoke-routine.md).
 *
 * Boots a fully isolated dev stack on DEDICATED ports — a `turso dev` libSQL
 * server over this checkout's seeded `.dev/local.db`, plus a Vite dev server —
 * runs the three admin browser smokes (shell, queue with SEED=1, touch) against
 * it, tears the stack down, and prints ONE machine-parseable summary line:
 *
 *   SMOKE ROUTINE: shell=PASS|FAIL queue=PASS|FAIL touch=PASS|FAIL
 *
 * Exit 0 iff all three passed. The scheduled "nightly-admin-smokes" desktop
 * routine parses that final line (see the doc).
 *
 * THE DB-URL CONTRACT (verified empirically, not assumed): the dev worker runs
 * under `@cloudflare/vite-plugin`, which injects `apps/web/.dev.vars` as the
 * worker's bindings — a `TURSO_DATABASE_URL` passed as a process env var to the
 * Vite child is IGNORED by the worker (proven: with `.dev.vars` pointing at a
 * dead port the DB read faults even when the env var names a live server; point
 * `.dev.vars` at the live server and it works). So to aim the app at our
 * dedicated libSQL port we transiently rewrite `.dev.vars`'s `TURSO_DATABASE_URL`
 * — the one file BOTH the worker (via the plugin) AND the smokes (via dotenv's
 * `loadDevVars`) read — backing up the original and restoring it in a `finally`
 * and on every signal. `dotenv` never overrides an already-set process var, so
 * the rewritten file is the clean single source of truth for the whole stack.
 */
import { type Subprocess } from "bun";
import { connect } from "node:net";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

// Dedicated ports — high and distinctive so they never collide with the everyday
// dev stack (Vite :3000, per-worktree libSQL :81xx–:89xx). We REFUSE, never kill,
// if either is already taken.
const HTTP_PORT = 3120;
const LIBSQL_PORT = 8899;
const BASE_URL = `http://127.0.0.1:${HTTP_PORT}`;
const LIBSQL_URL = `http://127.0.0.1:${LIBSQL_PORT}`;

const DEV_VARS = ".dev.vars";
const LOCAL_DB = ".dev/local.db";
// Under the gitignored `.dev/` so a crash mid-run can never leave a stray file
// staged, and the next run can self-heal from it.
const DEV_VARS_BACKUP = ".dev/dev-vars.routine-backup";

const READINESS_TIMEOUT_MS = 90_000;
const READINESS_POLL_MS = 500;

export type SmokeName = "shell" | "queue" | "touch";
export type SmokeResults = Record<SmokeName, boolean>;

/** The final, machine-parseable line the routine agent reads. Byte-stable. */
export function formatSummary(results: SmokeResults): string {
  const mark = (ok: boolean): string => (ok ? "PASS" : "FAIL");

  return `SMOKE ROUTINE: shell=${mark(results.shell)} queue=${mark(results.queue)} touch=${mark(results.touch)}`;
}

/** Rewrite the `.dev.vars` text so `TURSO_DATABASE_URL` names `url`, leaving every
 * other line untouched (append the line if it is somehow absent). */
export function withTursoUrl(devVars: string, url: string): string {
  const line = `TURSO_DATABASE_URL=${url}`;

  if (/^TURSO_DATABASE_URL=.*$/m.test(devVars)) {
    return devVars.replace(/^TURSO_DATABASE_URL=.*$/m, line);
  }

  return devVars.endsWith("\n") ? `${devVars}${line}\n` : `${devVars}\n${line}\n`;
}

function fail(reason: string): never {
  console.error(`smoke:routine — ${reason}`);
  process.exit(1);
}

/** True if something is accepting TCP connections on `127.0.0.1:port`. */
function isPortListening(port: number): Promise<boolean> {
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

/** The local libSQL port named by the current `.dev.vars`, or null if remote/unset. */
function currentLocalDbPort(devVars: string): number | null {
  const match = devVars.match(/^TURSO_DATABASE_URL=(.*)$/m);
  const value = match?.[1]?.trim();

  if (!value) {
    return null;
  }

  const local = value.match(/^https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)/);

  return local ? Number(local[1]) : null;
}

// ── A captured child: streams its output through to us live AND keeps a rolling
//    tail so a boot timeout can report exactly why the process never came up. ──
type Captured = { proc: Subprocess; tail: () => string };

function spawnCaptured(cmd: string[]): Captured {
  const proc = Bun.spawn(cmd, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  const chunks: string[] = [];
  const decoder = new TextDecoder();

  const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    for await (const chunk of stream) {
      const text = decoder.decode(chunk);
      process.stderr.write(text);
      chunks.push(text);

      if (chunks.length > 200) {
        chunks.splice(0, chunks.length - 200);
      }
    }
  };

  void pump(proc.stdout as ReadableStream<Uint8Array>);
  void pump(proc.stderr as ReadableStream<Uint8Array>);

  return { proc, tail: () => chunks.join("").split("\n").slice(-40).join("\n") };
}

async function waitForHttp(url: string, children: Captured[]): Promise<void> {
  const deadline = Date.now() + READINESS_TIMEOUT_MS;

  while (Date.now() < deadline) {
    for (const child of children) {
      if (child.proc.exitCode !== null) {
        throw new Error(`a stack process exited (code ${child.proc.exitCode}) during boot`);
      }
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const response = await fetch(url, { signal: controller.signal });

      clearTimeout(timer);

      if (response.ok) {
        return;
      }
    } catch {
      // Not up yet.
    }

    await Bun.sleep(READINESS_POLL_MS);
  }

  throw new Error(`${url} did not become ready within ${READINESS_TIMEOUT_MS / 1000}s`);
}

/** Wait for the local libSQL server to answer a trivial query. */
async function waitForDb(children: Captured[]): Promise<void> {
  const { createClient } = await import("@libsql/client/web");
  const client = createClient({ authToken: "local-dev", url: LIBSQL_URL });
  const deadline = Date.now() + READINESS_TIMEOUT_MS;

  while (Date.now() < deadline) {
    for (const child of children) {
      if (child.proc.exitCode !== null) {
        throw new Error(`turso dev exited (code ${child.proc.exitCode}) during boot`);
      }
    }

    try {
      await client.execute("SELECT 1");

      return;
    } catch {
      await Bun.sleep(READINESS_POLL_MS);
    }
  }

  throw new Error(`local libSQL server did not come up at ${LIBSQL_URL} in time`);
}

/** Run one smoke to completion, streaming its output through; returns pass/fail. */
async function runSmoke(
  name: SmokeName,
  file: string,
  extraEnv: Record<string, string>,
): Promise<boolean> {
  console.log(`\n── ${name} smoke ─────────────────────────────────────────────`);

  const proc = Bun.spawn(["bun", file], {
    env: { ...process.env, BASE_URL, ...extraEnv },
    stdio: ["ignore", "inherit", "inherit"],
  });

  return (await proc.exited) === 0;
}

async function main(): Promise<void> {
  // ── Preflight — fail fast, one clear line each ──────────────────────────────
  if (!existsSync(DEV_VARS)) {
    fail(`${DEV_VARS} not found — copy it from the main checkout (docs/local-database.md).`);
  }

  if (!existsSync(LOCAL_DB)) {
    fail(`${LOCAL_DB} not found — seed the local dev DB first (bun run db:refresh-dev).`);
  }

  // Self-heal: a prior run that died mid-swap left the true original here.
  if (existsSync(DEV_VARS_BACKUP)) {
    console.warn(`smoke:routine — restoring ${DEV_VARS} from a prior run's backup`);
    writeFileSync(DEV_VARS, readFileSync(DEV_VARS_BACKUP));
    rmSync(DEV_VARS_BACKUP);
  }

  const original = readFileSync(DEV_VARS, "utf8");

  if (await isPortListening(HTTP_PORT)) {
    fail(`port ${HTTP_PORT} is in use — refusing to start (stop what's on it and retry).`);
  }

  if (await isPortListening(LIBSQL_PORT)) {
    fail(`port ${LIBSQL_PORT} is in use — refusing to start (stop what's on it and retry).`);
  }

  // If a dev stack is already serving from THIS checkout's `.dev.vars`, rewriting
  // it out from under that worker would break it — refuse.
  const inUsePort = currentLocalDbPort(original);

  if (inUsePort !== null && (await isPortListening(inUsePort))) {
    fail(
      `a dev server is running on this checkout's .dev.vars libSQL port :${inUsePort} — refusing to rewrite .dev.vars under it (stop \`bun run dev\` and retry).`,
    );
  }

  // ── Swap `.dev.vars` to our dedicated libSQL port (crash-safe backup) ───────
  const children: Captured[] = [];
  let restored = false;

  const restore = (): void => {
    if (restored) {
      return;
    }

    restored = true;

    try {
      writeFileSync(DEV_VARS, original);
    } catch {
      // Best effort — the backup below is the durable copy.
    }

    try {
      if (existsSync(DEV_VARS_BACKUP)) {
        rmSync(DEV_VARS_BACKUP);
      }
    } catch {
      // Leave the backup for the next run to self-heal from.
    }
  };

  const teardown = (): void => {
    for (const child of children) {
      try {
        child.proc.kill("SIGTERM");
      } catch {
        // Already gone.
      }
    }
  };

  const onSignal = (): void => {
    teardown();
    restore();
    process.exit(1);
  };

  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  writeFileSync(DEV_VARS_BACKUP, original);
  writeFileSync(DEV_VARS, withTursoUrl(original, LIBSQL_URL));

  const results: SmokeResults = { queue: false, shell: false, touch: false };

  try {
    // ── Boot: libSQL, migrate, then Vite — all reading the rewritten `.dev.vars` ─
    console.log(`smoke:routine — starting local libSQL server on :${LIBSQL_PORT}…`);
    const turso = spawnCaptured([
      "turso",
      "dev",
      "--db-file",
      LOCAL_DB,
      "--port",
      String(LIBSQL_PORT),
    ]);
    children.push(turso);
    await waitForDb([turso]);

    console.log("smoke:routine — applying migrations…");
    const migrate = Bun.spawn(["bun", "run", "db:migrate"], {
      env: process.env,
      stdio: ["ignore", "inherit", "inherit"],
    });

    if ((await migrate.exited) !== 0) {
      throw new Error("db:migrate failed");
    }

    console.log(`smoke:routine — starting Vite dev server on :${HTTP_PORT}…`);
    const vite = spawnCaptured([
      "bun",
      "run",
      "dev:vite",
      "--",
      "--host",
      "127.0.0.1",
      "--port",
      String(HTTP_PORT),
    ]);
    children.push(vite);
    await waitForHttp(`${BASE_URL}/api/health`, [turso, vite]);
    console.log(`smoke:routine — stack ready at ${BASE_URL}`);

    // ── Run the three smokes; continue past a failure so all three report ──────
    results.shell = await runSmoke("shell", "tests/browser/shell-smoke.ts", {});
    results.queue = await runSmoke("queue", "tests/browser/queue-smoke.ts", { SEED: "1" });
    results.touch = await runSmoke("touch", "tests/browser/admin-touch-smoke.ts", {});
  } catch (error) {
    console.error(
      `\nsmoke:routine — boot failed: ${error instanceof Error ? error.message : String(error)}`,
    );

    for (const child of children) {
      const tail = child.tail().trim();

      if (tail) {
        console.error(`\n--- captured output ---\n${tail}`);
      }
    }
  } finally {
    teardown();
    // Give the children a moment to release the dedicated ports, then reap any
    // straggler (an orphaned sqld) still holding OUR ports.
    await Bun.sleep(1500);
    await reapPort(HTTP_PORT);
    await reapPort(LIBSQL_PORT);
    restore();
  }

  const summary = formatSummary(results);

  console.log(`\n${summary}`);

  process.exit(results.shell && results.queue && results.touch ? 0 : 1);
}

/** SIGKILL anything still bound to one of OUR dedicated ports after teardown. */
async function reapPort(port: number): Promise<void> {
  if (!(await isPortListening(port))) {
    return;
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

if (import.meta.main) {
  await main();
}
