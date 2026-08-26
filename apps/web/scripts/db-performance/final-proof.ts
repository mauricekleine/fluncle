import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { materializeSelectedTrackIdsSql, selectDeviceRowsSql } from "../lib/device-db-derivation";
import { PERFORMANCE_REPORT_SCHEMA_VERSION } from "./registry";
import {
  type ContractContext,
  type ContractExecution,
  type PerformanceContract,
  type PerformanceRegistry,
} from "./registry";

export const FINAL_PROOF_CONTRACT_IDS = [
  "admission.fenced-fifo",
  "device-derivation.atomic-generation",
  "mutation.receipt-ambiguity",
  "sonar-refresh.local-replica-delta",
] as const;

export type AdmissionLane = "heavy-read" | "write";

export type AdmissionRequest = {
  durationMs: number;
  enqueuedAtMs: number;
  heavyRead: boolean;
  id: string;
  lane: AdmissionLane;
};

export type AdmissionEvent = AdmissionRequest & {
  acquiredAtMs: number;
  completedAtMs: number;
  fencingToken: number;
  waitMs: number;
};

export type AdmissionSimulation = {
  convergenceFailures: number;
  events: AdmissionEvent[];
  fencingViolations: number;
  fifoViolations: number;
  maxWaitMs: number;
  staleFenceRejected: boolean;
  uncontendedAcquisitionMs: number;
  uncontendedAcquisitionViolations: number;
  violations: string[];
};

const DEFAULT_ADMISSION_REQUESTS: readonly AdmissionRequest[] = [
  {
    durationMs: 10,
    enqueuedAtMs: 0,
    heavyRead: false,
    id: "writer-1",
    lane: "write",
  },
  {
    durationMs: 10,
    enqueuedAtMs: 1,
    heavyRead: true,
    id: "mixed-2",
    lane: "write",
  },
  {
    durationMs: 5,
    enqueuedAtMs: 2,
    heavyRead: false,
    id: "reader-3",
    lane: "heavy-read",
  },
  {
    durationMs: 5,
    enqueuedAtMs: 3,
    heavyRead: false,
    id: "writer-4",
    lane: "write",
  },
  {
    durationMs: 5,
    enqueuedAtMs: 30,
    heavyRead: false,
    id: "writer-uncontended",
    lane: "write",
  },
];

function admissionResources(request: AdmissionRequest): AdmissionLane[] {
  return request.heavyRead ? [request.lane, "heavy-read"] : [request.lane];
}

function compareAdmissionRequests(left: AdmissionRequest, right: AdmissionRequest): number {
  return left.enqueuedAtMs - right.enqueuedAtMs || left.id.localeCompare(right.id);
}

function requestsConflict(left: AdmissionRequest, right: AdmissionRequest): boolean {
  const resources = new Set(admissionResources(left));

  return admissionResources(right).some((resource) => resources.has(resource));
}

function acceptsFencingToken(activeToken: number, presentedToken: number): boolean {
  return activeToken === presentedToken;
}

function validAdmissionRequest(request: AdmissionRequest): boolean {
  return (
    typeof request === "object" &&
    request !== null &&
    typeof request.id === "string" &&
    request.id.length > 0 &&
    Number.isSafeInteger(request.enqueuedAtMs) &&
    request.enqueuedAtMs >= 0 &&
    Number.isSafeInteger(request.durationMs) &&
    request.durationMs > 0 &&
    (request.lane === "write" || request.lane === "heavy-read") &&
    typeof request.heavyRead === "boolean"
  );
}

/** Discrete-event proof of the durable two-resource FIFO and fencing rules. */
export function simulateFencedAdmission(
  requests: readonly AdmissionRequest[] = DEFAULT_ADMISSION_REQUESTS,
): AdmissionSimulation {
  const violations: string[] = [];
  const ids = new Set<string>();

  for (const request of requests) {
    const id =
      typeof request === "object" && request !== null && typeof request.id === "string"
        ? request.id
        : "<missing>";
    if (!validAdmissionRequest(request)) {
      violations.push(`invalid admission request ${id}`);
    }
    if (ids.has(id)) {
      violations.push(`duplicate admission contender ${id}`);
    }
    ids.add(id);
  }

  if (requests.length > 100) {
    violations.push("admission request set exceeds the deterministic proof bound");
  }

  if (violations.length > 0) {
    return {
      convergenceFailures: 1,
      events: [],
      fencingViolations: 1,
      fifoViolations: 1,
      maxWaitMs: 0,
      staleFenceRejected: false,
      uncontendedAcquisitionMs: 0,
      uncontendedAcquisitionViolations: 1,
      violations,
    };
  }

  const pending = [...requests].sort(compareAdmissionRequests);
  const active: AdmissionEvent[] = [];
  const events: AdmissionEvent[] = [];
  const nextToken: Record<AdmissionLane, number> = { "heavy-read": 0, write: 0 };
  let clock = pending[0]?.enqueuedAtMs ?? 0;

  while (pending.length > 0 || active.length > 0) {
    for (let index = active.length - 1; index >= 0; index -= 1) {
      if ((active[index]?.completedAtMs ?? Number.POSITIVE_INFINITY) <= clock) {
        active.splice(index, 1);
      }
    }

    if (pending.length === 0 && active.length === 0) {
      break;
    }

    const candidateIndex = pending.findIndex((candidate) => {
      if (candidate.enqueuedAtMs > clock) {
        return false;
      }

      if (active.some((held) => requestsConflict(candidate, held))) {
        return false;
      }

      return !pending.some(
        (earlier) =>
          earlier !== candidate &&
          compareAdmissionRequests(earlier, candidate) < 0 &&
          requestsConflict(earlier, candidate),
      );
    });

    if (candidateIndex >= 0) {
      const candidate = pending.splice(candidateIndex, 1)[0];
      if (!candidate) {
        violations.push("admission scheduler lost a candidate");
        break;
      }

      const acquiredAtMs = Math.max(clock, candidate.enqueuedAtMs);
      const event: AdmissionEvent = {
        ...candidate,
        acquiredAtMs,
        completedAtMs: acquiredAtMs + candidate.durationMs,
        fencingToken: (nextToken[candidate.lane] += 1),
        waitMs: acquiredAtMs - candidate.enqueuedAtMs,
      };
      events.push(event);
      active.push(event);
      continue;
    }

    const nextCompletion = active.reduce(
      (soonest, event) => Math.min(soonest, event.completedAtMs),
      Number.POSITIVE_INFINITY,
    );
    const nextArrival = pending.reduce(
      (soonest, request) =>
        request.enqueuedAtMs > clock ? Math.min(soonest, request.enqueuedAtMs) : soonest,
      Number.POSITIVE_INFINITY,
    );
    const nextClock = Math.min(nextCompletion, nextArrival);

    if (!Number.isFinite(nextClock) || nextClock <= clock) {
      violations.push("admission scheduler failed to advance");
      break;
    }
    clock = nextClock;
  }

  const sortedEvents = [...events].sort((left, right) => left.acquiredAtMs - right.acquiredAtMs);
  let fifoViolations = 0;
  for (let leftIndex = 0; leftIndex < requests.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < requests.length; rightIndex += 1) {
      const left = requests[leftIndex];
      const right = requests[rightIndex];
      if (!left || !right || !requestsConflict(left, right)) {
        continue;
      }
      const leftEvent = events.find((event) => event.id === left.id);
      const rightEvent = events.find((event) => event.id === right.id);
      if (
        leftEvent !== undefined &&
        rightEvent !== undefined &&
        compareAdmissionRequests(left, right) < 0 &&
        leftEvent.acquiredAtMs > rightEvent.acquiredAtMs
      ) {
        fifoViolations += 1;
      }
    }
  }

  const writeEvents = sortedEvents.filter((event) => event.lane === "write");
  const staleFenceRejected =
    writeEvents.length >= 2 &&
    (writeEvents[1]?.fencingToken ?? 0) > (writeEvents[0]?.fencingToken ?? 0) &&
    !acceptsFencingToken(writeEvents[1]?.fencingToken ?? 0, writeEvents[0]?.fencingToken ?? 0);
  const fencingViolations =
    writeEvents.some(
      (event, index) =>
        index > 0 && event.fencingToken <= (writeEvents[index - 1]?.fencingToken ?? 0),
    ) || !staleFenceRejected
      ? 1
      : 0;
  const uncontended = events.find((event) => event.id === "writer-uncontended");
  const uncontendedAcquisitionMs = uncontended?.waitMs ?? Number.POSITIVE_INFINITY;
  const uncontendedAcquisitionViolations = Number.isFinite(uncontendedAcquisitionMs)
    ? uncontendedAcquisitionMs > 250
      ? 1
      : 0
    : 1;
  const maxWaitMs = events.reduce((maximum, event) => Math.max(maximum, event.waitMs), 0);
  const convergenceFailures =
    pending.length === 0 && active.length === 0 && events.length === requests.length ? 0 : 1;

  if (fifoViolations > 0) {
    violations.push(`admission FIFO violations: ${fifoViolations}`);
  }
  if (fencingViolations > 0) {
    violations.push(`admission fencing violations: ${fencingViolations}`);
  }
  if (!staleFenceRejected) {
    violations.push("stale fencing token was not rejected");
  }
  if (convergenceFailures > 0) {
    violations.push("admission queue did not converge");
  }
  if (uncontendedAcquisitionViolations > 0) {
    violations.push("uncontended admission acquisition exceeded its bound");
  }

  return {
    convergenceFailures,
    events,
    fencingViolations,
    fifoViolations,
    maxWaitMs,
    staleFenceRejected,
    uncontendedAcquisitionMs,
    uncontendedAcquisitionViolations,
    violations,
  };
}

export type ReceiptObservedState =
  | "accepted"
  | "absent"
  | "committed"
  | "conflict"
  | "lookup-failed"
  | "malformed"
  | "rejected";

export type ReceiptClassification =
  | "committed"
  | "conflict"
  | "in-progress"
  | "lookup-failed"
  | "rejected"
  | "safely-retryable"
  | "unresolved";

export type ReceiptClassificationReport = {
  classifiedOutcomes: number;
  outcomeCounts: Record<ReceiptClassification, number>;
  replayAuthorizationViolations: number;
  scenarios: number;
  unresolvedOutcomes: number;
  violations: string[];
};

const DEFAULT_RECEIPT_STATES: readonly ReceiptObservedState[] = [
  "committed",
  "rejected",
  "absent",
  "accepted",
  "conflict",
  "malformed",
  "lookup-failed",
];

/** Keep the production receipt vocabulary closed: unknown evidence is never silently retried. */
export function classifyReceiptOutcome(state: ReceiptObservedState): ReceiptClassification {
  switch (state) {
    case "committed":
      return "committed";
    case "rejected":
      return "rejected";
    case "absent":
      return "safely-retryable";
    case "accepted":
      return "in-progress";
    case "conflict":
      return "conflict";
    case "lookup-failed":
    case "malformed":
      return "lookup-failed";
    default:
      return "unresolved";
  }
}

export function classifyReceiptStates(
  states: readonly ReceiptObservedState[] = DEFAULT_RECEIPT_STATES,
): ReceiptClassificationReport {
  const outcomeCounts: Record<ReceiptClassification, number> = {
    committed: 0,
    conflict: 0,
    "in-progress": 0,
    "lookup-failed": 0,
    rejected: 0,
    "safely-retryable": 0,
    unresolved: 0,
  };
  const violations: string[] = [];

  if (states.length === 0 || states.length > 100) {
    violations.push("receipt classification scenario set is outside its bounded range");
  }

  for (const state of states) {
    const outcome = classifyReceiptOutcome(state);
    outcomeCounts[outcome] += 1;

    if (outcome === "safely-retryable" && state !== "absent") {
      violations.push("receipt replay was authorized without an absent receipt");
    }
    if (outcome === "unresolved") {
      violations.push(`receipt state ${String(state)} remained unresolved`);
    }
  }

  const classifiedOutcomes = states.length - outcomeCounts.unresolved;

  return {
    classifiedOutcomes,
    outcomeCounts,
    replayAuthorizationViolations: violations.filter((entry) =>
      entry.includes("replay was authorized"),
    ).length,
    scenarios: states.length,
    unresolvedOutcomes: outcomeCounts.unresolved,
    violations,
  };
}

export type SonarDeltaEvent = {
  id: string;
  operation: "delete" | "upsert";
  revision: number;
  value?: string;
};

export type SonarTraceStep = {
  events?: readonly SonarDeltaEvent[];
  kind: "delta" | "full-corpus-scan" | "replica-sync" | "state-apply";
  source: "local-replica" | "remote-api" | "state";
};

export type SonarConvergenceReport = {
  convergenceFailures: number;
  deltaBatches: number;
  localReplicaScans: number;
  remoteFullCorpusScans: number;
  stateRows: number;
  violations: string[];
};

const DEFAULT_SONAR_EVENTS: readonly SonarDeltaEvent[] = [
  { id: "track-b", operation: "upsert", revision: 2, value: "b2" },
  { id: "track-c", operation: "delete", revision: 2 },
  { id: "track-d", operation: "upsert", revision: 1, value: "d" },
];

const DEFAULT_SONAR_TRACE: readonly SonarTraceStep[] = [
  { kind: "replica-sync", source: "local-replica" },
  { events: DEFAULT_SONAR_EVENTS, kind: "delta", source: "remote-api" },
  { events: DEFAULT_SONAR_EVENTS, kind: "state-apply", source: "state" },
  { events: [], kind: "delta", source: "remote-api" },
  { kind: "full-corpus-scan", source: "local-replica" },
];

function validSonarEvent(event: SonarDeltaEvent): boolean {
  return (
    typeof event === "object" &&
    event !== null &&
    typeof event.id === "string" &&
    event.id.length > 0 &&
    Number.isSafeInteger(event.revision) &&
    event.revision > 0 &&
    (event.operation === "delete" ||
      (event.operation === "upsert" && typeof event.value === "string"))
  );
}

function applySonarEvents(
  state: Map<string, { revision: number; value: string }>,
  events: readonly SonarDeltaEvent[],
): number {
  let failures = 0;

  for (const event of events) {
    if (!validSonarEvent(event)) {
      failures += 1;
      continue;
    }

    const existing = state.get(event.id);
    if (existing !== undefined && event.revision <= existing.revision) {
      continue;
    }
    if (event.operation === "delete") {
      state.delete(event.id);
    } else if (event.value !== undefined) {
      state.set(event.id, { revision: event.revision, value: event.value });
    }
  }

  return failures;
}

function sonarDigest(state: ReadonlyMap<string, { revision: number; value: string }>): string {
  return [...state.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, value]) => `${id}:${value.revision}:${value.value}`)
    .join("|");
}

/** Model local replica sync, one remote delta page, and a local steady-state reconciliation. */
export function simulateSonarConvergence(
  trace: readonly SonarTraceStep[] = DEFAULT_SONAR_TRACE,
): SonarConvergenceReport {
  const violations: string[] = [];
  const state = new Map<string, { revision: number; value: string }>([
    ["track-a", { revision: 1, value: "a" }],
    ["track-b", { revision: 1, value: "b" }],
    ["track-c", { revision: 1, value: "c" }],
  ]);
  const expected = new Map(state);
  const replica = new Map(state);
  let deltaBatches = 0;
  let localReplicaScans = 0;
  let remoteFullCorpusScans = 0;
  let convergenceFailures = 0;

  if (trace.length === 0 || trace.length > 100) {
    violations.push("Sonar trace is outside its bounded proof range");
    convergenceFailures += 1;
  }

  for (const step of trace) {
    if (
      typeof step !== "object" ||
      step === null ||
      !["delta", "full-corpus-scan", "replica-sync", "state-apply"].includes(step.kind) ||
      !["local-replica", "remote-api", "state"].includes(step.source) ||
      (step.events !== undefined && !Array.isArray(step.events))
    ) {
      convergenceFailures += 1;
      violations.push("Sonar trace step is malformed");
      continue;
    }
    const events = step.events ?? [];

    if (step.kind === "replica-sync" || step.kind === "full-corpus-scan") {
      if (step.source !== "local-replica") {
        convergenceFailures += 1;
        violations.push(`${step.kind} did not use the local replica`);
      }
      if (step.kind === "full-corpus-scan") {
        localReplicaScans += 1;
      }
    }
    if (step.kind === "delta") {
      deltaBatches += 1;
      if (step.source === "remote-api") {
        if (events.length > 500) {
          convergenceFailures += 1;
          violations.push("Sonar delta page exceeded its bounded batch size");
        }
      } else {
        convergenceFailures += 1;
        violations.push("Sonar delta page used a non-remote source");
      }
      if (events.length === 0) {
        continue;
      }
      const eventFailures = applySonarEvents(expected, events);
      convergenceFailures += eventFailures;
      applySonarEvents(replica, events);
    }
    if (step.kind === "state-apply") {
      if (step.source !== "state") {
        convergenceFailures += 1;
        violations.push("Sonar delta was not applied to durable local state");
      }
      convergenceFailures += applySonarEvents(state, events);
    }
    if (step.kind === "full-corpus-scan" && step.source === "remote-api") {
      remoteFullCorpusScans += 1;
      violations.push("Sonar performed a remote full-corpus scan");
    }
  }

  if (sonarDigest(state) !== sonarDigest(expected)) {
    convergenceFailures += 1;
    violations.push("Sonar durable state did not converge with the delta oracle");
  }
  if (sonarDigest(replica) !== sonarDigest(expected)) {
    convergenceFailures += 1;
    violations.push("Sonar local replica did not converge with the delta oracle");
  }
  if (remoteFullCorpusScans > 0) {
    violations.push(`remote full-corpus scans: ${remoteFullCorpusScans}`);
  }

  return {
    convergenceFailures,
    deltaBatches,
    localReplicaScans,
    remoteFullCorpusScans,
    stateRows: state.size,
    violations,
  };
}

export type DeviceTraceStep = {
  generation: number;
  kind:
    | "atomic-publish"
    | "consumer-read"
    | "local-derivation-scan"
    | "production-corpus-scan"
    | "replica-sync"
    | "validate-generation";
  rows?: number;
};

export type DeviceConvergenceReport = {
  atomicityViolations: number;
  atomicPublishes: number;
  convergenceFailures: number;
  latestGeneration: number;
  localReplicaScans: number;
  productionCorpusScans: number;
  publishedGeneration: number;
  repeatedProductionCorpusScans: number;
  replicaSyncs: number;
  violations: string[];
};

const DEFAULT_DEVICE_TRACE: readonly DeviceTraceStep[] = [
  { generation: 1, kind: "replica-sync" },
  { generation: 1, kind: "local-derivation-scan", rows: 3 },
  { generation: 1, kind: "validate-generation" },
  { generation: 1, kind: "atomic-publish" },
  { generation: 1, kind: "consumer-read" },
  { generation: 2, kind: "replica-sync" },
  { generation: 2, kind: "local-derivation-scan", rows: 4 },
  { generation: 2, kind: "validate-generation" },
  { generation: 2, kind: "atomic-publish" },
  { generation: 2, kind: "consumer-read" },
];

/** Model a local source replica, validated temp generation, and atomic publication pointer. */
export function simulateDeviceConvergence(
  trace: readonly DeviceTraceStep[] = DEFAULT_DEVICE_TRACE,
): DeviceConvergenceReport {
  const violations: string[] = [];
  const validated = new Set<number>();
  let activeGeneration = 0;
  let latestGeneration = 0;
  let localReplicaScans = 0;
  let productionCorpusScans = 0;
  let replicaSyncs = 0;
  let atomicPublishes = 0;
  let atomicityViolations = 0;
  let convergenceFailures = 0;

  if (trace.length === 0 || trace.length > 100) {
    violations.push("device derivation trace is outside its bounded proof range");
    convergenceFailures += 1;
  }

  for (const step of trace) {
    if (
      typeof step !== "object" ||
      step === null ||
      ![
        "atomic-publish",
        "consumer-read",
        "local-derivation-scan",
        "production-corpus-scan",
        "replica-sync",
        "validate-generation",
      ].includes(step.kind)
    ) {
      violations.push("device derivation trace step is malformed");
      convergenceFailures += 1;
      continue;
    }
    if (!Number.isSafeInteger(step.generation) || step.generation < 1) {
      violations.push("device generation is malformed");
      convergenceFailures += 1;
      continue;
    }
    latestGeneration = Math.max(latestGeneration, step.generation);

    if (step.kind === "replica-sync") {
      replicaSyncs += 1;
    }
    if (step.kind === "local-derivation-scan") {
      localReplicaScans += 1;
      if (!Number.isSafeInteger(step.rows) || (step.rows ?? 0) < 0 || (step.rows ?? 0) > 100_000) {
        violations.push("device local derivation scan exceeded its bounded row page");
        convergenceFailures += 1;
      }
    }
    if (step.kind === "production-corpus-scan") {
      productionCorpusScans += 1;
      if (step.generation <= latestGeneration) {
        convergenceFailures += 1;
        violations.push("device derivation scanned the production corpus after replica sync");
      }
    }
    if (step.kind === "validate-generation") {
      validated.add(step.generation);
    }
    if (step.kind === "atomic-publish") {
      if (!validated.has(step.generation)) {
        atomicityViolations += 1;
        violations.push("device generation was published before validation");
      }
      if (step.generation < activeGeneration) {
        atomicityViolations += 1;
        violations.push("device generation moved backwards");
      }
      activeGeneration = step.generation;
      atomicPublishes += 1;
    }
    if (step.kind === "consumer-read" && activeGeneration !== step.generation) {
      convergenceFailures += 1;
      violations.push("device consumer read a generation other than the atomically published one");
    }
  }

  const repeatedProductionCorpusScans = productionCorpusScans;
  if (replicaSyncs === 0 || atomicPublishes === 0 || activeGeneration !== latestGeneration) {
    convergenceFailures += 1;
    violations.push("device artifact did not converge on the latest local replica generation");
  }
  if (repeatedProductionCorpusScans > 0) {
    violations.push(`repeated production-corpus scans: ${repeatedProductionCorpusScans}`);
  }

  return {
    atomicPublishes,
    atomicityViolations,
    convergenceFailures,
    latestGeneration,
    localReplicaScans,
    productionCorpusScans,
    publishedGeneration: activeGeneration,
    repeatedProductionCorpusScans,
    replicaSyncs,
    violations,
  };
}

export type AssertionReport = { checks: number; failures: string[] };

function assertionReport(): AssertionReport {
  return { checks: 0, failures: [] };
}

function requireText(report: AssertionReport, source: string, label: string, text: string): void {
  report.checks += 1;
  if (!source.includes(text)) {
    report.failures.push(label);
  }
}

function requireCount(
  report: AssertionReport,
  source: string,
  label: string,
  text: string,
  minimum: number,
): void {
  report.checks += 1;
  let count = 0;
  let cursor = 0;
  while (true) {
    const found = source.indexOf(text, cursor);
    if (found < 0) {
      break;
    }
    count += 1;
    cursor = found + text.length;
  }
  if (count < minimum) {
    report.failures.push(label);
  }
}

function forbidPattern(
  report: AssertionReport,
  source: string,
  label: string,
  pattern: RegExp,
): void {
  report.checks += 1;
  if (pattern.test(source)) {
    report.failures.push(label);
  }
}

export function checkAdmissionArchitecture(
  admissionSource: string,
  registrySource: string,
): AssertionReport {
  const report = assertionReport();
  for (const [label, text] of [
    ["admission lane declaration", 'export type DatabaseAdmissionLane = "heavy-read" | "write";'],
    ["admission durable write batch", "const results = await client.batch("],
    ["admission FIFO timestamp ordering", "order by enqueued_at_ms asc, contender_id asc limit 1"],
    ["admission fencing increment", "next_fencing_token = next_fencing_token + 1"],
    [
      "admission exact fencing guard",
      "where contender_id = ? and fencing_token = ? and state = 'active'",
    ],
    ["admission unexpired lease guard", "lease_expires_at_ms > ?"],
    ["admission database-clock read", "unixepoch('subsec')"],
    ["admission retry ceiling", "DATABASE_ADMISSION_TRANSACTION_RETRIES"],
    ["admission coordinator", "export async function coordinateDatabaseAdmissionFor("],
    ["admission cross-resource predicate", "function conflictingResourcePredicate("],
  ] as const) {
    requireText(report, admissionSource, label, text);
  }
  requireCount(
    report,
    admissionSource,
    "admission FIFO ordering is not reused for both state transitions",
    "order by enqueued_at_ms asc, contender_id asc limit 1",
    2,
  );
  requireText(
    report,
    registrySource,
    "heavy-read registry classification",
    'accessClass: "heavy-read"',
  );
  requireText(report, registrySource, "heavy recurring operation classification", "heavy: true");
  return report;
}

export function checkReceiptArchitecture(receiptSource: string): AssertionReport {
  const report = assertionReport();
  for (const [label, text] of [
    ["receipt execution", "export async function executeReceiptBackedOperation("],
    ["receipt reconciliation", "export async function reconcileOperationReceipt("],
    ["receipt preflight lookup", "const preflight = await lookupReceipt("],
    ["receipt ambiguous lookup", "const reconciled = await lookupReceipt("],
    [
      "receipt absent is safely retryable",
      'const outcome = reconciled.kind === "found" ? reconciled.outcome : safelyRetryableOutcome();',
    ],
    ["receipt accepted state", 'if (row.state === "accepted")'],
    ["receipt terminal state guard", 'row.state !== "committed" && row.state !== "rejected"'],
    ["receipt canonical result validation", "canonicalResult !== row.result_json"],
    ["receipt effect commit", "await transaction.commit();"],
  ] as const) {
    requireText(report, receiptSource, label, text);
  }
  return report;
}

export function checkSonarArchitecture(
  replicaSource: string,
  consumerSource: string,
  stateSource: string,
): AssertionReport {
  const report = assertionReport();
  for (const [label, text] of [
    ["Sonar embedded remote replica", "Builder::new_remote_replica"],
    ["Sonar explicit replica sync", "pub async fn sync(&self)"],
    ["Sonar corpus query uses local connection", ".query(TRACKS_SQL"],
    ["Sonar local track stream", "streaming tracks from local replica"],
    ["Sonar bounded local snapshot page", "pub async fn snapshot_page("],
    ["Sonar delta API", "self.api.changes(self.batch_limit).await?"],
    ["Sonar delta state apply", "self.state.apply_batch(&batch, now_unix()).await?"],
    ["Sonar local reconciliation", ".replace_from_local_replica(&self.replica"],
    ["Sonar local reconcile entrypoint", "pub async fn reconcile_local("],
    ["Sonar durable state delta method", "pub async fn apply_batch("],
    ["Sonar durable state transaction", "TransactionBehavior::Immediate"],
    ["Sonar durable state manifest", "write_manifest(&tx"],
  ] as const) {
    requireText(report, `${replicaSource}\n${consumerSource}\n${stateSource}`, label, text);
  }
  requireText(
    report,
    replicaSource,
    "Sonar corpus query is not executed on the embedded connection",
    "self.conn\n            .query(TRACKS_SQL",
  );
  requireCount(
    report,
    consumerSource,
    "Sonar sync is not used by refresh paths",
    "self.replica.sync().await?",
    2,
  );
  forbidPattern(
    report,
    consumerSource,
    "Sonar consumer calls a remote full-corpus method",
    /\b(?:self\.)?api\.(?:tracks|centroids|full_corpus|scan)\s*\(/i,
  );
  forbidPattern(
    report,
    replicaSource,
    "Sonar replica uses a remote corpus query outside sync",
    /remote\.(?:tracks|centroids|full_corpus|scan)\s*\(/i,
  );
  return report;
}

export function checkDeviceArchitecture(
  runnerSource: string,
  derivationSource: string,
): AssertionReport {
  const report = assertionReport();
  for (const [label, text] of [
    ["device stable source check", "await assertStableSource(args.source);"],
    ["device source watermark", "const sourceWatermark = await sha256File(args.source);"],
    ["device temporary generation", "const temporaryOut = `${args.out}.tmp`;"],
    ["device transactional copy", "const copy = output.transaction(() => {"],
    ["device immediate copy", "copy.immediate();"],
    ["device artifact validation", "const validation = await validateDeviceArtifact(temporaryOut,"],
    [
      "device post-copy watermark",
      "const sourceWatermarkAfterDerivation = await sha256File(args.source);",
    ],
    ["device source mutation guard", "if (sourceWatermarkAfterDerivation !== sourceWatermark)"],
    ["device atomic publish call", "await publish(temporaryOut, args.out);"],
    ["device selected-id materialization", "materializeSelectedTrackIdsSql"],
    ["device ordered row selection", "selectDeviceRowsSql"],
    [
      "device temporary source attach",
      'output.query("ATTACH DATABASE ? AS source").run(args.source);',
    ],
    ["device temporary source detach", 'output.run("DETACH DATABASE source");'],
    ["device fsynced rename", "await rename(temporaryPath, destinationPath);"],
  ] as const) {
    requireText(report, `${runnerSource}\n${derivationSource}`, label, text);
  }
  forbidPattern(
    report,
    runnerSource,
    "device publication unlinks destination before rename",
    /rm\(args\.out/,
  );

  const selectedSql = materializeSelectedTrackIdsSql("anchored", "1 = 1");
  const trackSql = selectDeviceRowsSql("tracks", "anchored");
  requireText(
    report,
    selectedSql.join("\n"),
    "device selection does not create a temp relation",
    "CREATE TEMP TABLE",
  );
  requireText(
    report,
    selectedSql.join("\n"),
    "device selection does not materialize selected IDs",
    "device_selected_track_ids",
  );
  requireText(
    report,
    trackSql,
    "device track copy is not joined to selected IDs",
    "device_selected_track_ids",
  );
  requireText(report, trackSql, "device track copy is not deterministically ordered", "ORDER BY");
  forbidPattern(
    report,
    trackSql,
    "device track projection leaks embedding columns",
    /embedding_blob/i,
  );
  return report;
}

type FinalProofSourceBundle = {
  admission: string;
  deviceDerivation: string;
  deviceRunner: string;
  operationRegistry: string;
  receipt: string;
  sonarConsumer: string;
  sonarReplica: string;
  sonarState: string;
};

const SOURCE_PATHS = {
  admission: join(import.meta.dirname, "../../src/lib/server/database-admission.ts"),
  deviceDerivation: join(import.meta.dirname, "../lib/device-db-derivation.ts"),
  deviceRunner: join(import.meta.dirname, "../derive-device-db.ts"),
  operationRegistry: join(
    import.meta.dirname,
    "../../src/lib/server/database-operation-registry.ts",
  ),
  receipt: join(import.meta.dirname, "../../src/lib/server/operation-receipts.ts"),
  sonarConsumer: join(import.meta.dirname, "../../../sonar/src/consumer.rs"),
  sonarReplica: join(import.meta.dirname, "../../../sonar/src/replica.rs"),
  sonarState: join(import.meta.dirname, "../../../sonar/src/state.rs"),
} as const;

async function readSource(path: string): Promise<string> {
  return readFile(path, "utf8");
}

async function readFinalProofSourceBundle(): Promise<FinalProofSourceBundle> {
  const entries = await Promise.all(
    Object.entries(SOURCE_PATHS).map(
      async ([name, path]) => [name, await readSource(path)] as const,
    ),
  );

  return Object.fromEntries(entries) as FinalProofSourceBundle;
}

let sourceEvidencePromise: Promise<{ checks: number; failures: string[] }> | undefined;

export async function finalProofArchitectureEvidence(): Promise<{
  checks: number;
  failures: string[];
}> {
  sourceEvidencePromise ??= readFinalProofSourceBundle()
    .then((source) => {
      const reports = [
        checkAdmissionArchitecture(source.admission, source.operationRegistry),
        checkReceiptArchitecture(source.receipt),
        checkSonarArchitecture(source.sonarReplica, source.sonarConsumer, source.sonarState),
        checkDeviceArchitecture(source.deviceRunner, source.deviceDerivation),
      ];
      return {
        checks: reports.reduce((sum, report) => sum + report.checks, 0),
        failures: reports.flatMap((report) => report.failures),
      };
    })
    .catch((error: unknown) => ({
      checks: Object.keys(SOURCE_PATHS).length,
      failures: [
        `final proof source evidence unavailable: ${error instanceof Error ? error.name : "unknown"}`,
      ],
    }));

  return sourceEvidencePromise;
}

function proofExecution(
  context: ContractContext,
  startedAt: number,
  metadata: Record<string, boolean | number | string | null>,
  invariants: ContractExecution["invariants"],
  resultRowCount: number,
  queueMs?: number,
): ContractExecution {
  return {
    durationMs: Math.max(0, context.now() - startedAt),
    invariants,
    metadata,
    queueMs,
    resultRowCount,
  };
}

function sourceShapeModelMetadata(
  context: ContractContext,
  evidence: Record<string, boolean | number | string | null>,
): Record<string, boolean | number | string | null> {
  return {
    evidenceKind: "source-shape-model-check",
    profile: context.profile,
    profileScaleExecution: false,
    ...evidence,
  };
}

async function executeAdmissionProof(context: ContractContext): Promise<ContractExecution> {
  const startedAt = context.now();
  const simulation = simulateFencedAdmission();
  const architecture = await finalProofArchitectureEvidence();

  return proofExecution(
    context,
    startedAt,
    sourceShapeModelMetadata(context, {
      architectureChecks: architecture.checks,
      architectureFailures: architecture.failures.length,
      architecturePassed: architecture.failures.length === 0,
      converged: simulation.convergenceFailures === 0,
      fencingViolations: simulation.fencingViolations,
      fifoViolations: simulation.fifoViolations,
      maxAdmissionWaitMs: simulation.maxWaitMs,
      staleFenceRejected: simulation.staleFenceRejected,
      uncontendedAcquisitionMs: simulation.uncontendedAcquisitionMs,
      uncontendedAcquisitionViolations: simulation.uncontendedAcquisitionViolations,
      violationCount: simulation.violations.length,
      violationEvidence: simulation.violations.join("; "),
    }),
    {
      architectureFailures: architecture.failures.length,
      convergenceFailures: simulation.convergenceFailures,
      fencingViolations: simulation.fencingViolations,
      fifoViolations: simulation.fifoViolations,
      uncontendedAcquisitionViolations: simulation.uncontendedAcquisitionViolations,
    },
    simulation.events.length,
    simulation.maxWaitMs,
  );
}

function validateAdmissionProof(execution: ContractExecution): readonly string[] {
  const metadata = execution.metadata ?? {};
  const failures: string[] = [];
  for (const field of ["architecturePassed", "converged", "staleFenceRejected"] as const) {
    if (metadata[field] !== true) {
      failures.push(`admission ${field} proof failed`);
    }
  }
  if (metadata.fifoViolations !== 0 || metadata.fencingViolations !== 0) {
    failures.push("admission ordering or fencing violations were observed");
  }
  if (metadata.uncontendedAcquisitionViolations !== 0) {
    failures.push("uncontended admission acquisition was not bounded");
  }
  return failures;
}

async function executeReceiptProof(context: ContractContext): Promise<ContractExecution> {
  const startedAt = context.now();
  const classification = classifyReceiptStates();
  const architecture = await finalProofArchitectureEvidence();
  const counts = classification.outcomeCounts;

  return proofExecution(
    context,
    startedAt,
    sourceShapeModelMetadata(context, {
      architectureChecks: architecture.checks,
      architectureFailures: architecture.failures.length,
      architecturePassed: architecture.failures.length === 0,
      classifiedOutcomes: classification.classifiedOutcomes,
      committedOutcomes: counts.committed,
      conflictOutcomes: counts.conflict,
      inProgressOutcomes: counts["in-progress"],
      lookupFailedOutcomes: counts["lookup-failed"],
      rejectedOutcomes: counts.rejected,
      safelyRetryableOutcomes: counts["safely-retryable"],
      scenarios: classification.scenarios,
      unresolvedOutcomes: classification.unresolvedOutcomes,
      violationCount: classification.violations.length,
    }),
    {
      ambiguousOutcomes: classification.unresolvedOutcomes,
      architectureFailures: architecture.failures.length,
    },
    classification.scenarios,
  );
}

function validateReceiptProof(execution: ContractExecution): readonly string[] {
  const metadata = execution.metadata ?? {};
  const failures: string[] = [];
  if (metadata.architecturePassed !== true) {
    failures.push("receipt source architecture assertions failed");
  }
  if (metadata.classifiedOutcomes !== metadata.scenarios) {
    failures.push("not every receipt ambiguity was classified");
  }
  if (metadata.unresolvedOutcomes !== 0) {
    failures.push("receipt ambiguity left unresolved outcomes");
  }
  return failures;
}

async function executeSonarProof(context: ContractContext): Promise<ContractExecution> {
  const startedAt = context.now();
  const simulation = simulateSonarConvergence();
  const architecture = await finalProofArchitectureEvidence();

  return proofExecution(
    context,
    startedAt,
    sourceShapeModelMetadata(context, {
      architectureChecks: architecture.checks,
      architectureFailures: architecture.failures.length,
      architecturePassed: architecture.failures.length === 0,
      converged: simulation.convergenceFailures === 0,
      deltaBatches: simulation.deltaBatches,
      localReplicaScans: simulation.localReplicaScans,
      remoteFullCorpusScans: simulation.remoteFullCorpusScans,
      stateRows: simulation.stateRows,
      violationCount: simulation.violations.length,
    }),
    {
      architectureFailures: architecture.failures.length,
      convergenceFailures: simulation.convergenceFailures,
      remoteFullCorpusScans: simulation.remoteFullCorpusScans,
    },
    simulation.stateRows,
  );
}

function validateSonarProof(execution: ContractExecution): readonly string[] {
  const metadata = execution.metadata ?? {};
  const failures: string[] = [];
  if (metadata.architecturePassed !== true || metadata.converged !== true) {
    failures.push("Sonar local-replica/delta convergence proof failed");
  }
  if (metadata.remoteFullCorpusScans !== 0) {
    failures.push("Sonar performed a remote full-corpus steady-state scan");
  }
  if (metadata.deltaBatches === 0 || metadata.localReplicaScans === 0) {
    failures.push("Sonar proof did not exercise both delta and local-replica paths");
  }
  return failures;
}

async function executeDeviceProof(context: ContractContext): Promise<ContractExecution> {
  const startedAt = context.now();
  const simulation = simulateDeviceConvergence();
  const architecture = await finalProofArchitectureEvidence();

  return proofExecution(
    context,
    startedAt,
    sourceShapeModelMetadata(context, {
      architectureChecks: architecture.checks,
      architectureFailures: architecture.failures.length,
      architecturePassed: architecture.failures.length === 0,
      atomicPublishes: simulation.atomicPublishes,
      atomicityViolations: simulation.atomicityViolations,
      converged: simulation.convergenceFailures === 0,
      latestGeneration: simulation.latestGeneration,
      localReplicaScans: simulation.localReplicaScans,
      productionCorpusScans: simulation.productionCorpusScans,
      publishedGeneration: simulation.publishedGeneration,
      repeatedProductionCorpusScans: simulation.repeatedProductionCorpusScans,
      replicaSyncs: simulation.replicaSyncs,
      violationCount: simulation.violations.length,
    }),
    {
      architectureFailures: architecture.failures.length,
      atomicityViolations: simulation.atomicityViolations,
      convergenceFailures: simulation.convergenceFailures,
      repeatedProductionCorpusScans: simulation.repeatedProductionCorpusScans,
    },
    simulation.atomicPublishes,
  );
}

function validateDeviceProof(execution: ContractExecution): readonly string[] {
  const metadata = execution.metadata ?? {};
  const failures: string[] = [];
  if (metadata.architecturePassed !== true || metadata.converged !== true) {
    failures.push("device local-replica/atomic-generation convergence proof failed");
  }
  if (metadata.repeatedProductionCorpusScans !== 0) {
    failures.push("device derivation repeated a production-corpus scan");
  }
  if (metadata.atomicityViolations !== 0) {
    failures.push("device artifact publication was not atomic");
  }
  return failures;
}

export function finalProofContracts(): PerformanceContract[] {
  return [
    {
      description: "Source-shape model check: fenced writer and heavy-reader admission rules",
      execute: executeAdmissionProof,
      id: FINAL_PROOF_CONTRACT_IDS[0],
      iterations: 8,
      validate: validateAdmissionProof,
      warmupIterations: 1,
      workClass: "writer-admission",
    },
    {
      description:
        "Source-shape model check: receipt ambiguity classification before retry authorization",
      execute: executeReceiptProof,
      id: FINAL_PROOF_CONTRACT_IDS[2],
      iterations: 8,
      validate: validateReceiptProof,
      warmupIterations: 1,
      workClass: "mutation",
    },
    {
      description: "Source-shape model check: Sonar local replica and bounded delta architecture",
      execute: executeSonarProof,
      id: FINAL_PROOF_CONTRACT_IDS[3],
      iterations: 8,
      validate: validateSonarProof,
      warmupIterations: 1,
      workClass: "sonar-refresh",
    },
    {
      description:
        "Source-shape model check: device local replica and atomic publication architecture",
      execute: executeDeviceProof,
      id: FINAL_PROOF_CONTRACT_IDS[1],
      iterations: 8,
      validate: validateDeviceProof,
      warmupIterations: 1,
      workClass: "device-derivation",
    },
  ];
}

export function registerFinalProofContracts(registry: PerformanceRegistry): void {
  for (const contract of finalProofContracts()) {
    registry.register(contract);
  }
}

export const FINAL_PROOF_REPORT_SCHEMA_VERSION = PERFORMANCE_REPORT_SCHEMA_VERSION;
