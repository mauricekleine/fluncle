import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";

export const DATABASE_ADMISSION_PHASE_YIELD_EXIT = 75;

export type DatabaseAdmissionPhaseResult =
  | Readonly<{ attempts: number; kind: "completed"; stdout: string }>
  | Readonly<{ attempts: number; kind: "yielded"; yieldReason: string | null }>;

export const ADMISSION_YIELD_REASONS: readonly string[] = [
  "authentication-failed",
  "breaker-open",
  "containment-unavailable",
  "coordinator-unavailable",
  "database-busy",
  "database-health",
  "direct-read-latency",
  "enforcement-not-active",
  "gateway-transport",
  "heartbeat-deadline",
  "invalid-grant",
  "public-latency",
  "queue",
  "write-latency",
];

export function parseAdmissionYieldReason(stderr: string): string | null {
  let reason: string | null = null;

  for (const line of stderr.split("\n")) {
    if (!line.includes('"event":"database.admission.runner"')) {
      continue;
    }

    const match = /"yield_reason":"([^"]*)"/.exec(line);
    const word = match?.[1];

    if (word !== undefined && ADMISSION_YIELD_REASONS.includes(word)) {
      reason = word;
    }
  }

  return reason;
}

let lastYieldReason: string | null = null;
const activePhaseStops = new Set<() => Promise<void>>();
let admissionPhasesStopping = false;

export async function stopDatabaseAdmissionPhases(): Promise<void> {
  admissionPhasesStopping = true;
  await Promise.all([...activePhaseStops].map((stop) => stop()));
}

type DatabaseAdmissionPhaseInput = Readonly<{
  command: readonly string[];
  owner: string;
  signal?: AbortSignal;

  yieldRetries: 0 | 1;
}>;

function phaseRunner(): string {
  return (
    process.env.DATABASE_ADMISSION_RUNNER ??
    join(import.meta.dirname, "database-admission-runner.sh")
  );
}

export function runDatabaseAdmissionPhase(
  input: DatabaseAdmissionPhaseInput,
): DatabaseAdmissionPhaseResult {
  if (input.command.length === 0) {
    throw new Error("database admission phase command is empty");
  }

  const maximumAttempts = input.yieldRetries + 1;

  lastYieldReason = null;

  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const result = spawnSync(
      "bash",
      [phaseRunner(), "phase", input.owner, "--", ...input.command],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );

    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    if (result.error) {
      throw new Error(`failed to spawn database admission runner: ${result.error.message}`);
    }
    if (result.status === DATABASE_ADMISSION_PHASE_YIELD_EXIT) {
      lastYieldReason = parseAdmissionYieldReason(result.stderr ?? "");

      if (attempt < maximumAttempts) {
        continue;
      }

      return { attempts: attempt, kind: "yielded", yieldReason: lastYieldReason };
    }
    if (result.status !== 0) {
      throw new Error(`database admission phase exited ${result.status ?? "without a status"}`);
    }

    return { attempts: attempt, kind: "completed", stdout: result.stdout ?? "" };
  }

  return { attempts: maximumAttempts, kind: "yielded", yieldReason: lastYieldReason };
}

export async function runDatabaseAdmissionPhaseAsync(
  input: DatabaseAdmissionPhaseInput,
): Promise<DatabaseAdmissionPhaseResult> {
  if (input.command.length === 0) {
    throw new Error("database admission phase command is empty");
  }

  const maximumAttempts = input.yieldRetries + 1;
  lastYieldReason = null;

  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    if (admissionPhasesStopping) {
      throw new Error("database admission phase stopped for shutdown");
    }
    if (input.signal?.aborted) {
      throw new Error("database admission phase aborted before it started");
    }
    const result = await new Promise<{ status: number | null; stderr: string; stdout: string }>(
      (resolve, reject) => {
        const child = spawn("bash", [phaseRunner(), "phase", input.owner, "--", ...input.command], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let resolveClosed: (() => void) | undefined;
        const closed = new Promise<void>((resolve) => {
          resolveClosed = resolve;
        });
        const stop = async () => {
          child.kill("SIGTERM");
          await closed;
        };
        activePhaseStops.add(stop);
        const abort = () => child.kill("SIGTERM");
        input.signal?.addEventListener("abort", abort, { once: true });
        const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
        const forwardSignal = (signal: NodeJS.Signals) => child.kill(signal);
        const listeners = signals.map((signal) => {
          const listener = () => forwardSignal(signal);
          process.on(signal, listener);
          return { listener, signal };
        });
        let stderr = "";
        let stdout = "";
        let outputTooLarge = false;

        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          if (outputTooLarge) {
            return;
          }
          stdout += chunk;
          if (stdout.length > 64 * 1024 * 1024) {
            outputTooLarge = true;
            child.kill("SIGTERM");
          }
        });
        child.stderr.on("data", (chunk: string) => {
          process.stderr.write(chunk);
          if (outputTooLarge) {
            return;
          }
          stderr += chunk;
          if (stderr.length > 64 * 1024 * 1024) {
            outputTooLarge = true;
            child.kill("SIGTERM");
          }
        });
        child.once("error", (error) => {
          reject(new Error(`failed to spawn database admission runner: ${error.message}`));
        });
        child.once("close", (status) => {
          activePhaseStops.delete(stop);
          input.signal?.removeEventListener("abort", abort);
          resolveClosed?.();
          for (const { listener, signal } of listeners) {
            process.off(signal, listener);
          }
          if (outputTooLarge) {
            reject(new Error("database admission phase output exceeded 64 MiB"));
            return;
          }
          resolve({ status, stderr, stdout });
        });
      },
    );

    if (result.status === DATABASE_ADMISSION_PHASE_YIELD_EXIT) {
      lastYieldReason = parseAdmissionYieldReason(result.stderr);
      if (attempt < maximumAttempts) {
        continue;
      }
      return { attempts: attempt, kind: "yielded", yieldReason: lastYieldReason };
    }
    if (result.status !== 0) {
      throw new Error(`database admission phase exited ${result.status ?? "without a status"}`);
    }
    return { attempts: attempt, kind: "completed", stdout: result.stdout };
  }

  return { attempts: maximumAttempts, kind: "yielded", yieldReason: lastYieldReason };
}

export function databaseAdmissionYieldSummary(fields: Record<string, unknown> = {}) {
  return {
    admissionOutcome: "phase-yielded",
    ...(lastYieldReason === null ? {} : { admissionYieldReason: lastYieldReason }),
    errors: 0,
    gateState: "paused",
    ok: true,
    produced: 0,
    reason: "database_admission",
    throttled: true,
    ...fields,
  };
}
