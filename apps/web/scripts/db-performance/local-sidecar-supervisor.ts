#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { existsSync, rmSync, rmdirSync } from "node:fs";

const PROCESS_STOP_GRACE_MS = 2_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

async function removeScratchDirectory(path: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    rmSync(path, { force: true, recursive: true });
    try {
      rmdirSync(path);
    } catch (error) {
      if (
        !(
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error.code === "ENOENT" || error.code === "ENOTDIR")
        )
      ) {
        throw error;
      }
    }
    if (!existsSync(path)) {
      return;
    }
    await sleep(25);
  }
  throw new Error("scratch directory still exists after recursive removal");
}

function parseArguments(args: readonly string[]): {
  command: string[];
  ownerPid: number;
  scratchDirectory: string;
} {
  const separatorIndex = args.indexOf("--");
  const ownerFlagIndex = args.indexOf("--owner-pid");
  const scratchFlagIndex = args.indexOf("--scratch-dir");
  const ownerPid = Number.parseInt(ownerFlagIndex < 0 ? "" : (args[ownerFlagIndex + 1] ?? ""), 10);
  const scratchDirectory = scratchFlagIndex < 0 ? undefined : args[scratchFlagIndex + 1];
  const command = separatorIndex < 0 ? [] : args.slice(separatorIndex + 1);

  if (
    !scratchDirectory ||
    !Number.isSafeInteger(ownerPid) ||
    ownerPid <= 0 ||
    separatorIndex < 0 ||
    command.length === 0
  ) {
    throw new Error(
      "usage: local-sidecar-supervisor --owner-pid <pid> --scratch-dir <path> -- <command...>",
    );
  }

  return { command, ownerPid, scratchDirectory };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

async function main(): Promise<void> {
  const { command, ownerPid, scratchDirectory } = parseArguments(process.argv.slice(2));
  const executable = command[0];
  if (executable === undefined) {
    throw new Error("local sidecar command is empty");
  }

  const sidecar = spawn(executable, command.slice(1), {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const sidecarExited = new Promise<void>((resolve) => sidecar.once("exit", () => resolve()));
  sidecar.stdout.on("data", (chunk: Uint8Array) => process.stdout.write(chunk));
  sidecar.stderr.on("data", (chunk: Uint8Array) => process.stderr.write(chunk));

  let shutdownPromise: Promise<void> | null = null;
  let ownerMonitor: ReturnType<typeof setInterval> | null = null;
  let resolveCompletion: (() => void) | null = null;
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });
  const shutdown = (reason: string, exitCode: number): Promise<void> => {
    shutdownPromise ??= (async () => {
      if (ownerMonitor !== null) {
        clearInterval(ownerMonitor);
        ownerMonitor = null;
      }
      if (sidecar.exitCode === null && sidecar.signalCode === null) {
        sidecar.kill("SIGTERM");
        await Promise.race([sidecarExited, sleep(PROCESS_STOP_GRACE_MS)]);
      }
      if (sidecar.exitCode === null && sidecar.signalCode === null) {
        sidecar.kill("SIGKILL");
        await Promise.race([sidecarExited, sleep(PROCESS_STOP_GRACE_MS)]);
      }

      try {
        await removeScratchDirectory(scratchDirectory);
        // A just-exited database process can finish closing its storage handles after emitting its
        // exit event. Recheck after a short stabilization window so a late empty-directory recreate
        // cannot survive owner-death cleanup.
        await sleep(100);
        await removeScratchDirectory(scratchDirectory);
      } catch (error) {
        process.stderr.write(
          `supervisor artifact cleanup failed after ${reason}: ${errorMessage(error)}\n`,
        );
        exitCode = 1;
      }

      process.exitCode = exitCode;
      if (process.connected) {
        process.disconnect();
      }
      resolveCompletion?.();
    })();
    return shutdownPromise;
  };

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => {
      void shutdown(signal, 128);
    });
  }
  process.once("disconnect", () => {
    void shutdown("owner disconnect", 0);
  });
  ownerMonitor = setInterval(() => {
    if (!processExists(ownerPid)) {
      void shutdown("owner death", 0);
    }
  }, 100);
  process.once("message", (message) => {
    if (
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === "shutdown"
    ) {
      void shutdown("owner request", 0);
    }
  });
  sidecar.once("error", (error) => {
    process.stderr.write(`sidecar spawn failed: ${errorMessage(error)}\n`);
    void shutdown("sidecar spawn failure", 1);
  });
  sidecar.once("exit", (code, signal) => {
    if (shutdownPromise === null) {
      process.stderr.write(
        `sidecar exited before owner shutdown (${code ?? signal ?? "unknown"})\n`,
      );
      void shutdown("sidecar exit", code === 0 ? 1 : (code ?? 1));
    }
  });

  await completion;
}

try {
  await main();
} catch (error) {
  process.stderr.write(`local sidecar supervisor failed: ${errorMessage(error)}\n`);
  process.exitCode = 1;
}
