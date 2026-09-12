#!/usr/bin/env bun
// The Ear's bounded catalogue-ranking cron. Every database-critical phase first advances one
// track due-work repair step and may rank one page only after that step proves the queue clean.

import { spawnSync } from "node:child_process";

import { runDatabaseAdmissionPhase } from "./database-admission-phase";

const BATCH = Number(process.env.FLUNCLE_RANK_BATCH ?? "250");
const MAX_CALLS = Number(process.env.FLUNCLE_RANK_MAX_CALLS ?? "8");
const SOURCE_REPAIRS_PER_PHASE = 5;
const PHASE_START_BUDGET_MS = 600_000;
const CLI_CHILD_TIMEOUT_MS = 120_000;
const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";
const ADMISSION_OWNER = "fluncle-rank";

// One initial clean proof, then enough phases to drain every marker that the configured rank
// pages can create. The monotonic wall budget remains the tighter bound when phases are slow.
const MAX_REPAIR_PHASES = 1 + MAX_CALLS * Math.ceil(BATCH / SOURCE_REPAIRS_PER_PHASE);

const log = (message: string) => console.error(`[rank-sweep] ${message}`);

type RankSummary = {
  catalogueDuplicates?: number;
  corpus?: string;
  prioritized?: number;
  quarantined?: number;
  remaining?: number;
  scored?: number;
};

type RankResponse = RankSummary & { summary?: RankSummary };

type RepairResponse = {
  action?: string;
  complete?: boolean;
  ok?: boolean;
  processed?: number;
  scheduled?: number;
  steps?: number;
  target?: string;
};

type PhaseEnvelope = {
  kind: "maintenance-pending" | "ranked" | "repaired" | "repair-incomplete";
  rank?: RankSummary;
  repair: Required<Pick<RepairResponse, "complete" | "processed" | "scheduled">>;
};

type SweepSummary = {
  admissionOutcome: "completed" | "phase-yielded";
  calls: number;
  catalogueDuplicates: number;
  checked: number;
  corpus: string | null;
  error: string | null;
  errors: number;
  failed: number;
  maintenanceComplete: boolean;
  maintenanceProcessed: number;
  maintenanceScheduled: number;
  ok: boolean;
  partial: boolean;
  prioritized: number;
  produced: number;
  quarantined: number;
  reason: string | null;
  remaining: number;
  repairPhases: number;
  scored: number;
  throttled: boolean;
};

class FluncleCliError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "FluncleCliError";
  }
}

function unwrapRankSummary(response: RankResponse): RankSummary {
  return response.summary ?? response;
}

function isCliErrorPayload(value: unknown): value is { code: string; message: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { ok?: unknown }).ok === false &&
    typeof (value as { code?: unknown }).code === "string" &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

function isMaintenancePending(error: unknown): boolean {
  return error instanceof FluncleCliError && error.code === "due_work_maintenance_pending";
}

export function fluncleJson<T>(args: string[]): T {
  const result = spawnSync(FLUNCLE_BIN, [...args, "--json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: CLI_CHILD_TIMEOUT_MS,
  });

  if (result.error) {
    throw new Error(`failed to run ${FLUNCLE_BIN}: ${result.error.message}`);
  }

  const code = result.status ?? 1;
  const stdout = result.stdout ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    if (code !== 0) {
      throw new Error(`fluncle ${args.join(" ")} exited ${code}: ${(result.stderr ?? "").trim()}`);
    }
    throw new Error(`fluncle ${args.join(" ")} did not return JSON: ${stdout.slice(0, 200)}`);
  }

  if (code !== 0) {
    if (isCliErrorPayload(parsed)) {
      throw new FluncleCliError(parsed.code, parsed.message);
    }
    throw new Error(`fluncle ${args.join(" ")} exited ${code}`);
  }

  return parsed as T;
}

function validateConfig(): void {
  if (!Number.isInteger(BATCH) || BATCH < 1 || BATCH > 1000) {
    throw new Error("FLUNCLE_RANK_BATCH must be an integer from 1 through 1000");
  }
  if (!Number.isInteger(MAX_CALLS) || MAX_CALLS < 1 || MAX_CALLS > 8) {
    throw new Error("FLUNCLE_RANK_MAX_CALLS must be an integer from 1 through 8");
  }
}

function normalizeCount(value: number | undefined, field: string): number {
  if (value === undefined) {
    return 0;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`rank response ${field} must be a non-negative integer`);
  }
  return value;
}

function validateRankSummary(rank: RankSummary): RankSummary {
  if (!Number.isSafeInteger(rank.remaining) || (rank.remaining ?? -1) < 0) {
    throw new Error("rank response is missing a valid remaining sentinel");
  }
  normalizeCount(rank.scored, "scored");
  normalizeCount(rank.prioritized, "prioritized");
  normalizeCount(rank.quarantined, "quarantined");
  normalizeCount(rank.catalogueDuplicates, "catalogueDuplicates");
  return rank;
}

function repairOnce(): Required<Pick<RepairResponse, "complete" | "processed" | "scheduled">> {
  const repair = fluncleJson<RepairResponse>([
    "admin",
    "projections",
    "advance",
    "--target",
    "track_due_work",
    "--action",
    "repair",
    "--limit",
    "500",
    "--max-steps",
    "1",
    "--no-terminal-status",
  ]);

  if (
    repair.ok !== true ||
    repair.action !== "repair" ||
    repair.target !== "track_due_work" ||
    repair.steps !== 1 ||
    typeof repair.complete !== "boolean"
  ) {
    throw new Error("track due-work repair returned an invalid response");
  }

  return {
    complete: repair.complete,
    processed: normalizeCount(repair.processed, "repair processed"),
    scheduled: normalizeCount(repair.scheduled, "repair scheduled"),
  };
}

function rankOnce(): RankSummary {
  return validateRankSummary(
    unwrapRankSummary(
      fluncleJson<RankResponse>(["admin", "catalogue", "rank", "--limit", String(BATCH)]),
    ),
  );
}

function runCriticalPhase(allowRank: boolean): PhaseEnvelope {
  const repair = repairOnce();
  if (!repair.complete) {
    return { kind: "repair-incomplete", repair };
  }
  if (!allowRank) {
    return { kind: "repaired", repair };
  }

  try {
    return { kind: "ranked", rank: rankOnce(), repair };
  } catch (error) {
    if (isMaintenancePending(error)) {
      return { kind: "maintenance-pending", repair };
    }
    throw error;
  }
}

function admittedPhase(allowRank: boolean): PhaseEnvelope | undefined {
  const result = runDatabaseAdmissionPhase({
    command: [
      process.execPath,
      import.meta.path,
      "--critical-phase",
      allowRank ? "rank" : "repair",
    ],
    owner: ADMISSION_OWNER,
    yieldRetries: 0,
  });
  if (result.kind === "yielded") {
    return undefined;
  }
  return JSON.parse(result.stdout) as PhaseEnvelope;
}

function createSummary(): SweepSummary {
  return {
    admissionOutcome: "completed",
    calls: 0,
    catalogueDuplicates: 0,
    checked: 0,
    corpus: null,
    error: null,
    errors: 0,
    failed: 0,
    maintenanceComplete: false,
    maintenanceProcessed: 0,
    maintenanceScheduled: 0,
    ok: true,
    partial: false,
    prioritized: 0,
    produced: 0,
    quarantined: 0,
    reason: null,
    remaining: 0,
    repairPhases: 0,
    scored: 0,
    throttled: false,
  };
}

function applyRank(summary: SweepSummary, tick: RankSummary): number {
  const scored = normalizeCount(tick.scored, "scored");
  const prioritized = normalizeCount(tick.prioritized, "prioritized");
  const quarantined = normalizeCount(tick.quarantined, "quarantined");
  summary.calls += 1;
  summary.corpus = tick.corpus ?? summary.corpus;
  summary.scored += scored;
  summary.prioritized += prioritized;
  summary.quarantined += quarantined;
  summary.catalogueDuplicates += normalizeCount(tick.catalogueDuplicates, "catalogueDuplicates");
  summary.remaining = tick.remaining ?? 0;
  return scored + prioritized + quarantined;
}

function markPartial(
  summary: SweepSummary,
  reason: string,
  options: {
    admissionYield?: boolean;
    preserveMaintenanceComplete?: boolean;
    throttled?: boolean;
  } = {},
): void {
  if (!options.preserveMaintenanceComplete) {
    summary.maintenanceComplete = false;
  }
  summary.partial = true;
  summary.reason = reason;
  summary.remaining = Math.max(1, summary.remaining);
  summary.throttled = options.throttled ?? false;
  if (options.admissionYield) {
    summary.admissionOutcome = "phase-yielded";
  }
}

function runLegacy(summary: SweepSummary): void {
  try {
    const moved = applyRank(summary, rankOnce());
    if (moved > 0 || summary.remaining > 0) {
      markPartial(summary, "rolling_admission_compatibility");
    } else {
      summary.maintenanceComplete = true;
    }
  } catch (error) {
    if (isMaintenancePending(error)) {
      markPartial(summary, "due_work_maintenance_pending", { throttled: true });
      return;
    }
    throw error;
  }
}

function runPhased(summary: SweepSummary): void {
  const startedAt = performance.now();
  let allowRank = true;
  let cleanupNeeded = false;

  while (summary.repairPhases < MAX_REPAIR_PHASES) {
    if (performance.now() - startedAt >= PHASE_START_BUDGET_MS) {
      markPartial(summary, "rank_wall_budget");
      return;
    }

    const phase = admittedPhase(allowRank);
    if (!phase) {
      markPartial(summary, "database_admission", { admissionYield: true, throttled: true });
      return;
    }

    summary.repairPhases += 1;
    summary.maintenanceProcessed += phase.repair.processed;
    summary.maintenanceScheduled += phase.repair.scheduled;

    if (phase.kind === "repair-incomplete") {
      cleanupNeeded = true;
      continue;
    }
    if (phase.kind === "maintenance-pending") {
      markPartial(summary, "due_work_maintenance_pending", { throttled: true });
      return;
    }
    if (phase.kind === "repaired") {
      summary.maintenanceComplete = true;
      if (!allowRank) {
        if (summary.remaining > 0) {
          markPartial(summary, "rank_page_budget", { preserveMaintenanceComplete: true });
        }
        return;
      }
      throw new Error("rank phase omitted its rank response");
    }
    if (phase.kind !== "ranked" || !phase.rank) {
      throw new Error("rank phase returned an invalid envelope");
    }

    cleanupNeeded = applyRank(summary, validateRankSummary(phase.rank)) > 0;
    if (summary.remaining > 0 && summary.calls < MAX_CALLS) {
      allowRank = true;
      continue;
    }
    if (!cleanupNeeded) {
      summary.maintenanceComplete = true;
      if (summary.remaining > 0) {
        markPartial(summary, "rank_page_budget", { preserveMaintenanceComplete: true });
      }
      return;
    }
    allowRank = false;
  }

  if (cleanupNeeded || summary.remaining > 0) {
    markPartial(summary, "repair_phase_budget");
  } else {
    summary.maintenanceComplete = true;
  }
}

export function main(): SweepSummary {
  const summary = createSummary();
  try {
    validateConfig();
    if (process.env.FLUNCLE_ADMISSION_RUNNER_PID) {
      runLegacy(summary);
    } else {
      runPhased(summary);
    }
  } catch (error) {
    summary.ok = false;
    summary.errors = 1;
    summary.error = error instanceof Error ? error.message : String(error);
    summary.maintenanceComplete = false;
    summary.remaining = Math.max(1, summary.remaining);
    log(`rank sweep failed: ${summary.error}`);
  }

  summary.checked = summary.scored + summary.prioritized + summary.quarantined;
  summary.produced = summary.checked;
  console.log(JSON.stringify(summary));
  return summary;
}

if (import.meta.main) {
  if (process.argv[2] === "--critical-phase") {
    console.log(JSON.stringify(runCriticalPhase(process.argv[3] === "rank")));
  } else if (!main().ok) {
    process.exit(1);
  }
}
