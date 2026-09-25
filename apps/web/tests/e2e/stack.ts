import { type Subprocess } from "bun";
import { createHash } from "node:crypto";
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
import { LOCAL_DB_CONCURRENCY } from "../../src/lib/database-concurrency";

export const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const VITE_PORT_BASE = 3140;
const LIBSQL_PORT_BASE = 9440;
const SONAR_PORT_BASE = 9640;
const PORT_SLOTS = 200;

function portSlot(): number {
  if (process.env.CI) {
    return 0;
  }

  return createHash("sha256").update(WEB_ROOT).digest().readUInt16BE(0) % PORT_SLOTS;
}

const PORT_SLOT = portSlot();

export const VITE_PORT = VITE_PORT_BASE + PORT_SLOT;
export const LIBSQL_PORT = LIBSQL_PORT_BASE + PORT_SLOT;
export const SONAR_PORT = SONAR_PORT_BASE + PORT_SLOT;
export const BASE_URL = `http://127.0.0.1:${VITE_PORT}`;
export const LIBSQL_URL = `http://127.0.0.1:${LIBSQL_PORT}`;
export const SONAR_URL = `http://127.0.0.1:${SONAR_PORT}`;

const DEV_VARS = join(WEB_ROOT, ".dev.vars");
const DEV_VARS_TEMPLATE = join(WEB_ROOT, ".dev.vars.e2e.tpl");

const DEV_VARS_BACKUP = join(WEB_ROOT, ".dev", "e2e-dev-vars.backup");

const DEV_VARS_OWNED = join(WEB_ROOT, ".dev", "e2e-dev-vars.owned");
export const LOCAL_DB = join(WEB_ROOT, ".dev", "e2e.db");
export const TURSO_LOG_FILE = join(WEB_ROOT, ".dev", "e2e-turso.log");

const READINESS_TIMEOUT_MS = 90_000;
const READINESS_POLL_MS = 500;

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

export function materializeDevVars(): void {
  if (!existsSync(DEV_VARS_TEMPLATE)) {
    throw new Error(
      `${DEV_VARS_TEMPLATE} not found — the committed dummy env template is missing.`,
    );
  }

  ensureDevDir();

  restoreDevVars();

  if (existsSync(DEV_VARS)) {
    writeFileSync(DEV_VARS_BACKUP, readFileSync(DEV_VARS));
  } else {
    writeFileSync(DEV_VARS_OWNED, "");
  }

  writeFileSync(DEV_VARS, renderDevVarsTemplate());
}

function renderDevVarsTemplate(): string {
  const rendered = readFileSync(DEV_VARS_TEMPLATE, "utf8")
    .replaceAll("__E2E_VITE_PORT__", String(VITE_PORT))
    .replaceAll("__E2E_LIBSQL_PORT__", String(LIBSQL_PORT))
    .replaceAll("__E2E_SONAR_PORT__", String(SONAR_PORT));
  const unresolved = rendered.match(/__E2E_[A-Z_]+__/g);

  if (unresolved) {
    throw new Error(
      `${DEV_VARS_TEMPLATE} carries placeholders this stack does not fill: ${[
        ...new Set(unresolved),
      ].join(", ")}`,
    );
  }

  return rendered;
}

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
  mkdirSync(join(WEB_ROOT, ".dev"), { recursive: true });
}

export async function startLibsql(): Promise<Subprocess> {
  for (const file of [LOCAL_DB, `${LOCAL_DB}-wal`, `${LOCAL_DB}-shm`]) {
    if (existsSync(file)) {
      rmSync(file);
    }
  }

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

function readTursoLog(): string {
  try {
    const tail = readFileSync(TURSO_LOG_FILE, "utf8").trim().split("\n").slice(-20).join("\n");

    return tail ? `--- turso dev output ---\n${tail}` : `(${TURSO_LOG_FILE} was empty)`;
  } catch {
    return `(could not read ${TURSO_LOG_FILE})`;
  }
}

async function waitForDb(proc: Subprocess): Promise<void> {
  const { createClient } = await import("@libsql/client");
  const client = createClient({
    authToken: "e2e-local",
    concurrency: LOCAL_DB_CONCURRENCY,
    url: LIBSQL_URL,
  });
  const deadline = Date.now() + READINESS_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
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

export function killProc(proc: Subprocess | undefined): void {
  if (proc) {
    try {
      proc.kill("SIGTERM");
    } catch {}
  }
}

export async function reapPorts(): Promise<void> {
  for (const port of [LIBSQL_PORT, SONAR_PORT, VITE_PORT]) {
    if (!(await isPortListening(port))) {
      continue;
    }

    try {
      const pids = (await Bun.$`lsof -tiTCP:${port} -sTCP:LISTEN`.text()).trim();

      for (const pid of pids.split(/\s+/).filter(Boolean)) {
        try {
          process.kill(Number(pid), "SIGKILL");
        } catch {}
      }
    } catch {}
  }
}
