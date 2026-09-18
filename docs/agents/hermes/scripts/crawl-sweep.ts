#!/usr/bin/env bun
// Database-critical crawl work is phase-scoped. Provider waits happen between prepare and commit,
// outside the exclusive writer admission, while a signed claim snapshot fences every later write.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDatabaseAdmissionPhase } from "./database-admission-phase";
import {
  DUE_WORK_MAINTENANCE_PENDING_CODE,
  DueWorkRepairPendingError,
  dueWorkRepairPendingGate,
  isDueWorkRepairPending,
  throwIfCliRepairPending,
} from "./due-work-repair-pending";

const NODES = Number(process.env.FLUNCLE_CRAWL_NODES ?? "10");
const MAX_HOP = Number(process.env.FLUNCLE_CRAWL_MAX_HOP ?? "2");
const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";
const ADMISSION_OWNER = "fluncle-crawl";
const log = (message: string) => console.error(`[crawl-sweep] ${message}`);

type JsonObject = Record<string, unknown>;
type PhaseEnvelope = JsonObject & {
  kind?: "initialized" | "unavailable";
  ok?: boolean;
  phase?: string;
};
type PrepareEnvelope = PhaseEnvelope & {
  frontierPending?: number;
  items?: { nodeId: string; preparedToken: string }[];
  kind?: "drained" | "prepared" | "unavailable";
};
type FetchEnvelope = PhaseEnvelope & {
  commitToken?: string;
  operationId?: string;
  operationKey?: string;
  requestDigest?: string;
};
type ReceiptEnvelope = PhaseEnvelope & {
  receipt?: { outcome?: string; result?: JsonObject; state?: string };
};
type SweepSummary = {
  admissionOutcome: string;
  checked: number;
  error: string | null;
  errors: number;
  expanded: number;
  failed: number;
  gateState: "active" | "disabled" | "paused" | null;
  labelsDiscovered: string[];
  ok: boolean;
  partial: boolean;
  pending: number;
  produced: number;
  queueDepth: number | undefined;
  reason: string | null;
  reconciledCommits: number;
  staleRejected: number;
  throttled: boolean;
  tracksFound: number;
  tracksSkipped: number;
  tracksWritten: number;
};

export function fluncleJson<T>(args: string[]): T {
  const result = spawnSync(FLUNCLE_BIN, [...args, "--json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`failed to spawn ${FLUNCLE_BIN}: ${result.error.message}`);
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
  throwIfCliRepairPending(`fluncle ${args.join(" ")}`, code, stdout);
  if (code !== 0 && isCliErrorPayload(parsed)) {
    throw new Error(`fluncle ${args.join(" ")} failed (${parsed.code}): ${parsed.message}`);
  }
  return parsed as T;
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

function phaseFile(directory: string, name: string, body: JsonObject): string {
  const path = join(directory, `${name}.json`);
  writeFileSync(path, JSON.stringify(body), { mode: 0o600 });
  return path;
}

function directPhase<T>(directory: string, name: string, body: JsonObject): T {
  return fluncleJson<T>([
    "admin",
    "catalogue",
    "crawl",
    "--phase-file",
    phaseFile(directory, name, body),
  ]);
}

// A non-zero phase exit reads as a failed phase, so a phase the Worker deferred cannot simply fail
// its child: it carries the typed answer across the admission boundary as this exit-zero envelope,
// which the parent recognizes on both the kind and the Worker's own body code and re-raises as the
// shared pending error. Any other envelope stays an ordinary phase result.
const REPAIR_PENDING_PHASE_KIND = "repair-pending";

function repairPendingEnvelope(): JsonObject {
  return { code: DUE_WORK_MAINTENANCE_PENDING_CODE, kind: REPAIR_PENDING_PHASE_KIND, ok: false };
}

function isRepairPendingEnvelope(value: unknown): boolean {
  const envelope = value as { code?: unknown; kind?: unknown } | null;
  return (
    typeof envelope === "object" &&
    envelope !== null &&
    envelope.kind === REPAIR_PENDING_PHASE_KIND &&
    envelope.code === DUE_WORK_MAINTENANCE_PENDING_CODE
  );
}

function runCriticalPhase(file: string): JsonObject {
  try {
    return fluncleJson<JsonObject>(["admin", "catalogue", "crawl", "--phase-file", file]);
  } catch (error) {
    if (isDueWorkRepairPending(error)) {
      return repairPendingEnvelope();
    }
    throw error;
  }
}

function admittedPhase<T>(directory: string, name: string, body: JsonObject): T | undefined {
  const result = runDatabaseAdmissionPhase({
    command: [
      process.execPath,
      import.meta.path,
      "--critical-phase",
      phaseFile(directory, name, body),
    ],
    owner: ADMISSION_OWNER,
    yieldRetries: 0,
  });
  if (result.kind === "yielded") {
    return undefined;
  }
  const parsed: unknown = JSON.parse(result.stdout);
  if (isRepairPendingEnvelope(parsed)) {
    throw new DueWorkRepairPendingError(`crawl ${name} phase`);
  }
  return parsed as T;
}

function reconcileCommit(
  fetch: FetchEnvelope,
): { kind: "retry" | "terminal" | "unknown"; state?: string } | undefined {
  const { operationId, operationKey, requestDigest } = fetch;
  if (!operationId || !operationKey || !requestDigest) {
    return { kind: "unknown" };
  }
  const result = runDatabaseAdmissionPhase({
    command: [
      FLUNCLE_BIN,
      "admin",
      "receipts",
      "reconcile",
      operationId,
      operationKey,
      requestDigest,
      "--json",
    ],
    owner: ADMISSION_OWNER,
    yieldRetries: 0,
  });
  if (result.kind === "yielded") {
    return undefined;
  }
  const parsed = JSON.parse(result.stdout) as { receipt?: { outcome?: string; state?: string } };
  if (parsed.receipt?.outcome === "safely-retryable") {
    return { kind: "retry" };
  }
  if (parsed.receipt?.state === "committed" || parsed.receipt?.state === "rejected") {
    return { kind: "terminal", state: parsed.receipt.state };
  }
  return { kind: "unknown" };
}

function legacyPass(): JsonObject {
  return fluncleJson<JsonObject>([
    "admin",
    "catalogue",
    "crawl",
    "--limit",
    String(NODES),
    "--max-hop",
    String(MAX_HOP),
  ]);
}

function validateConfig(): void {
  if (!Number.isInteger(NODES) || NODES < 1 || NODES > 60) {
    throw new Error("FLUNCLE_CRAWL_NODES must be an integer from 1 through 60");
  }
  if (!Number.isInteger(MAX_HOP) || MAX_HOP < 0 || MAX_HOP > 3) {
    throw new Error("FLUNCLE_CRAWL_MAX_HOP must be an integer from 0 through 3");
  }
}

function createSummary(): SweepSummary {
  return {
    admissionOutcome: "completed",
    checked: 0,
    error: null,
    errors: 0,
    expanded: 0,
    failed: 0,
    gateState: null,
    labelsDiscovered: [],
    ok: true,
    partial: false,
    pending: 0,
    produced: 0,
    queueDepth: undefined,
    reason: null,
    reconciledCommits: 0,
    staleRejected: 0,
    throttled: false,
    tracksFound: 0,
    tracksSkipped: 0,
    tracksWritten: 0,
  };
}

function recordFailure(summary: SweepSummary, error: unknown): void {
  summary.ok = false;
  summary.errors = 1;
  summary.error = error instanceof Error ? error.message : String(error);
  log(`crawl pass failed: ${summary.error}`);
}

/**
 * The Worker deferred a guarded crawl read while due-work repair converges. That is designed
 * backpressure, never a run failure: the deferred read still advanced the repair its budget allowed,
 * so the tick stops cleanly, exits zero, and names the cause for the run ledger.
 */
function recordRepairPending(summary: SweepSummary): void {
  const gate = dueWorkRepairPendingGate(summary);
  summary.gateState = gate.gateState;
  summary.partial = summary.partial || gate.partial;
  summary.reason = gate.reason;
  summary.throttled = gate.throttled;
  log("crawl pass paused: due-work repair is still converging");
}

function recordPhaseYield(summary: SweepSummary): void {
  summary.admissionOutcome = "phase-yielded";
  summary.gateState = "paused";
  summary.partial = summary.partial || summary.checked > 0 || summary.produced > 0;
  summary.reason = "database_admission";
  summary.throttled = true;
}

function applyLegacyPass(summary: SweepSummary, pass: JsonObject): void {
  summary.expanded = Number(pass.expanded ?? 0);
  const attemptedFailures = Number(pass.failed ?? 0);
  summary.failed = Math.max(0, attemptedFailures - (pass.rateLimited === true ? 1 : 0));
  summary.checked = summary.expanded + attemptedFailures;
  summary.produced = summary.expanded;
  summary.labelsDiscovered = Array.isArray(pass.labelsDiscovered)
    ? pass.labelsDiscovered.filter((label): label is string => typeof label === "string")
    : [];
  summary.pending = Number(pass.frontierPending ?? 0);
  summary.queueDepth = summary.pending;
  summary.throttled = pass.rateLimited === true;
  summary.tracksFound = Number(pass.tracksFound ?? 0);
  summary.tracksWritten = Number(pass.tracksWritten ?? 0);
  summary.tracksSkipped = Number(pass.tracksSkipped ?? 0);
}

function applyReceipt(summary: SweepSummary, committed: ReceiptEnvelope): boolean {
  const receipt = committed.receipt;
  if (receipt?.outcome === "rejected") {
    summary.staleRejected += 1;
    summary.checked += 1;
    return false;
  }
  if (receipt?.outcome !== "committed" || !receipt.result) {
    throw new Error(`crawl commit is ${receipt?.outcome ?? "invalid"}`);
  }
  const result = receipt.result;
  const expanded = Number(result.expanded ?? 0);
  const attemptedFailures = Number(result.failed ?? 0);
  summary.expanded += expanded;
  summary.failed += Math.max(0, attemptedFailures - (result.rateLimited === true ? 1 : 0));
  summary.checked += expanded + attemptedFailures;
  summary.produced = summary.expanded;
  summary.labelsDiscovered.push(
    ...(Array.isArray(result.labelsDiscovered)
      ? result.labelsDiscovered.filter((label): label is string => typeof label === "string")
      : []),
  );
  summary.tracksFound += Number(result.tracksFound ?? 0);
  summary.tracksWritten += Number(result.tracksWritten ?? 0);
  summary.tracksSkipped += Number(result.tracksSkipped ?? 0);
  if (result.rateLimited === true) {
    summary.throttled = true;
    return false;
  }
  return true;
}

function commitFetched(
  directory: string,
  index: number,
  fetched: FetchEnvelope,
  summary: SweepSummary,
): ReceiptEnvelope | undefined {
  const { commitToken, operationId, operationKey, requestDigest } = fetched;
  if (!commitToken || !operationId || !operationKey || !requestDigest) {
    throw new Error("crawl provider phase returned incomplete operation coordinates");
  }
  const commitBody = { commitToken, operationId, operationKey, phase: "commit", requestDigest };
  try {
    const committed = admittedPhase<ReceiptEnvelope>(directory, `commit-${index}`, commitBody);
    if (!committed) {
      recordPhaseYield(summary);
    }
    return committed;
  } catch (error) {
    // A deferred commit phase never landed a write, so there is no receipt to reconcile.
    if (isDueWorkRepairPending(error)) {
      throw error;
    }
    const reconciliation = reconcileCommit(fetched);
    if (!reconciliation) {
      recordPhaseYield(summary);
      return undefined;
    }
    if (reconciliation.kind === "retry") {
      const retried = admittedPhase<ReceiptEnvelope>(
        directory,
        `commit-retry-${index}`,
        commitBody,
      );
      if (!retried) {
        recordPhaseYield(summary);
      }
      return retried;
    }
    if (reconciliation.kind === "unknown") {
      throw error;
    }

    summary.reconciledCommits += 1;
    summary.admissionOutcome = "commit-result-reconciled";
    try {
      // The terminal receipt proves the effect is settled. Repeating the same operation
      // coordinates can only read its cached result, preserving exact summary counts.
      const cached = admittedPhase<ReceiptEnvelope>(
        directory,
        `commit-result-${index}`,
        commitBody,
      );
      if (cached) {
        return cached;
      }
    } catch {
      // Fall through to the same honest partial summary as a yielded cached-result read.
    }
    summary.admissionOutcome = "commit-result-unknown";
    summary.error = "a terminal crawl commit was reconciled but its counters are unavailable";
    summary.partial = true;
    return undefined;
  }
}

function processPreparedItem(
  directory: string,
  index: number,
  preparedToken: string,
  summary: SweepSummary,
): boolean {
  const fetched = directPhase<FetchEnvelope>(directory, `fetch-${index}`, {
    phase: "fetch",
    preparedToken,
  });
  const committed = commitFetched(directory, index, fetched, summary);
  return committed === undefined ? false : applyReceipt(summary, committed);
}

export function main(): void {
  const summary = createSummary();
  try {
    validateConfig();
  } catch (error) {
    recordFailure(summary, error);
    console.log(JSON.stringify(summary));
    process.exitCode = 1;
    return;
  }

  // A rolling old unit already owns the whole-lifetime lease. Nesting phase admission would
  // deadlock; retain its single request only for that inherited runner context.
  if (process.env.FLUNCLE_ADMISSION_RUNNER_PID) {
    try {
      applyLegacyPass(summary, legacyPass());
    } catch (error) {
      if (isDueWorkRepairPending(error)) {
        recordRepairPending(summary);
      } else {
        recordFailure(summary, error);
      }
    }
    console.log(JSON.stringify(summary));
    if (!summary.ok) {
      process.exitCode = 1;
    }
    return;
  }

  const directory = mkdtempSync(join(tmpdir(), "fluncle-crawl-phase-"));

  try {
    const initialized = admittedPhase<PhaseEnvelope>(directory, "initialize", {
      phase: "initialize",
    });
    if (!initialized) {
      recordPhaseYield(summary);
      console.log(JSON.stringify(summary));
      return;
    }
    if (initialized.ok !== true || initialized.phase !== "initialize") {
      throw new Error("crawl initialization returned an invalid phase envelope");
    }
    if (initialized.kind === "unavailable") {
      summary.admissionOutcome = "cutover-disabled";
      summary.gateState = "disabled";
      summary.reason = "crawl_due_cutover_disabled";
      console.log(JSON.stringify(summary));
      return;
    }
    if (initialized.kind !== "initialized") {
      throw new Error(`crawl initialization is ${initialized.kind ?? "invalid"}`);
    }
    summary.gateState = "active";

    let processed = 0;
    while (processed < NODES) {
      const prepared = admittedPhase<PrepareEnvelope>(directory, `prepare-${processed}`, {
        limit: Math.min(2, NODES - processed),
        maxHop: MAX_HOP,
        phase: "prepare",
      });
      if (!prepared) {
        recordPhaseYield(summary);
        break;
      }
      summary.pending = prepared.frontierPending ?? summary.pending;
      summary.queueDepth = summary.pending;
      if (prepared.kind === "drained") {
        break;
      }
      if (prepared.kind !== "prepared" || !prepared.items || prepared.items.length === 0) {
        throw new Error(`crawl prepare is ${prepared.kind ?? "invalid"}`);
      }
      for (const item of prepared.items) {
        const shouldContinue = processPreparedItem(
          directory,
          processed,
          item.preparedToken,
          summary,
        );
        processed += 1;
        if (!shouldContinue) {
          processed = NODES;
          break;
        }
      }
    }
  } catch (error) {
    if (isDueWorkRepairPending(error)) {
      recordRepairPending(summary);
    } else {
      recordFailure(summary, error);
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }

  console.log(JSON.stringify(summary));
  if (!summary.ok) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  const criticalIndex = process.argv.indexOf("--critical-phase");
  const file = criticalIndex >= 0 ? process.argv[criticalIndex + 1] : undefined;
  if (file) {
    console.log(JSON.stringify(runCriticalPhase(file)));
  } else {
    main();
  }
}
