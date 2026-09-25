#!/usr/bin/env bun

import { spawnSync } from "node:child_process";

import { runDatabaseAdmissionPhase } from "./database-admission-phase";
import { DUE_WORK_REPAIR_PENDING_REASON } from "./due-work-repair-pending";

const BATCH = Number(process.env.FLUNCLE_RANK_BATCH ?? "250");
const MAX_CALLS = Number(process.env.FLUNCLE_RANK_MAX_CALLS ?? "8");

export const SOURCE_REPAIRS_PER_RANK_GUARD = 5;
const PHASE_START_BUDGET_MS = 600_000;
const CLI_CHILD_TIMEOUT_MS = 120_000;
const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";
const ADMISSION_OWNER = "fluncle-rank";

export function rankPhaseCap(batch: number, maxCalls: number): number {
  return (maxCalls + 2) * Math.ceil(batch / SOURCE_REPAIRS_PER_RANK_GUARD);
}

const MAX_PHASES = rankPhaseCap(BATCH, MAX_CALLS);

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
  trackSourceMarkersPending?: boolean | null;
};

type RepairOutcome = {
  complete: boolean;
  processed: number;
  scheduled: number;

  trackSourceMarkersPending: boolean | null;
};

type PhaseMode = "drain" | "rank";

type PhaseEnvelope =
  | { kind: "drain"; repair: RepairOutcome }
  | { kind: "rank-pending"; repair: RepairOutcome }
  | { kind: "ranked"; rank: RankSummary; repair: RepairOutcome };

type SweepSummary = {
  admissionOutcome: "completed" | "phase-yielded";
  calls: number;
  catalogueDuplicates: number;
  checked: number;
  corpus: string | null;

  drainComplete: boolean | null;
  drainPhases: number;
  error: string | null;
  errors: number;
  failed: number;
  ok: boolean;
  partial: boolean;
  prioritized: number;
  produced: number;
  quarantined: number;
  rankPending: number;
  reason: string | null;
  remaining: number;
  repairProcessed: number;
  repairScheduled: number;
  repairSteps: number;
  scored: number;
  throttled: boolean;

  trackRepairQueueComplete: boolean | null;
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

function validateRepairOutcome(repair: RepairResponse): RepairOutcome {
  const pending = repair.trackSourceMarkersPending;
  if (
    typeof repair.complete !== "boolean" ||
    (pending !== undefined && pending !== null && typeof pending !== "boolean")
  ) {
    throw new Error("track due-work repair returned an invalid response");
  }
  return {
    complete: repair.complete,
    processed: normalizeCount(repair.processed, "repair processed"),
    scheduled: normalizeCount(repair.scheduled, "repair scheduled"),
    trackSourceMarkersPending: pending ?? null,
  };
}

function repairOnce(): RepairOutcome {
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
    repair.steps !== 1
  ) {
    throw new Error("track due-work repair returned an invalid response");
  }

  return validateRepairOutcome(repair);
}

function rankOnce(): RankSummary {
  return validateRankSummary(
    unwrapRankSummary(
      fluncleJson<RankResponse>(["admin", "catalogue", "rank", "--limit", String(BATCH)]),
    ),
  );
}

function runCriticalPhase(mode: PhaseMode): PhaseEnvelope {
  const repair = repairOnce();
  if (mode === "drain") {
    return { kind: "drain", repair };
  }
  try {
    return { kind: "ranked", rank: rankOnce(), repair };
  } catch (error) {
    if (isMaintenancePending(error)) {
      return { kind: "rank-pending", repair };
    }
    throw error;
  }
}

function parsePhaseEnvelope(stdout: string, mode: PhaseMode): PhaseEnvelope {
  const parsed = JSON.parse(stdout) as Partial<{ kind: unknown; rank: unknown; repair: unknown }>;
  if (typeof parsed.repair !== "object" || parsed.repair === null) {
    throw new Error("rank phase returned an invalid envelope");
  }
  const repair = validateRepairOutcome(parsed.repair as RepairResponse);
  if (mode === "drain" && parsed.kind === "drain") {
    return { kind: "drain", repair };
  }
  if (mode === "rank" && parsed.kind === "rank-pending") {
    return { kind: "rank-pending", repair };
  }
  if (
    mode === "rank" &&
    parsed.kind === "ranked" &&
    typeof parsed.rank === "object" &&
    parsed.rank !== null
  ) {
    return { kind: "ranked", rank: validateRankSummary(parsed.rank as RankSummary), repair };
  }
  throw new Error("rank phase returned an invalid envelope");
}

function admittedPhase(mode: PhaseMode): PhaseEnvelope | undefined {
  const result = runDatabaseAdmissionPhase({
    command: [process.execPath, import.meta.path, "--critical-phase", mode],
    owner: ADMISSION_OWNER,
    yieldRetries: 0,
  });
  if (result.kind === "yielded") {
    return undefined;
  }
  return parsePhaseEnvelope(result.stdout, mode);
}

function createSummary(): SweepSummary {
  return {
    admissionOutcome: "completed",
    calls: 0,
    catalogueDuplicates: 0,
    checked: 0,
    corpus: null,
    drainComplete: null,
    drainPhases: 0,
    error: null,
    errors: 0,
    failed: 0,
    ok: true,
    partial: false,
    prioritized: 0,
    produced: 0,
    quarantined: 0,
    rankPending: 0,
    reason: null,
    remaining: 0,
    repairProcessed: 0,
    repairScheduled: 0,
    repairSteps: 0,
    scored: 0,
    throttled: false,
    trackRepairQueueComplete: null,
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

function applyRepair(summary: SweepSummary, repair: RepairOutcome): void {
  summary.repairSteps += 1;
  summary.repairProcessed += repair.processed;
  summary.repairScheduled += repair.scheduled;
  summary.trackRepairQueueComplete = repair.complete;
}

function markPartial(
  summary: SweepSummary,
  reason: string,
  options: { admissionYield?: boolean; throttled?: boolean } = {},
): void {
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
    }
  } catch (error) {
    if (isMaintenancePending(error)) {
      markPartial(summary, DUE_WORK_REPAIR_PENDING_REASON, { throttled: true });
      return;
    }
    throw error;
  }
}

function drainLastPage(summary: SweepSummary, startedAt: number): void {
  summary.drainComplete = false;

  while (summary.repairSteps < MAX_PHASES) {
    if (performance.now() - startedAt >= PHASE_START_BUDGET_MS) {
      markPartial(summary, "drain_wall_budget");
      return;
    }

    const phase = admittedPhase("drain");
    if (!phase) {
      markPartial(summary, "database_admission", { admissionYield: true, throttled: true });
      return;
    }

    applyRepair(summary, phase.repair);
    summary.drainPhases += 1;
    if (phase.repair.trackSourceMarkersPending === null) {
      markPartial(summary, "drain_unverified");
      return;
    }
    if (!phase.repair.trackSourceMarkersPending) {
      summary.drainComplete = true;
      return;
    }
  }

  markPartial(summary, "drain_phase_budget");
}

function runPhased(summary: SweepSummary): void {
  const startedAt = performance.now();

  let lastAttemptPending = false;

  while (summary.repairSteps < MAX_PHASES) {
    if (performance.now() - startedAt >= PHASE_START_BUDGET_MS) {
      markPartial(summary, "rank_wall_budget", { throttled: lastAttemptPending });
      return;
    }

    const phase = admittedPhase("rank");
    if (!phase) {
      markPartial(summary, "database_admission", { admissionYield: true, throttled: true });
      return;
    }

    applyRepair(summary, phase.repair);
    if (phase.kind === "rank-pending") {
      summary.rankPending += 1;
      lastAttemptPending = true;
      continue;
    }
    if (phase.kind !== "ranked") {
      throw new Error("rank phase returned an invalid envelope");
    }

    lastAttemptPending = false;
    const moved = applyRank(summary, phase.rank);
    if (summary.remaining === 0 || summary.calls >= MAX_CALLS) {
      if (summary.remaining > 0) {
        markPartial(summary, "rank_page_budget");
      }
      if (moved > 0) {
        drainLastPage(summary, startedAt);
      }
      return;
    }
  }

  markPartial(summary, "rank_phase_budget", { throttled: lastAttemptPending });
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
    console.log(JSON.stringify(runCriticalPhase(process.argv[3] === "drain" ? "drain" : "rank")));
  } else if (!main().ok) {
    process.exit(1);
  }
}
