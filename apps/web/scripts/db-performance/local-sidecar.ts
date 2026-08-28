import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { spawn as spawnChild } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@libsql/client/web";

import { LOCAL_DB_CONCURRENCY } from "../../src/lib/database-concurrency";

const DEFAULT_READINESS_TIMEOUT_MS = 30_000;
const DEFAULT_READINESS_POLL_MS = 100;
const DEFAULT_READINESS_REQUEST_TIMEOUT_MS = 2_000;
const DEFAULT_START_ATTEMPTS = 3;
const PROCESS_STOP_GRACE_MS = 2_000;
const LOG_TAIL_CHARACTER_LIMIT = 16_384;
const LOG_READ_TIMEOUT_MS = 250;
const BENCHMARK_REQUEST_TIMEOUT_MS = 60_000;
const SUPERVISOR_PATH = fileURLToPath(new URL("./local-sidecar-supervisor.ts", import.meta.url));

export const ISOLATED_LOCAL_LIBSQL_RESOURCE_SOURCE =
  "process.memoryUsage.isolated-local-libsql-client" as const;

export type LocalLibsqlClient = ReturnType<typeof createClient>;

export function performanceFetchWithTimeout(
  requestTimeoutMs: number,
): (request: Request) => Promise<Response> {
  return (request) =>
    globalThis.fetch(request, {
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(requestTimeoutMs)]),
    });
}

export type ManagedSidecarProcess = {
  exitCode: number | null;
  exited: Promise<number>;
  logs: () => Promise<string>;
  terminate: () => Promise<void>;
};

export type LocalLibsqlSidecarRuntime = {
  allocatePort: () => Promise<number>;
  createClient: (url: string, authToken: string) => LocalLibsqlClient;
  createIdentity: (scratchDirectory: string) => Promise<{
    authToken: string;
    publicKeyPath: string;
  }>;
  createReadinessClient: (
    url: string,
    authToken: string,
    requestTimeoutMs: number,
  ) => LocalLibsqlClient;
  makeScratchDirectory: (prefix: string) => Promise<string>;
  now: () => number;
  removeScratchDirectory: (path: string) => Promise<void>;
  sleep: (durationMs: number) => Promise<void>;
  spawn: (
    command: readonly string[],
    cwd: string,
    scratchDirectory: string,
  ) => ManagedSidecarProcess;
  withTimeout: <T>(promise: Promise<T>, durationMs: number, label: string) => Promise<T>;
};

export type LocalLibsqlSidecar = {
  client: LocalLibsqlClient;
  close: () => Promise<void>;
  resourceSampleSource: typeof ISOLATED_LOCAL_LIBSQL_RESOURCE_SOURCE;
  url: string;
};

type StartLocalLibsqlSidecarOptions = {
  cwd?: string;
  readinessPollMs?: number;
  readinessRequestTimeoutMs?: number;
  readinessTimeoutMs?: number;
  runtime?: LocalLibsqlSidecarRuntime;
  startAttempts?: number;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

async function allocateLoopbackPort(): Promise<number> {
  const server = createServer();

  return await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not allocate a loopback TCP port for local libSQL"));
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve(address.port);
        }
      });
    });
  });
}

function collectStreamTail(stream: NodeJS.ReadableStream): () => string {
  const decoder = new TextDecoder();
  let tail = "";
  stream.on("data", (chunk: string | Uint8Array) => {
    tail += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    if (tail.length > LOG_TAIL_CHARACTER_LIMIT) {
      tail = tail.slice(-LOG_TAIL_CHARACTER_LIMIT);
    }
  });
  return () => tail.slice(-LOG_TAIL_CHARACTER_LIMIT);
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

function spawnSidecar(
  command: readonly string[],
  cwd: string,
  scratchDirectory: string,
): ManagedSidecarProcess {
  const executable = command[0];
  if (executable === undefined) {
    throw new Error("local libSQL sidecar command is empty");
  }

  const subprocess = spawnChild(
    "bun",
    [
      SUPERVISOR_PATH,
      "--owner-pid",
      String(process.pid),
      "--scratch-dir",
      scratchDirectory,
      "--",
      ...command,
    ],
    {
      cwd,
      detached: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let observedExitCode: number | null = null;
  let spawnFailure: string | null = null;
  const exited = new Promise<number>((resolve) => {
    subprocess.once("error", (error) => {
      spawnFailure = errorMessage(error);
      observedExitCode = 1;
      resolve(1);
    });
    subprocess.once("exit", (code) => {
      observedExitCode = code ?? 1;
      resolve(observedExitCode);
    });
  });
  const pid = subprocess.pid;
  const managesProcessGroup = pid !== undefined && signalProcessGroup(pid, 0);
  const stdout = collectStreamTail(subprocess.stdout);
  const stderr = collectStreamTail(subprocess.stderr);

  return {
    get exitCode() {
      return observedExitCode;
    },
    exited,
    async logs() {
      return [spawnFailure, stdout(), stderr()]
        .filter((value) => value !== null && value.trim().length > 0)
        .join("\n");
    },
    async terminate() {
      if (observedExitCode === null && subprocess.connected) {
        subprocess.send({ type: "shutdown" });
      }

      await Promise.race([exited.then(() => undefined), sleep(PROCESS_STOP_GRACE_MS)]);

      let sentTerminationSignal = false;
      if (observedExitCode === null && managesProcessGroup && pid !== undefined) {
        signalProcessGroup(pid, "SIGTERM");
        sentTerminationSignal = true;
      } else if (observedExitCode === null) {
        try {
          subprocess.kill("SIGTERM");
          sentTerminationSignal = true;
        } catch {
          // The launcher already exited.
        }
      }

      if (sentTerminationSignal) {
        await Promise.race([exited.then(() => undefined), sleep(PROCESS_STOP_GRACE_MS)]);
      }

      // A detached process group makes teardown resilient if this direct local server ever gains
      // helper children. A missing group simply means the owned process tree is already gone.
      if (managesProcessGroup && pid !== undefined && signalProcessGroup(pid, 0)) {
        signalProcessGroup(pid, "SIGKILL");
      }

      await Promise.race([exited.then(() => undefined), sleep(PROCESS_STOP_GRACE_MS)]);
      const groupIsAlive = managesProcessGroup && pid !== undefined && signalProcessGroup(pid, 0);
      if (groupIsAlive || (!managesProcessGroup && observedExitCode === null)) {
        throw new Error("local libSQL sidecar process did not stop after SIGKILL");
      }
    },
  };
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function createAuthenticationIdentity(scratchDirectory: string): Promise<{
  authToken: string;
  publicKeyPath: string;
}> {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPath = join(scratchDirectory, "auth-public.pem");
  await writeFile(publicKeyPath, publicKey.export({ format: "pem", type: "spki" }));
  const protectedHeader = base64UrlJson({ alg: "EdDSA", typ: "JWT" });
  const payload = base64UrlJson({
    a: "rw",
    exp: Math.floor(Date.now() / 1_000) + 6 * 60 * 60,
    iat: Math.floor(Date.now() / 1_000),
    jti: randomUUID(),
  });
  const signingInput = `${protectedHeader}.${payload}`;
  const signature = sign(null, Buffer.from(signingInput), privateKey).toString("base64url");

  return { authToken: `${signingInput}.${signature}`, publicKeyPath };
}

async function withTimeout<T>(promise: Promise<T>, durationMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`${label} timed out after ${durationMs}ms`)),
      durationMs,
    );
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

const DEFAULT_RUNTIME: LocalLibsqlSidecarRuntime = {
  allocatePort: allocateLoopbackPort,
  createClient(url, authToken) {
    return createClient({
      authToken,
      concurrency: LOCAL_DB_CONCURRENCY,
      fetch: performanceFetchWithTimeout(BENCHMARK_REQUEST_TIMEOUT_MS),
      url,
    });
  },
  createIdentity: createAuthenticationIdentity,
  createReadinessClient(url, authToken, requestTimeoutMs) {
    return createClient({
      authToken,
      concurrency: 1,
      fetch: performanceFetchWithTimeout(requestTimeoutMs),
      url,
    });
  },
  makeScratchDirectory: mkdtemp,
  now: Date.now,
  removeScratchDirectory(path) {
    return rm(path, { force: true, recursive: true });
  },
  sleep,
  spawn: spawnSidecar,
  withTimeout,
};

async function cleanupSidecar(options: {
  clients: readonly (LocalLibsqlClient | null)[];
  process: ManagedSidecarProcess | null;
  runtime: LocalLibsqlSidecarRuntime;
  scratchDirectory: string | null;
}): Promise<string[]> {
  const failures: string[] = [];

  for (const client of options.clients) {
    if (client === null) {
      continue;
    }
    try {
      client.close();
    } catch (error) {
      failures.push(`client close failed: ${errorMessage(error)}`);
    }
  }

  if (options.process !== null) {
    try {
      await options.process.terminate();
    } catch (error) {
      failures.push(`process cleanup failed: ${errorMessage(error)}`);
    }
  }

  if (options.scratchDirectory !== null) {
    try {
      await options.runtime.removeScratchDirectory(options.scratchDirectory);
    } catch (error) {
      failures.push(`artifact cleanup failed: ${errorMessage(error)}`);
    }
  }

  return failures;
}

export async function startLocalLibsqlSidecar(
  options: StartLocalLibsqlSidecarOptions = {},
): Promise<LocalLibsqlSidecar> {
  const cwd = options.cwd ?? process.cwd();
  const readinessPollMs = options.readinessPollMs ?? DEFAULT_READINESS_POLL_MS;
  const readinessRequestTimeoutMs =
    options.readinessRequestTimeoutMs ?? DEFAULT_READINESS_REQUEST_TIMEOUT_MS;
  const readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  const runtime = options.runtime ?? DEFAULT_RUNTIME;
  const startAttempts = options.startAttempts ?? DEFAULT_START_ATTEMPTS;
  const attemptFailures: string[] = [];

  for (let attempt = 1; attempt <= startAttempts; attempt += 1) {
    let scratchDirectory: string | null = null;
    let sidecarProcess: ManagedSidecarProcess | null = null;
    let client: LocalLibsqlClient | null = null;
    let readinessClient: LocalLibsqlClient | null = null;

    try {
      scratchDirectory = await runtime.makeScratchDirectory(join(cwd, ".db-performance-"));
      const identity = await runtime.createIdentity(scratchDirectory);
      const port = await runtime.allocatePort();
      const url = `http://127.0.0.1:${port}`;
      sidecarProcess = runtime.spawn(
        [
          "sqld",
          "--db-path",
          join(scratchDirectory, "fixture.db"),
          "--http-listen-addr",
          `127.0.0.1:${port}`,
          "--auth-jwt-key-file",
          identity.publicKeyPath,
          "--no-welcome",
          "--disable-metrics",
          "--shutdown-timeout",
          "1",
        ],
        cwd,
        scratchDirectory,
      );
      readinessClient = runtime.createReadinessClient(
        url,
        identity.authToken,
        readinessRequestTimeoutMs,
      );
      const deadline = runtime.now() + readinessTimeoutMs;
      let lastReadinessFailure = "no readiness request completed";

      while (runtime.now() <= deadline) {
        if (sidecarProcess.exitCode !== null) {
          throw new Error(`sqld supervisor exited ${sidecarProcess.exitCode} before readiness`);
        }

        const remainingMs = Math.max(1, deadline - runtime.now());
        try {
          await runtime.withTimeout(
            readinessClient.execute("SELECT 1"),
            Math.min(readinessRequestTimeoutMs, remainingMs),
            "local libSQL readiness query",
          );

          // A server already occupying the allocated port cannot authenticate this run's random
          // token. Keep the successful connection through one poll as an additional bind-collision
          // guard, then require this run's supervisor to still be alive before accepting it.
          await runtime.sleep(Math.min(readinessPollMs, Math.max(1, deadline - runtime.now())));
          const ownershipExitCode = sidecarProcess.exitCode;
          if (ownershipExitCode !== null) {
            throw new Error(
              `sqld supervisor exited ${String(ownershipExitCode)} during readiness ownership check`,
            );
          }

          readinessClient.close();
          readinessClient = null;
          client = runtime.createClient(url, identity.authToken);
          let closePromise: Promise<void> | null = null;
          return {
            client,
            close() {
              closePromise ??= cleanupSidecar({
                clients: [client],
                process: sidecarProcess,
                runtime,
                scratchDirectory,
              }).then((failures) => {
                if (failures.length > 0) {
                  throw new Error(`local libSQL sidecar cleanup failed: ${failures.join("; ")}`);
                }
              });
              return closePromise;
            },
            resourceSampleSource: ISOLATED_LOCAL_LIBSQL_RESOURCE_SOURCE,
            url,
          };
        } catch (error) {
          lastReadinessFailure = errorMessage(error);
          await runtime.sleep(readinessPollMs);
        }
      }

      throw new Error(
        `local libSQL sidecar did not become ready within ${readinessTimeoutMs}ms: ${lastReadinessFailure}`,
      );
    } catch (error) {
      const cleanupFailures = await cleanupSidecar({
        clients: [client, readinessClient],
        process: sidecarProcess,
        runtime,
        scratchDirectory,
      });
      let logs = "";
      if (sidecarProcess !== null) {
        try {
          logs = await runtime.withTimeout(
            sidecarProcess.logs(),
            LOG_READ_TIMEOUT_MS,
            "local libSQL log collection",
          );
        } catch (logError) {
          logs = `sidecar logs unavailable: ${errorMessage(logError)}`;
        }
      }
      const details = [errorMessage(error), ...cleanupFailures, logs.trim()]
        .filter((value) => value.length > 0)
        .join("\n");
      attemptFailures.push(`attempt ${attempt}/${startAttempts}: ${details}`);
    }
  }

  throw new Error(
    `isolated local libSQL is required for an exact fixture run:\n${attemptFailures.join("\n")}`,
  );
}
