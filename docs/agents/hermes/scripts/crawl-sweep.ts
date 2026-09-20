#!/usr/bin/env bun
// Database-critical crawl work is phase-scoped. Provider waits happen between prepare and commit,
// outside the exclusive writer admission, while a signed claim snapshot fences every later write.

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

/**
 * THE BOX-SIDE HALF OF THE BOX-FETCH SWITCH. MusicBrainz rate-limits per source IP, so the crawl's
 * provider reads are made from this machine's address under the one shared budget in
 * `musicbrainz-fetch.ts`. Set it to `0` and the tick supplies nothing, which puts every read back on
 * Worker egress with no other change; the Worker's own `crawl_box_fetch_enabled` flag is the other
 * half and either side saying no is enough. The tick asks the SERVER first (`prepare` answers
 * `boxFetch`), so a flag flip can never leave this sweep spending requests nobody will read.
 */
const BOX_FETCH = process.env.FLUNCLE_CRAWL_BOX_FETCH !== "0";

/**
 * How many nodes one prepare claims. It mirrors the server's `MAX_CRAWL_PREPARE_LIMIT`, which the
 * request schema also enforces, so the two cannot silently disagree: a sweep asking for more than
 * the server allows is rejected at the contract rather than half-honoured. Every prepare is an
 * admitted phase with a coordinator round trip and a process spawn of its own, so the nodes a
 * single claim covers are the nodes that toll is amortised across.
 */
const PREPARE_LIMIT = 6;

/**
 * THE THROTTLE BUDGET. A MusicBrainz throttle is the vendor's mood, not the tick's verdict: the
 * old behaviour ended the whole pass on the first one, so a single 503 six seconds into a
 * ten-minute window spent the rest of that window doing nothing. The tick now waits and carries
 * on — but only a bounded number of times, because a wall that survives three waits is a wall the
 * next tick should meet with a fresh rate window rather than one this tick should keep pushing on.
 */
const MAX_THROTTLES = 3;

/**
 * How long the tick waits out a throttle. The shared MusicBrainz client has ALREADY spent this
 * node's `Retry-After` hints — three attempts of them — before it reports a throttle at all, so
 * what reaches the sweep is precisely the case where the vendor's own hint was too optimistic.
 * The pause is therefore a flat, generous wait rather than an echo of a hint that has already
 * been proven insufficient, and it is bounded so it can never be the reason a tick overruns.
 */
const THROTTLE_PAUSE_MS = Number(process.env.FLUNCLE_CRAWL_THROTTLE_PAUSE_MS ?? "45000");
const THROTTLE_PAUSE_MAX_MS = 120_000;

/**
 * THE WALL-CLOCK GUARD, and it is a BACKSTOP rather than a target. The unit kills this process at
 * `TimeoutStartSec=1030`, and a kill leaves no summary, no marker, and a claimed node stranded
 * until its lease expires — so the tick stops itself first. The budget is checked before every
 * claim AND before every node inside a claim, which bounds the overshoot to one node rather than
 * a whole batch: at the shared MusicBrainz client's worst honest latency (~35s for an aborted
 * fetch plus two `Retry-After` sleeps) plus its commit, that leaves the default a wide margin
 * under the unit's timeout for the last node and the summary.
 *
 * The pause never sits inside an open claim: a throttle abandons the rest of its batch before the
 * tick waits, so no wait can push a claimed node past its lease. A tick that actually reaches this
 * budget is already abnormal — the sizing is ~3s of paced provider time per node — and systemd
 * queues the next firing behind this one rather than overlapping it, so an overrun costs cadence
 * and never concurrency.
 */
const WALL_BUDGET_MS = Number(process.env.FLUNCLE_CRAWL_WALL_BUDGET_MS ?? "840000");
const WALL_BUDGET_MAX_MS = 1_000_000;

const log = (message: string) => console.error(`[crawl-sweep] ${message}`);

/** Wait without an event loop: every phase this script drives is a synchronous spawn. */
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
  items?: { fetchPlan?: CrawlFetchPlan; nodeId: string; preparedToken: string }[];
  kind?: "drained" | "prepared" | "unavailable";
};
type FetchEnvelope = PhaseEnvelope & {
  commitToken?: string;
  operationId?: string;
  operationKey?: string;
  /** The vendor pushed back on this node. Absent on a Worker older than the batched commit. */
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
  /** Whether this tick read MusicBrainz from the box's own IP — both halves of the switch agreeing. */
  boxFetch: boolean;
  /** MusicBrainz reads this tick made from the box's own IP, under the one shared budget. */
  boxFetched: number;
  checked: number;
  error: string | null;
  errors: number;
  expanded: number;
  failed: number;
  gateState: "active" | "disabled" | "paused" | null;
  labelsDiscovered: string[];
  /**
   * How many ADMITTED DATABASE PHASES this tick took — the shared write lane's acquisitions, each
   * one a lease with a coordinator round trip and a process spawn of its own. A claim of six nodes
   * costs two (its prepare and its batched commit) plus whatever a poisoned node's own fallback
   * commit adds; the pre-batching shape was seven. It is a counter, never a model: every admitted
   * phase increments it wherever it is taken.
   */
  leases: number;
  /**
   * The per-tick shape of a batched commit's PER-ITEM server time. The wall budget is checked
   * BETWEEN items, so a batch's exposure to one slow item grows with its width — and that width was
   * chosen from the natural unit of work (one claim) rather than from a measured p99. Publishing the
   * max and the median is what turns that into evidence: a day of ordinary ticks yields the
   * distribution the bound should be re-derived from. Absent when no batched commit ran.
   */
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
  staleRejected: number;
  throttled: boolean;
  /** How many MusicBrainz throttles this tick waited out — the gauge the boolean cannot give. */
  throttles: number;
  tracksFound: number;
  tracksSkipped: number;
  /** Tracks the write chokepoint refused because an artist rule blocked their first credit. */
  tracksSkippedArtistRule: number;
  /** Tracks already held by the archive — the idempotence layers folding a re-crawl to a no-op. */
  tracksSkippedHeld: number;
  /** Tracks refused by the label gate — the operator's rulings doing their job, not a fault. */
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

/** The batched commit is its own op, so its admitted child runs its own command. */
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

/** Server-measured per-item milliseconds from this tick's batched commits. */
const itemTiming: number[] = [];

/** Fold the tick's per-item readings into the max/median pair the ledger publishes. */
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

/**
 * HOW MANY LEASES THIS TICK TOOK — the number that makes the batching measurable rather than
 * asserted. Every admitted phase, whatever its shape, passes through here, so the ledger's `leases`
 * is a count of the shared write lane's acquisitions and not a model of them.
 */
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
    staleRejected: 0,
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

/**
 * The tick met the vendor wall as many times as its budget allows. Everything committed so far
 * stands, the frontier holds the rest, and the next tick arrives with a fresh rate window — so
 * this is a partial tick with a named cause, never a failed one.
 */
function recordThrottleBudgetStop(summary: SweepSummary): void {
  summary.partial = true;
  summary.reason = summary.reason ?? "musicbrainz_throttle";
  log(`crawl pass stopped: ${summary.throttles} musicbrainz throttles in one tick`);
}

/**
 * The tick stopped itself with time to spare rather than being killed mid-node by the unit's
 * timeout. A kill writes no summary and strands a claim until its lease expires; this writes both.
 */
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
  summary.tracksSkipped = Number(pass.tracksSkipped ?? 0);
  summary.tracksSkippedArtistRule = Number(pass.tracksSkippedArtistRule ?? 0);
  summary.tracksSkippedHeld = Number(pass.tracksSkippedHeld ?? 0);
  summary.tracksSkippedLabelGate = Number(pass.tracksSkippedLabelGate ?? 0);
}

/**
 * What one node's commit says about the REST of the tick. Three answers, never a bare boolean: a
 * throttle is backpressure the tick waits out, a stale claim is a race the tick stops on, and a
 * commit is work done. Folding the first two together is what made every throttle end the pass.
 */
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

/**
 * The provider leg for one claimed node. When both halves of the switch agree, the MusicBrainz reads
 * happen HERE — from this machine's address, paced by the shared budget — and the bodies ride into
 * the Worker's unadmitted fetch phase, which binds them to the claim by url and parses them with the
 * parser its own fetch feeds. A url the box omits is simply fetched by the Worker, so a failure here
 * costs latency and never correctness.
 */
async function supplyProviderBodies(
  plan: CrawlFetchPlan | undefined,
  boxFetch: boolean,
  summary: SweepSummary,
): Promise<MusicbrainzFetchResult[]> {
  if (!boxFetch || plan === undefined || plan.kind === "none") {
    return [];
  }
  try {
    const supplied = await runCrawlFetchPlan(plan);
    summary.boxFetched += supplied.length;
    return supplied;
  } catch (error) {
    // A budget lock this tick could not take, or a drifted url. Neither is the node's fault and
    // neither needs to end the tick: the Worker fetches the node itself this once.
    log(
      `box musicbrainz read unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

/**
 * ONE node's provider leg, whichever way its commit will be settled.
 *
 * The box-fetch half is unchanged: when both switches agree the MusicBrainz reads happen here, on
 * this machine's address under the shared budget, and the bodies ride into the Worker's unadmitted
 * fetch phase. What the batched commit adds is `boxThrottled` — the box knows the vendor pushed back
 * BEFORE the Worker tells it, because it made the call. A tick that batches its commits has to
 * decide whether to keep fetching the rest of its claim before any commit verdict exists, so it
 * reads the throttle from its own hand as well as from the response's `rateLimited`. Either alone is
 * enough: the response covers a Worker-fetched read, and the box's own outcome covers the case where
 * the Worker is older than that field.
 */
async function fetchPreparedNode(
  directory: string,
  index: number,
  item: { fetchPlan?: CrawlFetchPlan; preparedToken: string },
  boxFetch: boolean,
  summary: SweepSummary,
): Promise<{ boxThrottled: boolean; fetched: FetchEnvelope }> {
  const supplied = await supplyProviderBodies(item.fetchPlan, boxFetch, summary);
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
  item: { fetchPlan?: CrawlFetchPlan; preparedToken: string },
  boxFetch: boolean,
  summary: SweepSummary,
): Promise<NodeOutcome> {
  const { fetched } = await fetchPreparedNode(directory, index, item, boxFetch, summary);
  const committed = commitFetched(directory, index, fetched, summary);
  return committed === undefined ? "stop" : applyReceipt(summary, committed);
}

/**
 * THE BATCHED COMMIT'S KILL SWITCH and its feature detection, in one place.
 *
 * `FLUNCLE_CRAWL_COMMIT_BATCH=0` in the unit's environment puts every node back on its own commit
 * phase without a rebake of anything but the unit file — the lever an operator reaches for when a
 * batched commit is the suspect. Otherwise the answer is the WORKER's: a prepare that carries no
 * `capabilities.commitBatchLimit` is a Worker that does not have `commit_crawl_nodes`, and the
 * per-node path is taken. That is the only way this sweep may learn it, because a 404 discovered
 * halfway through a claim would strand the nodes it had already fetched.
 */
function commitBatchLimit(capabilities: CommitBatchCapabilities | undefined): number | undefined {
  if ((process.env.FLUNCLE_CRAWL_COMMIT_BATCH ?? "1") === "0") {
    return undefined;
  }
  const limit = capabilities?.commitBatchLimit;
  return typeof limit === "number" && Number.isInteger(limit) && limit >= 1 ? limit : undefined;
}

/** The batch's signed-envelope budget, taken from the Worker so the two split at the same number. */
function commitBatchMaxTotalBytes(capabilities: CommitBatchCapabilities | undefined): number {
  const bytes = capabilities?.commitBatchMaxTotalBytes;
  return typeof bytes === "number" && Number.isInteger(bytes) && bytes >= 1
    ? bytes
    : 8 * 1024 * 1024;
}

type FetchedNode = { fetched: FetchEnvelope; index: number };

/**
 * Apply ONE item's receipt out of a batched commit.
 *
 * A terminal receipt is applied exactly as a single-node commit's is. Anything else — this item's
 * own `failed`, the wall-budgeted tail's `safely-retryable`, a receipt-rail verdict that needs
 * reconciling — falls back to the per-node commit path for THAT NODE ALONE. That path is
 * idempotent by construction (the same operation key can only read its stored result back), it is
 * the code that already knows how to reconcile, and it costs one extra lease for exactly the nodes
 * that earned it. Its neighbours in the batch are already settled and pay nothing.
 */
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

/**
 * Settle a run of fetched nodes in ONE admitted phase, then apply their receipts item by item.
 *
 * Returns `undefined` when the phase itself yielded — no node was settled, and the tick stops as
 * paused backpressure exactly as a yielded single commit already does.
 */
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
      // The phase yielded before it ran, so nothing was settled.
      recordPhaseYield(summary);
      return undefined;
    }
  } catch (error) {
    if (isDueWorkRepairPending(error)) {
      throw error;
    }
    // The batch request itself failed, so NO item carries a receipt from it. Each node falls back
    // to the per-node commit path, which reconciles its own operation key — the effect of a request
    // that may or may not have landed is exactly what that path exists to settle.
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

/**
 * Work one claim's nodes. Returns how many nodes were reached and whether the tick should carry on
 * — a throttle pauses it, a stale claim or an admission yield ends it.
 *
 * ONE CLAIM, TWO LEASES. The nodes' MusicBrainz fetches are unadmitted and stay that way; what
 * changed is that their commits ride ONE admitted phase for the whole claim instead of one each.
 * A claim of six therefore costs two leases (its prepare and its commit) rather than seven, paying
 * the ~15-30s lease toll once for the batch.
 *
 * A THROTTLE STILL ABANDONS THE REST OF THE CLAIM. The fetch response says so directly
 * (`rateLimited`), so the sweep learns it before it spends the next node's provider leg. What it
 * has already fetched is committed
 * rather than discarded: those nodes' provider work is done and their claim is live.
 */
async function drainPreparedBatch(
  directory: string,
  items: readonly { fetchPlan?: CrawlFetchPlan; preparedToken: string }[],
  processed: number,
  boxFetch: boolean,
  summary: SweepSummary,
  spentMs: () => number,
  capabilities?: CommitBatchCapabilities,
): Promise<{ done: boolean; processed: number; throttled: boolean }> {
  const batchLimit = commitBatchLimit(capabilities);
  let reached = processed;

  if (batchLimit === undefined) {
    // The per-node path, unchanged: an old Worker, or an operator who flipped the kill switch.
    for (const item of items) {
      if (spentMs() >= WALL_BUDGET_MS) {
        recordWallBudgetStop(summary);
        return { done: true, processed: reached, throttled: false };
      }
      const outcome = await processPreparedItem(directory, reached, item, boxFetch, summary);
      reached += 1;
      if (outcome === "throttled") {
        // The rest of THIS claim is abandoned deliberately: its nodes would meet the same wall, and
        // an unworked claim simply expires back to `ready`. Their turn comes round again.
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
    // The pathological path: MusicBrainz envelopes are kilobytes, so a claim ordinarily fits one
    // batch. A run of fat ones splits into consecutive batches at the SERVER's own byte bound
    // rather than being sent as a body the Worker would refuse.
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
    // The vendor pushed back: from the box's own read, or from the Worker's response. Either way the
    // rest of THIS claim is abandoned before another provider leg is spent, exactly as the per-node
    // path abandons it — an unworked claim simply expires back to `ready`.
    if (boxThrottled || fetched.rateLimited === true) {
      throttled = true;
      break;
    }
  }

  // Whatever is still pending is COMMITTED rather than dropped, whichever budget or wall stopped
  // the loop: those nodes' provider work is already spent and their claim is live.
  settlePending();

  // `done` ends the tick; `throttled` only pauses it, so a tick that hit both stops.
  return { done, processed: reached, throttled: throttled && !done };
}

/** Claim, work, and — when the vendor pushes back — wait, until a budget or the frontier says stop. */
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
    // The server's half of the switch, read fresh each claim: a flag flip takes effect on the very
    // next prepare, with no deploy and no rebake.
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
    summary.leases = admittedPhaseCount;
    Object.assign(summary, summariseItemTiming(itemTiming));
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
    summary.leases = admittedPhaseCount;
    Object.assign(summary, summariseItemTiming(itemTiming) ?? {});
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
      summary.leases = admittedPhaseCount;
      Object.assign(summary, summariseItemTiming(itemTiming) ?? {});
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
      summary.leases = admittedPhaseCount;
      Object.assign(summary, summariseItemTiming(itemTiming) ?? {});
      console.log(JSON.stringify(summary));
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

  summary.leases = admittedPhaseCount;
  Object.assign(summary, summariseItemTiming(itemTiming) ?? {});
  console.log(JSON.stringify(summary));
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
