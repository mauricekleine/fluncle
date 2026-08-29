import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SUPERVISOR_PATH = fileURLToPath(new URL("./local-sidecar-supervisor.ts", import.meta.url));

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

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("local libSQL sidecar supervisor", () => {
  it.skipIf(process.platform === "win32")(
    "kills the sidecar and removes its database artifacts when the benchmark owner is killed",
    async () => {
      const testDirectory = await mkdtemp("/tmp/db-performance-owner-death-");
      const scratchDirectory = join(testDirectory, "scratch");
      const sidecarPidPath = join(testDirectory, "sidecar.pid");
      const sidecarStoppedPath = join(testDirectory, "sidecar.stopped");
      const fixturePath = join(scratchDirectory, "fixture.db");
      await mkdir(scratchDirectory);
      await writeFile(fixturePath, "synthetic database artifact");

      const fakeSidecarProgram = `const { writeFile } = await import("node:fs/promises"); await writeFile(${JSON.stringify(sidecarPidPath)}, String(process.pid)); process.once("SIGTERM", async () => { await writeFile(${JSON.stringify(sidecarStoppedPath)}, "stopped"); process.exit(0); }); setInterval(() => undefined, 1000);`;
      const owner = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], {
        stdio: "ignore",
      });
      const ownerPid = owner.pid;
      if (ownerPid === undefined) {
        throw new Error("could not start the benchmark owner fixture");
      }
      const supervisor = spawn(
        "bun",
        [
          SUPERVISOR_PATH,
          "--owner-pid",
          String(ownerPid),
          "--scratch-dir",
          scratchDirectory,
          "--",
          process.execPath,
          "-e",
          fakeSidecarProgram,
        ],
        {
          detached: true,
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
      );
      supervisor.stdout.resume();
      let supervisorStderr = "";
      supervisor.stderr.on("data", (chunk: Uint8Array) => {
        supervisorStderr += Buffer.from(chunk).toString("utf8");
      });
      const supervisorPid = supervisor.pid;
      if (supervisorPid === undefined) {
        throw new Error("could not start the sidecar supervisor fixture");
      }
      let sidecarPid: number | null = null;

      try {
        await waitFor(() => pathExists(sidecarPidPath));
        sidecarPid = Number.parseInt(await readFile(sidecarPidPath, "utf8"), 10);
        if (!Number.isSafeInteger(sidecarPid)) {
          throw new Error("supervisor did not record the sidecar PID");
        }
        expect(supervisor.exitCode).toBeNull();
        expect(supervisor.signalCode).toBeNull();

        const supervisorExited = new Promise<void>((resolve) =>
          supervisor.once("exit", () => resolve()),
        );
        owner.kill("SIGKILL");
        await new Promise<void>((resolve) => owner.once("exit", () => resolve()));
        await waitFor(() => pathExists(sidecarStoppedPath));
        await Promise.race([
          supervisorExited,
          new Promise<never>((_resolve, reject) =>
            setTimeout(
              () => reject(new Error(`supervisor did not exit: ${supervisorStderr}`)),
              5_000,
            ),
          ),
        ]);
        await waitFor(async () => !(await pathExists(scratchDirectory)));
        await waitFor(async () => !(await pathExists(fixturePath)));
        await waitFor(() => !processExists(sidecarPid ?? -1));

        expect(await pathExists(fixturePath)).toBe(false);
        expect(await pathExists(scratchDirectory)).toBe(false);
        expect(await pathExists(sidecarStoppedPath)).toBe(true);
        expect(supervisor.exitCode).toBe(0);
        expect(processExists(sidecarPid)).toBe(false);
      } finally {
        if (owner.exitCode === null && owner.signalCode === null) {
          owner.kill("SIGKILL");
        }
        for (const pid of [supervisorPid, sidecarPid]) {
          if (pid !== null && processExists(pid)) {
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              // The process exited between the liveness check and signal.
            }
          }
        }
        await rm(testDirectory, { force: true, recursive: true });
      }
    },
    10_000,
  );

  it.skipIf(process.platform === "win32")(
    "contains noisy TERM-resistant sidecars after owner death even when owner output pipes close",
    async () => {
      const testDirectory = await mkdtemp("/tmp/db-performance-owner-epipe-");
      const scratchDirectory = join(testDirectory, "scratch");
      const sidecarPidPath = join(testDirectory, "sidecar.pid");
      const fixturePath = join(scratchDirectory, "fixture.db");
      await mkdir(scratchDirectory);
      await writeFile(fixturePath, "synthetic database artifact");

      const fakeSidecarProgram = `const { writeFile } = await import("node:fs/promises"); await writeFile(${JSON.stringify(sidecarPidPath)}, String(process.pid)); process.once("SIGTERM", () => { process.stdout.write("term-noise\\n".repeat(10000)); process.stderr.write("term-error\\n".repeat(10000)); }); setInterval(() => { process.stdout.write("running\\n"); process.stderr.write("still-running\\n"); }, 10);`;
      const owner = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], {
        stdio: "ignore",
      });
      const ownerPid = owner.pid;
      if (ownerPid === undefined) {
        throw new Error("could not start the benchmark owner fixture");
      }
      const supervisor = spawn(
        "bun",
        [
          SUPERVISOR_PATH,
          "--owner-pid",
          String(ownerPid),
          "--scratch-dir",
          scratchDirectory,
          "--",
          process.execPath,
          "-e",
          fakeSidecarProgram,
        ],
        {
          detached: true,
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
      );
      const supervisorPid = supervisor.pid;
      if (supervisorPid === undefined) {
        throw new Error("could not start the sidecar supervisor fixture");
      }
      let sidecarPid: number | null = null;

      try {
        await waitFor(() => pathExists(sidecarPidPath));
        sidecarPid = Number.parseInt(await readFile(sidecarPidPath, "utf8"), 10);
        if (!Number.isSafeInteger(sidecarPid)) {
          throw new Error("supervisor did not record the sidecar PID");
        }

        // Closing the read ends reproduces the window where a SIGKILLed owner can no longer
        // receive supervisor diagnostics. The supervisor must still observe owner death itself.
        supervisor.stdout.destroy();
        supervisor.stderr.destroy();
        const supervisorExited = new Promise<void>((resolve) =>
          supervisor.once("exit", () => resolve()),
        );
        owner.kill("SIGKILL");
        await new Promise<void>((resolve) => owner.once("exit", () => resolve()));
        await Promise.race([
          supervisorExited,
          new Promise<never>((_resolve, reject) =>
            setTimeout(() => reject(new Error("supervisor did not exit")), 6_000),
          ),
        ]);
        await waitFor(() => !processExists(sidecarPid ?? -1));
        await waitFor(async () => !(await pathExists(scratchDirectory)));

        expect(supervisor.exitCode).toBe(0);
        expect(processExists(sidecarPid)).toBe(false);
        expect(await pathExists(fixturePath)).toBe(false);
        expect(await pathExists(scratchDirectory)).toBe(false);
      } finally {
        if (owner.exitCode === null && owner.signalCode === null) {
          owner.kill("SIGKILL");
        }
        for (const pid of [supervisorPid, sidecarPid]) {
          if (pid !== null && processExists(pid)) {
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              // The process exited between the liveness check and signal.
            }
          }
        }
        await rm(testDirectory, { force: true, recursive: true });
      }
    },
    10_000,
  );
});
