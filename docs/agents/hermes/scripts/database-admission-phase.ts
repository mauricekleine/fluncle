import { spawnSync } from "node:child_process";
import { join } from "node:path";

export const DATABASE_ADMISSION_PHASE_YIELD_EXIT = 75;

export type DatabaseAdmissionPhaseResult =
  | Readonly<{ attempts: number; kind: "completed"; stdout: string }>
  | Readonly<{ attempts: number; kind: "yielded"; yieldReason: string | null }>;

export const ADMISSION_YIELD_REASONS: readonly string[] = [
  "authentication-failed",
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

type DatabaseAdmissionPhaseInput = Readonly<{
  command: readonly string[];
  owner: string;

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
