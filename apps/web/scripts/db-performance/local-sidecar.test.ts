import { describe, expect, it, vi } from "vitest";

import {
  ISOLATED_LOCAL_LIBSQL_RESOURCE_SOURCE,
  performanceFetchWithTimeout,
  type LocalLibsqlClient,
  type LocalLibsqlSidecarRuntime,
  type ManagedSidecarProcess,
  startLocalLibsqlSidecar,
} from "./local-sidecar";

type Harness = {
  clientCloseCalls: number;
  executeCalls: number;
  processTerminateCalls: number;
  removedDirectories: string[];
  runtime: LocalLibsqlSidecarRuntime;
  spawnedCommands: readonly string[][];
};

function sidecarHarness(options: {
  cleanupFailure?: boolean;
  exitCode?: number | null;
  failuresBeforeReady?: number;
  hangReadiness?: boolean;
  logHang?: boolean;
  logs?: string;
  portSequence?: number[];
  processSequence?: ManagedSidecarProcess[];
}): Harness {
  let clientCloseCalls = 0;
  let executeCalls = 0;
  let processTerminateCalls = 0;
  let clock = 0;
  const removedDirectories: string[] = [];
  const spawnedCommands: string[][] = [];
  const defaultSidecarProcess: ManagedSidecarProcess = {
    exitCode: options.exitCode ?? null,
    exited: Promise.resolve(options.exitCode ?? 0),
    logs: async () =>
      options.logHang ? await new Promise<string>(() => undefined) : (options.logs ?? ""),
    async terminate() {
      processTerminateCalls += 1;
      if (options.cleanupFailure) {
        throw new Error("terminate refused");
      }
    },
  };
  const client = {
    close() {
      clientCloseCalls += 1;
    },
    async execute() {
      executeCalls += 1;
      if (options.hangReadiness) {
        return await new Promise(() => undefined);
      }
      if (executeCalls <= (options.failuresBeforeReady ?? 0)) {
        throw new Error("not ready");
      }
      return { columnTypes: [], columns: [], rows: [], rowsAffected: 0 };
    },
  } as unknown as LocalLibsqlClient;
  const ports = [...(options.portSequence ?? [9876])];
  const processes = [...(options.processSequence ?? [defaultSidecarProcess])];
  const runtime: LocalLibsqlSidecarRuntime = {
    allocatePort: async () => ports.shift() ?? 9876,
    createClient: () => client,
    createIdentity: async () => ({
      authToken: "signed-token",
      publicKeyPath: "/tmp/db-performance-test/auth-public.pem",
    }),
    createReadinessClient: () => client,
    makeScratchDirectory: async () => "/tmp/db-performance-test",
    now: () => clock,
    async removeScratchDirectory(path) {
      removedDirectories.push(path);
      if (options.cleanupFailure) {
        throw new Error("remove refused");
      }
    },
    async sleep(durationMs) {
      clock += durationMs;
    },
    spawn(command) {
      spawnedCommands.push([...command]);
      return processes.shift() ?? defaultSidecarProcess;
    },
    async withTimeout(promise, _durationMs, label) {
      if (
        (options.hangReadiness && label.includes("readiness")) ||
        (options.logHang && label.includes("log"))
      ) {
        throw new Error(`${label} timed out`);
      }
      return await promise;
    },
  };

  return {
    get clientCloseCalls() {
      return clientCloseCalls;
    },
    get executeCalls() {
      return executeCalls;
    },
    get processTerminateCalls() {
      return processTerminateCalls;
    },
    removedDirectories,
    runtime,
    spawnedCommands,
  };
}

describe("exact-fixture local libSQL sidecar", () => {
  it("aborts benchmark HTTP requests at their absolute request deadline", async () => {
    vi.stubGlobal(
      "fetch",
      (_request: Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );

    try {
      await expect(
        performanceFetchWithTimeout(10)(new Request("http://127.0.0.1")),
      ).rejects.toBeDefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("waits for a real query and idempotently cleans the client, process group, and database", async () => {
    const harness = sidecarHarness({ failuresBeforeReady: 1 });
    const sidecar = await startLocalLibsqlSidecar({
      cwd: "/workspace/apps/web",
      readinessPollMs: 5,
      readinessTimeoutMs: 20,
      runtime: harness.runtime,
    });

    expect(harness.executeCalls).toBe(2);
    expect(harness.spawnedCommands).toEqual([
      [
        "sqld",
        "--db-path",
        "/tmp/db-performance-test/fixture.db",
        "--http-listen-addr",
        "127.0.0.1:9876",
        "--auth-jwt-key-file",
        "/tmp/db-performance-test/auth-public.pem",
        "--no-welcome",
        "--disable-metrics",
        "--shutdown-timeout",
        "1",
      ],
    ]);
    expect(sidecar.url).toBe("http://127.0.0.1:9876");
    expect(sidecar.resourceSampleSource).toBe(ISOLATED_LOCAL_LIBSQL_RESOURCE_SOURCE);

    await sidecar.close();
    await sidecar.close();

    expect(harness.clientCloseCalls).toBe(2);
    expect(harness.processTerminateCalls).toBe(1);
    expect(harness.removedDirectories).toEqual(["/tmp/db-performance-test"]);
  });

  it("fails closed with diagnostics and removes every owned resource after boot failure", async () => {
    const harness = sidecarHarness({ exitCode: 9, logs: "sqld could not start" });

    await expect(
      startLocalLibsqlSidecar({
        cwd: "/workspace/apps/web",
        runtime: harness.runtime,
        startAttempts: 1,
      }),
    ).rejects.toThrow(
      "isolated local libSQL is required for an exact fixture run:\nattempt 1/1: sqld supervisor exited 9 before readiness\nsqld could not start",
    );

    expect(harness.executeCalls).toBe(0);
    expect(harness.clientCloseCalls).toBe(1);
    expect(harness.processTerminateCalls).toBe(1);
    expect(harness.removedDirectories).toEqual(["/tmp/db-performance-test"]);
  });

  it("retries a port collision with a fresh authenticated sidecar", async () => {
    const collided: ManagedSidecarProcess = {
      exitCode: 98,
      exited: Promise.resolve(98),
      logs: async () => "address already in use",
      terminate: async () => undefined,
    };
    const ready: ManagedSidecarProcess = {
      exitCode: null,
      exited: Promise.resolve(0),
      logs: async () => "",
      terminate: async () => undefined,
    };
    const harness = sidecarHarness({
      portSequence: [9876, 9877],
      processSequence: [collided, ready],
    });
    const sidecar = await startLocalLibsqlSidecar({
      cwd: "/workspace/apps/web",
      runtime: harness.runtime,
      startAttempts: 2,
    });

    expect(sidecar.url).toBe("http://127.0.0.1:9877");
    expect(harness.spawnedCommands).toHaveLength(2);
    await sidecar.close();
  });

  it("bounds a hung readiness request and still tears down every resource", async () => {
    const harness = sidecarHarness({ hangReadiness: true });

    await expect(
      startLocalLibsqlSidecar({
        cwd: "/workspace/apps/web",
        readinessPollMs: 5,
        readinessTimeoutMs: 10,
        runtime: harness.runtime,
        startAttempts: 1,
      }),
    ).rejects.toThrow("local libSQL readiness query timed out");

    expect(harness.clientCloseCalls).toBe(1);
    expect(harness.processTerminateCalls).toBe(1);
    expect(harness.removedDirectories).toEqual(["/tmp/db-performance-test"]);
  });

  it("reports cleanup failures without waiting forever for open log pipes", async () => {
    const harness = sidecarHarness({ cleanupFailure: true, exitCode: 9, logHang: true });

    await expect(
      startLocalLibsqlSidecar({
        cwd: "/workspace/apps/web",
        runtime: harness.runtime,
        startAttempts: 1,
      }),
    ).rejects.toThrow(
      /process cleanup failed: terminate refused[\s\S]*artifact cleanup failed: remove refused[\s\S]*sidecar logs unavailable: local libSQL log collection timed out/,
    );
  });
});
