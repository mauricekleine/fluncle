#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDatabaseAdmissionPhase } from "./database-admission-phase";
import {
  type CrawlFetchPlan,
  type MusicbrainzFetchResult,
  runCrawlFetchPlan,
} from "./musicbrainz-fetch";
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

const BOX_FETCH = process.env.FLUNCLE_CRAWL_BOX_FETCH !== "0";

const PREPARE_LIMIT = 6;

const MAX_THROTTLES = 3;

const THROTTLE_PAUSE_MS = Number(process.env.FLUNCLE_CRAWL_THROTTLE_PAUSE_MS ?? "45000");
const THROTTLE_PAUSE_MAX_MS = 120_000;

const WALL_BUDGET_MS = Number(process.env.FLUNCLE_CRAWL_WALL_BUDGET_MS ?? "840000");
const WALL_BUDGET_MAX_MS = 1_000_000;

const log = (message: string) => console.error(`[crawl-sweep] ${message}`);

function sleepSync(ms: number): void {
  if (ms > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }
}

type JsonObject = Record<string, unknown>;
type PhaseEnvelope = JsonObject & {
  kind?: "initialized" | "unavailable";
  ok?: boolean;
  phase?: string;
};
type PrepareEnvelope = PhaseEnvelope & {
  boxFetch?: boolean;
  capabilities?: CommitBatchCapabilities;
  frontierPending?: number;
  storableReady?: boolean | null;
  items?: {
    fetchPlan?: CrawlFetchPlan;
    nodeId: string;
    nodeKind?: "artist" | "label" | "release";
    preparedToken: string;
  }[];
  kind?: "drained" | "prepared" | "unavailable";
};
type FetchEnvelope = PhaseEnvelope & {
  commitToken?: string;
  operationId?: string;
  operationKey?: string;

  rateLimited?: boolean;
  requestDigest?: string;
};
type CommitBatchCapabilities = {
  commitBatchLimit?: number;
  commitBatchMaxTotalBytes?: number;
};
type CommitBatchReceipt = {
  elapsedMs?: number;
  error?: string;
  operationKey?: string;
  outcome?: string;
  replayed?: boolean;
  result?: JsonObject;
  state?: string;
};
type CommitBatchEnvelope = PhaseEnvelope & {
  deferred?: number;
  receipts?: CommitBatchReceipt[];
};
type ReceiptEnvelope = PhaseEnvelope & {
  receipt?: { outcome?: string; result?: JsonObject; state?: string };
};
type SweepSummary = {
  admissionOutcome: string;
  blockedReason:
    | "database_admission"
    | "due_work_repair_pending"
    | "label_gate"
    | "mb_throttled"
    | "no_storable_work"
    | null;

  boxFetch: boolean;

  boxFetched: number;
  checked: number;
  error: string | null;
  errors: number;
  expanded: number;
  failed: number;
  gateState: "active" | "disabled" | "paused" | null;
  labelsDiscovered: string[];

  leases: number;

  itemMsMax?: number;
  itemMsP50?: number;
  itemSamples?: number;
  ok: boolean;
  partial: boolean;
  pending: number;
  produced: number;
  queueDepth: number | undefined;
  reason: string | null;
  reconciledCommits: number;
  releaseDetailsStored: number;
  requestsByKind: Record<
    "artist_browse" | "label_browse" | "rearm_probe" | "release_detail" | "seed_search",
    number
  >;
  staleRejected: number;
  storableReady: boolean | null;
  throttled: boolean;

  throttles: number;
  tracksFound: number;
  tracksSkipped: number;

  tracksSkippedArtistRule: number;

  tracksSkippedHeld: number;

  tracksSkippedLabelGate: number;
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

function runCriticalCommitBatch(file: string): JsonObject {
  try {
    return fluncleJson<JsonObject>(["admin", "catalogue", "commit-nodes", "--file", file]);
  } catch (error) {
    if (isDueWorkRepairPending(error)) {
      return repairPendingEnvelope();
    }
    throw error;
  }
}

const itemTiming: number[] = [];

export function summariseItemTiming(
  samples: readonly number[],
): { itemMsMax: number; itemMsP50: number; itemSamples: number } | undefined {
  const sorted = [...samples]
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);

  if (sorted.length === 0) {
    return undefined;
  }

  return {
    itemMsMax: sorted[sorted.length - 1] ?? 0,
    itemMsP50: sorted[Math.floor((sorted.length - 1) / 2)] ?? 0,
    itemSamples: sorted.length,
  };
}

let admittedPhaseCount = 0;

function admittedPhase<T>(
  directory: string,
  name: string,
  body: JsonObject,
  flag: "--critical-commit-batch" | "--critical-phase" = "--critical-phase",
): T | undefined {
  admittedPhaseCount += 1;
  const result = runDatabaseAdmissionPhase({
    command: [process.execPath, import.meta.path, flag, phaseFile(directory, name, body)],
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
  if (
    !Number.isInteger(THROTTLE_PAUSE_MS) ||
    THROTTLE_PAUSE_MS < 0 ||
    THROTTLE_PAUSE_MS > THROTTLE_PAUSE_MAX_MS
  ) {
    throw new Error(
      `FLUNCLE_CRAWL_THROTTLE_PAUSE_MS must be an integer from 0 through ${THROTTLE_PAUSE_MAX_MS}`,
    );
  }
  if (
    !Number.isInteger(WALL_BUDGET_MS) ||
    WALL_BUDGET_MS < 1_000 ||
    WALL_BUDGET_MS > WALL_BUDGET_MAX_MS
  ) {
    throw new Error(
      `FLUNCLE_CRAWL_WALL_BUDGET_MS must be an integer from 1000 through ${WALL_BUDGET_MAX_MS}`,
    );
  }
}

function createSummary(): SweepSummary {
  return {
    admissionOutcome: "completed",
    blockedReason: null,
    boxFetch: false,
    boxFetched: 0,
    checked: 0,
    error: null,
    errors: 0,
    expanded: 0,
    failed: 0,
    gateState: null,
    labelsDiscovered: [],
    leases: 0,
    ok: true,
    partial: false,
    pending: 0,
    produced: 0,
    queueDepth: undefined,
    reason: null,
    reconciledCommits: 0,
    releaseDetailsStored: 0,
    requestsByKind: {
      artist_browse: 0,
      label_browse: 0,
      rearm_probe: 0,
      release_detail: 0,
      seed_search: 0,
    },
    staleRejected: 0,
    storableReady: null,
    throttled: false,
    throttles: 0,
    tracksFound: 0,
    tracksSkipped: 0,
    tracksSkippedArtistRule: 0,
    tracksSkippedHeld: 0,
    tracksSkippedLabelGate: 0,
    tracksWritten: 0,
  };
}

export function blockedReason(
  summary: Pick<
    SweepSummary,
    | "error"
    | "failed"
    | "ok"
    | "pending"
    | "reason"
    | "storableReady"
    | "throttled"
    | "tracksFound"
    | "tracksSkippedLabelGate"
    | "tracksWritten"
  >,
): SweepSummary["blockedReason"] {
  if (summary.tracksWritten > 0) {
    return null;
  }
  if (summary.reason === "due_work_repair_pending") {
    return "due_work_repair_pending";
  }
  if (summary.reason === "database_admission") {
    return "database_admission";
  }
  if (summary.reason === "musicbrainz_throttle" || summary.throttled) {
    return "mb_throttled";
  }
  if (summary.tracksFound > 0 && summary.tracksFound === summary.tracksSkippedLabelGate) {
    return "label_gate";
  }
  if (!summary.ok || summary.failed > 0 || summary.error !== null || summary.reason !== null) {
    return null;
  }
  return summary.storableReady === false ||
    (summary.storableReady === null && summary.pending === 0)
    ? "no_storable_work"
    : null;
}

function finishSummary(summary: SweepSummary): void {
  summary.blockedReason = blockedReason(summary);
  summary.leases = admittedPhaseCount;
  Object.assign(summary, summariseItemTiming(itemTiming) ?? {});
  console.log(JSON.stringify(summary));
}

export function recordBoxAttempt(
  summary: Pick<SweepSummary, "boxFetched" | "requestsByKind">,
  plan: Exclude<CrawlFetchPlan, { kind: "none" }>,
  nodeKind: "artist" | "label" | "release" | undefined,
  attempt: { outcome: string; url: string },
): void {
  const requestKind =
    plan.kind === "tail" && attempt.url === plan.probeUrl
      ? "rearm_probe"
      : nodeKind === "release" || /\/release\/[^/?]+(?:\?|$)/.test(attempt.url)
        ? "release_detail"
        : attempt.url.includes("/label?query=")
          ? "seed_search"
          : nodeKind === "artist" || attempt.url.includes("artist=")
            ? "artist_browse"
            : "label_browse";
  summary.boxFetched += 1;
  summary.requestsByKind[requestKind] += 1;
  console.error(
    JSON.stringify({
      event: "crawl.musicbrainz-request",
      nodeKind: nodeKind ?? null,
      outcome: attempt.outcome,
      requestKind,
      source: "box",
    }),
  );
}

function recordFailure(summary: SweepSummary, error: unknown): void {
  summary.ok = false;
  summary.errors = 1;
  summary.error = error instanceof Error ? error.message : String(error);
  log(`crawl pass failed: ${summary.error}`);
}

function recordRepairPending(summary: SweepSummary): void {
  const gate = dueWorkRepairPendingGate(summary);
  summary.gateState = gate.gateState;
  summary.partial = summary.partial || gate.partial;
  summary.reason = gate.reason;
  summary.throttled = gate.throttled;
  log("crawl pass paused: due-work repair is still converging");
}

function recordThrottleBudgetStop(summary: SweepSummary): void {
  summary.partial = true;
  summary.reason = summary.reason ?? "musicbrainz_throttle";
  log(`crawl pass stopped: ${summary.throttles} musicbrainz throttles in one tick`);
}

function recordWallBudgetStop(summary: SweepSummary): void {
  summary.partial = true;
  summary.reason = summary.reason ?? "wall_budget";
  log("crawl pass stopped: the tick's wall-clock budget is spent");
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
  summary.throttles = pass.rateLimited === true ? 1 : 0;
  summary.tracksFound = Number(pass.tracksFound ?? 0);
  summary.tracksWritten = Number(pass.tracksWritten ?? 0);
  summary.releaseDetailsStored = Number(pass.releaseDetailsStored ?? 0);
  summary.tracksSkipped = Number(pass.tracksSkipped ?? 0);
  summary.tracksSkippedArtistRule = Number(pass.tracksSkippedArtistRule ?? 0);
  summary.tracksSkippedHeld = Number(pass.tracksSkippedHeld ?? 0);
  summary.tracksSkippedLabelGate = Number(pass.tracksSkippedLabelGate ?? 0);
}

type NodeOutcome = "committed" | "stop" | "throttled";

function applyReceipt(summary: SweepSummary, committed: ReceiptEnvelope): NodeOutcome {
  const receipt = committed.receipt;
  if (receipt?.outcome === "rejected") {
    summary.staleRejected += 1;
    summary.checked += 1;
    return "stop";
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
  summary.releaseDetailsStored += Number(result.releaseDetailsStored ?? 0);
  summary.tracksSkipped += Number(result.tracksSkipped ?? 0);
  summary.tracksSkippedArtistRule += Number(result.tracksSkippedArtistRule ?? 0);
  summary.tracksSkippedHeld += Number(result.tracksSkippedHeld ?? 0);
  summary.tracksSkippedLabelGate += Number(result.tracksSkippedLabelGate ?? 0);
  if (result.rateLimited === true) {
    summary.throttled = true;
    return "throttled";
  }
  return "committed";
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
      const cached = admittedPhase<ReceiptEnvelope>(
        directory,
        `commit-result-${index}`,
        commitBody,
      );
      if (cached) {
        return cached;
      }
    } catch {}
    summary.admissionOutcome = "commit-result-unknown";
    summary.error = "a terminal crawl commit was reconciled but its counters are unavailable";
    summary.partial = true;
    return undefined;
  }
}

async function supplyProviderBodies(
  plan: CrawlFetchPlan | undefined,
  nodeKind: "artist" | "label" | "release" | undefined,
  boxFetch: boolean,
  summary: SweepSummary,
): Promise<MusicbrainzFetchResult[]> {
  if (!boxFetch || plan === undefined || plan.kind === "none") {
    return [];
  }
  try {
    const supplied = await runCrawlFetchPlan(plan, {
      onAttempt: (attempt) => recordBoxAttempt(summary, plan, nodeKind, attempt),
    });
    return supplied;
  } catch (error) {
    log(
      `box musicbrainz read unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

async function fetchPreparedNode(
  directory: string,
  index: number,
  item: {
    fetchPlan?: CrawlFetchPlan;
    nodeKind?: "artist" | "label" | "release";
    preparedToken: string;
  },
  boxFetch: boolean,
  summary: SweepSummary,
): Promise<{ boxThrottled: boolean; fetched: FetchEnvelope }> {
  const supplied = await supplyProviderBodies(item.fetchPlan, item.nodeKind, boxFetch, summary);
  const boxThrottled = supplied.some((entry) => entry.outcome === "throttled");
  const fetched = directPhase<FetchEnvelope>(directory, `fetch-${index}`, {
    phase: "fetch",
    preparedToken: item.preparedToken,
    ...(supplied.length > 0 ? { supplied } : {}),
  });
  return { boxThrottled, fetched };
}

async function processPreparedItem(
  directory: string,
  index: number,
  item: {
    fetchPlan?: CrawlFetchPlan;
    nodeKind?: "artist" | "label" | "release";
    preparedToken: string;
  },
  boxFetch: boolean,
  summary: SweepSummary,
): Promise<NodeOutcome> {
  const { fetched } = await fetchPreparedNode(directory, index, item, boxFetch, summary);
  const committed = commitFetched(directory, index, fetched, summary);
  return committed === undefined ? "stop" : applyReceipt(summary, committed);
}

function commitBatchLimit(capabilities: CommitBatchCapabilities | undefined): number | undefined {
  if ((process.env.FLUNCLE_CRAWL_COMMIT_BATCH ?? "1") === "0") {
    return undefined;
  }
  const limit = capabilities?.commitBatchLimit;
  return typeof limit === "number" && Number.isInteger(limit) && limit >= 1 ? limit : undefined;
}

function commitBatchMaxTotalBytes(capabilities: CommitBatchCapabilities | undefined): number {
  const bytes = capabilities?.commitBatchMaxTotalBytes;
  return typeof bytes === "number" && Number.isInteger(bytes) && bytes >= 1
    ? bytes
    : 8 * 1024 * 1024;
}

type FetchedNode = { fetched: FetchEnvelope; index: number };

function applyBatchReceipt(
  directory: string,
  node: FetchedNode,
  receipt: CommitBatchReceipt | undefined,
  summary: SweepSummary,
): NodeOutcome {
  if (receipt?.outcome === "committed" || receipt?.outcome === "rejected") {
    return applyReceipt(summary, { receipt });
  }
  if (receipt?.error) {
    log(`node ${node.index} commit failed inside its batch: ${receipt.error}`);
  }
  const committed = commitFetched(directory, node.index, node.fetched, summary);
  return committed === undefined ? "stop" : applyReceipt(summary, committed);
}

function commitFetchedBatch(
  directory: string,
  nodes: readonly FetchedNode[],
  summary: SweepSummary,
): NodeOutcome[] | undefined {
  const items = nodes.map(({ fetched }) => {
    const { commitToken, operationId, operationKey, requestDigest } = fetched;
    if (!commitToken || !operationId || !operationKey || !requestDigest) {
      throw new Error("crawl provider phase returned incomplete operation coordinates");
    }
    return { commitToken, operationId, operationKey, requestDigest };
  });
  const first = nodes[0];
  if (first === undefined) {
    return [];
  }

  let batch: CommitBatchEnvelope | undefined;
  try {
    batch = admittedPhase<CommitBatchEnvelope>(
      directory,
      `commit-batch-${first.index}`,
      { items },
      "--critical-commit-batch",
    );
    if (batch === undefined) {
      recordPhaseYield(summary);
      return undefined;
    }
  } catch (error) {
    if (isDueWorkRepairPending(error)) {
      throw error;
    }

    log(
      `crawl commit batch failed: ${error instanceof Error ? error.message : String(error)} — settling ${nodes.length} node(s) individually`,
    );
    batch = undefined;
  }
  if (batch !== undefined && !batch.receipts) {
    throw new Error("crawl commit batch returned no receipts");
  }

  const outcomes: NodeOutcome[] = [];
  for (const [index, node] of nodes.entries()) {
    const receipt = batch?.receipts?.[index];
    if (
      typeof receipt?.elapsedMs === "number" &&
      Number.isFinite(receipt.elapsedMs) &&
      receipt.elapsedMs >= 0
    ) {
      itemTiming.push(receipt.elapsedMs);
    }
    if (receipt !== undefined && receipt.operationKey !== node.fetched.operationKey) {
      throw new Error("crawl commit batch returned a receipt for the wrong node");
    }
    const outcome = applyBatchReceipt(directory, node, receipt, summary);
    outcomes.push(outcome);
    if (outcome === "stop") {
      return outcomes;
    }
  }
  return outcomes;
}

async function drainPreparedBatch(
  directory: string,
  items: readonly {
    fetchPlan?: CrawlFetchPlan;
    nodeKind?: "artist" | "label" | "release";
    preparedToken: string;
  }[],
  processed: number,
  boxFetch: boolean,
  summary: SweepSummary,
  spentMs: () => number,
  capabilities?: CommitBatchCapabilities,
): Promise<{ done: boolean; processed: number; throttled: boolean }> {
  const batchLimit = commitBatchLimit(capabilities);
  let reached = processed;

  if (batchLimit === undefined) {
    for (const item of items) {
      if (spentMs() >= WALL_BUDGET_MS) {
        recordWallBudgetStop(summary);
        return { done: true, processed: reached, throttled: false };
      }
      const outcome = await processPreparedItem(directory, reached, item, boxFetch, summary);
      reached += 1;
      if (outcome === "throttled") {
        return { done: false, processed: reached, throttled: true };
      }
      if (outcome === "stop") {
        return { done: true, processed: reached, throttled: false };
      }
    }
    return { done: false, processed: reached, throttled: false };
  }

  const maxTotalBytes = commitBatchMaxTotalBytes(capabilities);
  let pending: FetchedNode[] = [];
  let pendingBytes = 0;
  let done = false;
  let throttled = false;

  const settlePending = (): void => {
    if (pending.length === 0) {
      return;
    }
    const settling = pending;
    pending = [];
    pendingBytes = 0;
    const outcomes = commitFetchedBatch(directory, settling, summary);
    if (outcomes === undefined || outcomes.includes("stop")) {
      done = true;
      return;
    }
    if (outcomes.includes("throttled")) {
      throttled = true;
    }
  };

  for (const item of items) {
    if (spentMs() >= WALL_BUDGET_MS) {
      recordWallBudgetStop(summary);
      done = true;
      break;
    }
    const { boxThrottled, fetched } = await fetchPreparedNode(
      directory,
      reached,
      item,
      boxFetch,
      summary,
    );
    const bytes = Buffer.byteLength(fetched.commitToken ?? "", "utf8");

    if (
      pending.length > 0 &&
      (pending.length >= batchLimit || pendingBytes + bytes > maxTotalBytes)
    ) {
      settlePending();
      if (done) {
        break;
      }
    }
    pending.push({ fetched, index: reached });
    pendingBytes += bytes;
    reached += 1;

    if (boxThrottled || fetched.rateLimited === true) {
      throttled = true;
      break;
    }
  }

  settlePending();

  return { done, processed: reached, throttled: throttled && !done };
}

async function drainFrontier(directory: string, summary: SweepSummary): Promise<void> {
  const startedAt = Date.now();
  const spentMs = (): number => Date.now() - startedAt;
  let processed = 0;

  while (processed < NODES) {
    if (spentMs() >= WALL_BUDGET_MS) {
      recordWallBudgetStop(summary);
      return;
    }
    const prepared = admittedPhase<PrepareEnvelope>(directory, `prepare-${processed}`, {
      limit: Math.min(PREPARE_LIMIT, NODES - processed),
      maxHop: MAX_HOP,
      phase: "prepare",
    });
    if (!prepared) {
      recordPhaseYield(summary);
      return;
    }
    summary.pending = prepared.frontierPending ?? summary.pending;
    summary.queueDepth = summary.pending;
    if (summary.storableReady === null) {
      summary.storableReady = prepared.storableReady ?? null;
    }

    const boxFetch = BOX_FETCH && prepared.boxFetch === true;
    summary.boxFetch = boxFetch;
    if (prepared.kind === "drained") {
      return;
    }
    if (prepared.kind !== "prepared" || !prepared.items || prepared.items.length === 0) {
      throw new Error(`crawl prepare is ${prepared.kind ?? "invalid"}`);
    }

    const batch = await drainPreparedBatch(
      directory,
      prepared.items,
      processed,
      boxFetch,
      summary,
      spentMs,
      prepared.capabilities,
    );
    processed = batch.processed;
    if (batch.done) {
      return;
    }
    if (!batch.throttled) {
      continue;
    }

    summary.throttles += 1;
    if (summary.throttles >= MAX_THROTTLES) {
      recordThrottleBudgetStop(summary);
      return;
    }
    if (processed >= NODES || spentMs() + THROTTLE_PAUSE_MS >= WALL_BUDGET_MS) {
      if (processed < NODES) {
        recordWallBudgetStop(summary);
      }
      return;
    }
    log(`musicbrainz throttled; waiting ${THROTTLE_PAUSE_MS}ms before the next claim`);
    sleepSync(THROTTLE_PAUSE_MS);
  }
}

export async function main(): Promise<void> {
  const summary = createSummary();
  try {
    validateConfig();
  } catch (error) {
    recordFailure(summary, error);
    finishSummary(summary);
    process.exitCode = 1;
    return;
  }

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
    finishSummary(summary);
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
      finishSummary(summary);
      return;
    }
    if (initialized.ok !== true || initialized.phase !== "initialize") {
      throw new Error("crawl initialization returned an invalid phase envelope");
    }
    if (initialized.kind === "unavailable") {
      summary.admissionOutcome = "cutover-disabled";
      summary.gateState = "disabled";
      summary.reason = "crawl_due_cutover_disabled";
      finishSummary(summary);
      return;
    }
    if (initialized.kind !== "initialized") {
      throw new Error(`crawl initialization is ${initialized.kind ?? "invalid"}`);
    }
    summary.gateState = "active";

    await drainFrontier(directory, summary);
  } catch (error) {
    if (isDueWorkRepairPending(error)) {
      recordRepairPending(summary);
    } else {
      recordFailure(summary, error);
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }

  finishSummary(summary);
  if (!summary.ok) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  const criticalIndex = process.argv.indexOf("--critical-phase");
  const batchIndex = process.argv.indexOf("--critical-commit-batch");
  const file = criticalIndex >= 0 ? process.argv[criticalIndex + 1] : undefined;
  const batchFile = batchIndex >= 0 ? process.argv[batchIndex + 1] : undefined;
  if (file) {
    console.log(JSON.stringify(runCriticalPhase(file)));
  } else if (batchFile) {
    console.log(JSON.stringify(runCriticalCommitBatch(batchFile)));
  } else {
    await main();
  }
}
