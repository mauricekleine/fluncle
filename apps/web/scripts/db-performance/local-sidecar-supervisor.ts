#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { existsSync, rmSync, rmdirSync } from "node:fs";

const PROCESS_STOP_GRACE_MS = 2_000;
const LOG_TAIL_CHARACTER_LIMIT = 16_384;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

async function waitForSettledOrTimeout(
  settledPromise: Promise<void>,
  durationMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      settledPromise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, durationMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function appendTail(current: string, chunk: Uint8Array): string {
  const combined = current + Buffer.from(chunk).toString("utf8");
  return combined.slice(-LOG_TAIL_CHARACTER_LIMIT);
}

function safeWrite(stream: NodeJS.WriteStream, message: string): void {
  if (stream.destroyed || !stream.writable) {
    return;
  }
  try {
    stream.write(message);
  } catch {
    // The benchmark owner can disappear between the writable check and the write.
  }
}

// A SIGKILLed owner closes these pipes without giving the supervisor a shutdown callback. Node
// reports that asynchronously, so the handlers must exist even though diagnostic writes are safe.
process.stdout.on("error", () => undefined);
process.stderr.on("error", () => undefined);

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
  // A spawn failure emits close without ever populating exitCode or signalCode, so the shutdown
  // escalation checks need close state tracked separately to stay off the kill ladder.
  let sidecarClosed = false;
  // The ladder only needs the process to be dead, which is exit; the diagnostic read below needs
  // the pipes drained, which is close. Settling on whichever lands first keeps a descendant that
  // inherited the pipes from holding the ladder open for a grace period after the sidecar is gone.
  const sidecarSettled = new Promise<void>((resolve) => {
    sidecar.once("exit", () => resolve());
    sidecar.once("close", () => {
      sidecarClosed = true;
      resolve();
    });
  });
  let stdoutTail = "";
  let stderrTail = "";
  // The supervisor owns its child's pipes. It retains only bounded diagnostics instead of
  // forwarding them into owner pipes that can raise EPIPE after an uncatchable owner death.
  sidecar.stdout.on("data", (chunk: Uint8Array) => {
    stdoutTail = appendTail(stdoutTail, chunk);
  });
  sidecar.stderr.on("data", (chunk: Uint8Array) => {
    stderrTail = appendTail(stderrTail, chunk);
  });

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
      if (!sidecarClosed && sidecar.exitCode === null && sidecar.signalCode === null) {
        sidecar.kill("SIGTERM");
        await waitForSettledOrTimeout(sidecarSettled, PROCESS_STOP_GRACE_MS);
      }
      if (!sidecarClosed && sidecar.exitCode === null && sidecar.signalCode === null) {
        sidecar.kill("SIGKILL");
        await waitForSettledOrTimeout(sidecarSettled, PROCESS_STOP_GRACE_MS);
      }

      try {
        await removeScratchDirectory(scratchDirectory);
        // A just-exited database process can finish closing its storage handles after emitting its
        // exit event. Recheck after a short stabilization window so a late empty-directory recreate
        // cannot survive owner-death cleanup.
        await sleep(100);
        await removeScratchDirectory(scratchDirectory);
      } catch (error) {
        safeWrite(
          process.stderr,
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
    safeWrite(process.stderr, `sidecar spawn failed: ${errorMessage(error)}\n`);
    void shutdown("sidecar spawn failure", 1);
  });
  sidecar.once("close", (code, signal) => {
    if (shutdownPromise === null) {
      const tails = [stdoutTail.trim(), stderrTail.trim()].filter((value) => value.length > 0);
      safeWrite(
        process.stderr,
        `sidecar exited before owner shutdown (${code ?? signal ?? "unknown"})${tails.length > 0 ? `\n${tails.join("\n")}` : ""}\n`,
      );
      void shutdown("sidecar exit", code === 0 ? 1 : (code ?? 1));
    }
  });

  await completion;
}

try {
  await main();
} catch (error) {
  safeWrite(process.stderr, `local sidecar supervisor failed: ${errorMessage(error)}\n`);
  process.exitCode = 1;
}
