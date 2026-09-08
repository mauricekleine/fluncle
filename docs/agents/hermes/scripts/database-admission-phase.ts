import { spawnSync } from "node:child_process";
import { join } from "node:path";

export const DATABASE_ADMISSION_PHASE_YIELD_EXIT = 75;

export type DatabaseAdmissionPhaseResult =
  | Readonly<{ attempts: number; kind: "completed"; stdout: string }>
  | Readonly<{ attempts: number; kind: "yielded" }>;

type DatabaseAdmissionPhaseInput = Readonly<{
  command: readonly string[];
  owner: string;
  /** A yielded phase may be replayed only when the registry's mutation policy permits it. */
  yieldRetries: 0 | 1;
}>;

function phaseRunner(): string {
  return (
    process.env.DATABASE_ADMISSION_RUNNER ??
    join(import.meta.dirname, "database-admission-runner.sh")
  );
}

/** Run one bounded database-critical command and discard all command output on a yield. */
export function runDatabaseAdmissionPhase(
  input: DatabaseAdmissionPhaseInput,
): DatabaseAdmissionPhaseResult {
  if (input.command.length === 0) {
    throw new Error("database admission phase command is empty");
  }

  const maximumAttempts = input.yieldRetries + 1;

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
      if (attempt < maximumAttempts) {
        continue;
      }

      return { attempts: attempt, kind: "yielded" };
    }
    if (result.status !== 0) {
      throw new Error(`database admission phase exited ${result.status ?? "without a status"}`);
    }

    return { attempts: attempt, kind: "completed", stdout: result.stdout ?? "" };
  }

  return { attempts: maximumAttempts, kind: "yielded" };
}

/** A phase yield is designed backpressure: fresh and visible, but neither success nor failure. */
export function databaseAdmissionYieldSummary(fields: Record<string, unknown> = {}) {
  return {
    admissionOutcome: "phase-yielded",
    errors: 0,
    gateState: "paused",
    ok: true,
    produced: 0,
    reason: "database_admission",
    throttled: true,
    ...fields,
  };
}
