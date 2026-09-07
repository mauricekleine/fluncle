import { distribution } from "./budgets";
import {
  PRIMARY_DB_CONCURRENCY,
  WORKER_DB_AGGREGATE_CONCURRENCY,
  WORKER_DB_HEAVY_READ_CONCURRENCY,
} from "../../src/lib/database-concurrency";
import {
  DATABASE_CLIENT_BOUNDS,
  type DatabaseClientClass,
  validateClientBounds,
} from "./client-bounds";

export type MixedLoadClass = "heavy-reader" | "public-read" | "write-batch";

export type MixedLoadOperation = {
  arrivalMs: number;
  batchCount: number | null;
  clientClass: DatabaseClientClass;
  durationMs: number;
  id: string;
  workClass: MixedLoadClass;
};

export type MixedLoadEvent = MixedLoadOperation & {
  completedAtMs: number;
  latencyMs: number;
  queueMs: number;
  startedAtMs: number;
};

export type MixedLoadReport = {
  bounds: Readonly<Record<DatabaseClientClass, number>>;
  events: MixedLoadEvent[];
  latencyMs: Record<MixedLoadClass, ReturnType<typeof distribution>>;
  maxConcurrentByClient: Record<DatabaseClientClass, number>;
  queueMs: Record<MixedLoadClass, ReturnType<typeof distribution>>;
  scope: "per-client-simulator";
  violations: string[];
};

export type RequestWideMixedLoadOperation = MixedLoadOperation & {
  clientId: string;
  requestId: string;
};

export type RequestWideMixedLoadReport = {
  aggregateCeiling: number;
  aggregateObservedMaximum: number;
  events: MixedLoadEvent[];
  fanoutPerPublicRequest: number;
  latencyMs: Record<MixedLoadClass, ReturnType<typeof distribution>>;
  maxConcurrentByClientInstance: Record<string, number>;
  publicReadsAdmittedBesideHeldReader: number;
  publicRequestCount: number;
  queueMs: Record<MixedLoadClass, ReturnType<typeof distribution>>;
  scope: "worker-isolate-simulator";
  violations: string[];
};

export const DEFAULT_MIXED_LOAD: readonly MixedLoadOperation[] = [
  {
    arrivalMs: 0,
    batchCount: null,
    clientClass: "primary",
    durationMs: 100,
    id: "heavy-reader-held",
    workClass: "heavy-reader",
  },
  ...Array.from(
    { length: 3 },
    (_, index): MixedLoadOperation => ({
      arrivalMs: 1,
      batchCount: null,
      clientClass: "primary",
      durationMs: 5,
      id: `public-read-${index + 1}`,
      workClass: "public-read",
    }),
  ),
  {
    arrivalMs: 1,
    batchCount: 4,
    clientClass: "primary",
    durationMs: 8,
    id: "write-batch-1",
    workClass: "write-batch",
  },
  {
    arrivalMs: 1,
    batchCount: 3,
    clientClass: "primary",
    durationMs: 8,
    id: "write-batch-2",
    workClass: "write-batch",
  },
] as const;

const REQUEST_WIDE_PUBLIC_REQUESTS = 3;

export const DEFAULT_REQUEST_WIDE_MIXED_LOAD: readonly RequestWideMixedLoadOperation[] = [
  {
    arrivalMs: 0,
    batchCount: null,
    clientClass: "primary",
    clientId: "held-heavy-client",
    durationMs: 100,
    id: "request-wide-heavy-reader-held",
    requestId: "held-heavy-request",
    workClass: "heavy-reader",
  },
  ...Array.from({ length: REQUEST_WIDE_PUBLIC_REQUESTS }, (_, requestIndex) =>
    Array.from(
      { length: PRIMARY_DB_CONCURRENCY },
      (_, queryIndex): RequestWideMixedLoadOperation => ({
        arrivalMs: 1,
        batchCount: null,
        clientClass: "primary",
        clientId: `public-client-${requestIndex + 1}`,
        durationMs: 5,
        id: `request-wide-public-${requestIndex + 1}-${queryIndex + 1}`,
        requestId: `public-request-${requestIndex + 1}`,
        workClass: "public-read",
      }),
    ),
  ).flat(),
  {
    arrivalMs: 2,
    batchCount: 4,
    clientClass: "primary",
    clientId: "writer-client",
    durationMs: 8,
    id: "request-wide-write-batch-1",
    requestId: "writer-request",
    workClass: "write-batch",
  },
  {
    arrivalMs: 2,
    batchCount: 3,
    clientClass: "primary",
    clientId: "writer-client",
    durationMs: 8,
    id: "request-wide-write-batch-2",
    requestId: "writer-request",
    workClass: "write-batch",
  },
] as const;

function emptyClassRecord(): Record<MixedLoadClass, number[]> {
  return { "heavy-reader": [], "public-read": [], "write-batch": [] };
}

/**
 * Deterministic discrete-event evidence for per-client bounds. The single write lane models
 * libSQL/SQLite transaction serialization inside this client scenario; it is not a fleet-wide or
 * cross-unit admission mechanism.
 */
export function simulateMixedLoad(
  options: {
    bounds?: Readonly<Record<DatabaseClientClass, number>>;
    operations?: readonly MixedLoadOperation[];
  } = {},
): MixedLoadReport {
  const bounds = options.bounds ?? DATABASE_CLIENT_BOUNDS;
  const operations = [...(options.operations ?? DEFAULT_MIXED_LOAD)].sort(
    (left, right) => left.arrivalMs - right.arrivalMs || left.id.localeCompare(right.id),
  );
  const activeByClient = new Map<DatabaseClientClass, number[]>();
  const maxConcurrentByClient = Object.fromEntries(
    Object.keys(DATABASE_CLIENT_BOUNDS).map((key) => [key, 0]),
  ) as Record<DatabaseClientClass, number>;
  const events: MixedLoadEvent[] = [];
  let writeLaneAvailableAt = 0;

  for (const operation of operations) {
    const active = (activeByClient.get(operation.clientClass) ?? []).filter(
      (completedAt) => completedAt > operation.arrivalMs,
    );
    const bound = bounds[operation.clientClass];
    let startedAtMs = operation.arrivalMs;

    if (active.length >= bound) {
      active.sort((left, right) => left - right);
      startedAtMs = active[active.length - bound] ?? operation.arrivalMs;
    }

    if (operation.workClass === "write-batch") {
      startedAtMs = Math.max(startedAtMs, writeLaneAvailableAt);
    }

    const stillActive = active.filter((completedAt) => completedAt > startedAtMs);
    const completedAtMs = startedAtMs + operation.durationMs;
    stillActive.push(completedAtMs);
    activeByClient.set(operation.clientClass, stillActive);
    maxConcurrentByClient[operation.clientClass] = Math.max(
      maxConcurrentByClient[operation.clientClass],
      stillActive.length,
    );

    if (operation.workClass === "write-batch") {
      writeLaneAvailableAt = completedAtMs;
    }

    events.push({
      ...operation,
      completedAtMs,
      latencyMs: completedAtMs - operation.arrivalMs,
      queueMs: startedAtMs - operation.arrivalMs,
      startedAtMs,
    });
  }

  const latencies = emptyClassRecord();
  const queues = emptyClassRecord();
  for (const event of events) {
    latencies[event.workClass].push(event.latencyMs);
    queues[event.workClass].push(event.queueMs);
  }

  const violations = validateClientBounds(bounds);
  const publicEvents = events.filter((event) => event.workClass === "public-read");
  const heldReader = events.find((event) => event.id === "heavy-reader-held");

  if (heldReader && publicEvents.some((event) => event.startedAtMs >= heldReader.completedAtMs)) {
    violations.push("public reads convoyed behind the held heavy reader");
  }

  const writes = events.filter((event) => event.workClass === "write-batch");
  for (let index = 1; index < writes.length; index += 1) {
    const previous = writes[index - 1];
    const current = writes[index];

    if (previous && current && current.startedAtMs < previous.completedAtMs) {
      violations.push("write batches overlapped instead of using the serialized write lane");
    }
  }

  for (const [clientClass, maximum] of Object.entries(maxConcurrentByClient) as [
    DatabaseClientClass,
    number,
  ][]) {
    if (maximum > bounds[clientClass]) {
      violations.push(`${clientClass} observed ${maximum} concurrent operations above its bound`);
    }
  }

  return {
    bounds,
    events,
    latencyMs: {
      "heavy-reader": distribution(latencies["heavy-reader"]),
      "public-read": distribution(latencies["public-read"]),
      "write-batch": distribution(latencies["write-batch"]),
    },
    maxConcurrentByClient,
    queueMs: {
      "heavy-reader": distribution(queues["heavy-reader"]),
      "public-read": distribution(queues["public-read"]),
      "write-batch": distribution(queues["write-batch"]),
    },
    scope: "per-client-simulator",
    violations,
  };
}

type ActiveRequestWideOperation = {
  completedAtMs: number;
  operation: RequestWideMixedLoadOperation;
};

type RequestWideSchedule = {
  active: ActiveRequestWideOperation[];
  aggregateObservedMaximum: number;
  clientSlotAvailableAt: Map<string, number[]>;
  events: MixedLoadEvent[];
  heavyReadsInFlight: number;
  maxConcurrentByClientInstance: Record<string, number>;
  queued: RequestWideMixedLoadOperation[];
  writeLaneAvailableAt: number;
};

function retireRequestWideOperations(state: RequestWideSchedule, currentTimeMs: number): void {
  for (let index = state.active.length - 1; index >= 0; index -= 1) {
    const candidate = state.active[index];
    if (candidate === undefined || candidate.completedAtMs > currentTimeMs) {
      continue;
    }

    state.active.splice(index, 1);
    if (candidate.operation.workClass === "heavy-reader") {
      state.heavyReadsInFlight -= 1;
    }
  }
}

function requestWideOperationCanStart(
  operation: RequestWideMixedLoadOperation,
  state: RequestWideSchedule,
): boolean {
  return (
    operation.workClass !== "heavy-reader" ||
    state.heavyReadsInFlight < WORKER_DB_HEAVY_READ_CONCURRENCY
  );
}

function admitRequestWideOperations(
  state: RequestWideSchedule,
  currentTimeMs: number,
  aggregateCeiling: number,
  bounds: Readonly<Record<DatabaseClientClass, number>>,
): void {
  while (state.active.length < aggregateCeiling) {
    const waiterIndex = state.queued.findIndex((operation) =>
      requestWideOperationCanStart(operation, state),
    );
    if (waiterIndex < 0) {
      return;
    }

    const [operation] = state.queued.splice(waiterIndex, 1);
    if (operation === undefined) {
      return;
    }
    const availableAt = (state.clientSlotAvailableAt.get(operation.clientId) ?? [])
      .filter((completionMs) => completionMs > currentTimeMs)
      .sort((left, right) => left - right);
    let startedAtMs = currentTimeMs;
    if (availableAt.length >= bounds[operation.clientClass]) {
      startedAtMs = Math.max(startedAtMs, availableAt.shift() ?? currentTimeMs);
    }
    if (operation.workClass === "write-batch") {
      startedAtMs = Math.max(startedAtMs, state.writeLaneAvailableAt);
    }
    const occupiedSlots = availableAt.filter((completionMs) => completionMs > startedAtMs);
    const completedAtMs = startedAtMs + operation.durationMs;
    const clientConcurrency = occupiedSlots.length + 1;
    state.clientSlotAvailableAt.set(operation.clientId, [...occupiedSlots, completedAtMs]);
    state.maxConcurrentByClientInstance[operation.clientId] = Math.max(
      state.maxConcurrentByClientInstance[operation.clientId] ?? 0,
      clientConcurrency,
    );
    if (operation.workClass === "heavy-reader") {
      state.heavyReadsInFlight += 1;
    }
    if (operation.workClass === "write-batch") {
      state.writeLaneAvailableAt = completedAtMs;
    }
    state.active.push({ completedAtMs, operation });
    state.aggregateObservedMaximum = Math.max(state.aggregateObservedMaximum, state.active.length);
    state.events.push({
      ...operation,
      completedAtMs,
      latencyMs: completedAtMs - operation.arrivalMs,
      queueMs: startedAtMs - operation.arrivalMs,
      startedAtMs,
    });
  }
}

function scheduleRequestWideOperations(
  operations: readonly RequestWideMixedLoadOperation[],
  aggregateCeiling: number,
  bounds: Readonly<Record<DatabaseClientClass, number>>,
): RequestWideSchedule {
  const scheduled = operations
    .map((operation, sequence) => ({ operation, sequence }))
    .sort(
      (left, right) =>
        left.operation.arrivalMs - right.operation.arrivalMs || left.sequence - right.sequence,
    );
  const state: RequestWideSchedule = {
    active: [],
    aggregateObservedMaximum: 0,
    clientSlotAvailableAt: new Map(),
    events: [],
    heavyReadsInFlight: 0,
    maxConcurrentByClientInstance: {},
    queued: [],
    writeLaneAvailableAt: 0,
  };
  let currentTimeMs = scheduled[0]?.operation.arrivalMs ?? 0;
  let nextArrivalIndex = 0;

  while (
    nextArrivalIndex < scheduled.length ||
    state.queued.length > 0 ||
    state.active.length > 0
  ) {
    retireRequestWideOperations(state, currentTimeMs);
    while (
      nextArrivalIndex < scheduled.length &&
      (scheduled[nextArrivalIndex]?.operation.arrivalMs ?? Number.POSITIVE_INFINITY) <=
        currentTimeMs
    ) {
      const arrival = scheduled[nextArrivalIndex];
      if (arrival !== undefined) {
        state.queued.push(arrival.operation);
      }
      nextArrivalIndex += 1;
    }
    admitRequestWideOperations(state, currentTimeMs, aggregateCeiling, bounds);

    if (
      nextArrivalIndex >= scheduled.length &&
      state.queued.length === 0 &&
      state.active.length === 0
    ) {
      break;
    }
    const nextArrivalMs =
      scheduled[nextArrivalIndex]?.operation.arrivalMs ?? Number.POSITIVE_INFINITY;
    const nextCompletionMs = state.active.reduce(
      (minimum, operation) => Math.min(minimum, operation.completedAtMs),
      Number.POSITIVE_INFINITY,
    );
    const nextTimeMs = Math.min(nextArrivalMs, nextCompletionMs);
    if (!Number.isFinite(nextTimeMs)) {
      throw new Error("request-wide mixed-load scheduler cannot make progress");
    }
    currentTimeMs = nextTimeMs;
  }

  return state;
}

function validateRequestWideSchedule(
  operations: readonly RequestWideMixedLoadOperation[],
  state: RequestWideSchedule,
  aggregateCeiling: number,
  bounds: Readonly<Record<DatabaseClientClass, number>>,
): string[] {
  const violations = validateClientBounds(bounds);
  if (aggregateCeiling !== WORKER_DB_AGGREGATE_CONCURRENCY) {
    violations.push(
      `Worker aggregate ceiling ${aggregateCeiling} differs from the contract ${WORKER_DB_AGGREGATE_CONCURRENCY}`,
    );
  }
  if (state.aggregateObservedMaximum > aggregateCeiling) {
    violations.push(
      `Worker observed ${state.aggregateObservedMaximum} concurrent operations above its aggregate ceiling`,
    );
  }
  for (const clientId of new Set(operations.map((operation) => operation.clientId))) {
    const operation = operations.find((candidate) => candidate.clientId === clientId);
    const maximum = state.maxConcurrentByClientInstance[clientId] ?? 0;
    if (operation !== undefined && maximum > bounds[operation.clientClass]) {
      violations.push(`${clientId} observed ${maximum} operations above its client bound`);
    }
  }
  return violations;
}

/**
 * Several request-local clients each fan out to their own limit while one isolate-wide gate owns
 * the real remote-operation ceiling. The heavy-read lane remains separately bounded so queued
 * heavy work cannot consume or convoy the three ordinary seats beside a held heavy reader.
 */
export function simulateRequestWideMixedLoad(
  options: {
    aggregateCeiling?: number;
    bounds?: Readonly<Record<DatabaseClientClass, number>>;
    operations?: readonly RequestWideMixedLoadOperation[];
  } = {},
): RequestWideMixedLoadReport {
  const aggregateCeiling = options.aggregateCeiling ?? WORKER_DB_AGGREGATE_CONCURRENCY;
  const bounds = options.bounds ?? DATABASE_CLIENT_BOUNDS;
  const operations = options.operations ?? DEFAULT_REQUEST_WIDE_MIXED_LOAD;
  const state = scheduleRequestWideOperations(operations, aggregateCeiling, bounds);

  const latencies = emptyClassRecord();
  const queues = emptyClassRecord();
  for (const event of state.events) {
    latencies[event.workClass].push(event.latencyMs);
    queues[event.workClass].push(event.queueMs);
  }

  const violations = validateRequestWideSchedule(operations, state, aggregateCeiling, bounds);

  const publicRequestIds = new Set(
    operations
      .filter((operation) => operation.workClass === "public-read")
      .map((operation) => operation.requestId),
  );
  const publicFanouts = [...publicRequestIds].map(
    (requestId) => operations.filter((operation) => operation.requestId === requestId).length,
  );
  const fanoutPerPublicRequest = publicFanouts[0] ?? 0;
  if (publicFanouts.some((fanout) => fanout !== PRIMARY_DB_CONCURRENCY)) {
    violations.push("concurrent public requests do not each fan out to the primary client bound");
  }
  const heldReader = state.events.find((event) => event.id === "request-wide-heavy-reader-held");
  const publicReadsAdmittedBesideHeldReader = heldReader
    ? state.events.filter(
        (event) =>
          event.workClass === "public-read" && event.startedAtMs < heldReader.completedAtMs,
      ).length
    : 0;
  const expectedPublicSeats = aggregateCeiling - WORKER_DB_HEAVY_READ_CONCURRENCY;
  if (heldReader && publicReadsAdmittedBesideHeldReader < expectedPublicSeats) {
    violations.push("public reads convoyed behind the held request-wide heavy reader");
  }

  return {
    aggregateCeiling,
    aggregateObservedMaximum: state.aggregateObservedMaximum,
    events: state.events,
    fanoutPerPublicRequest,
    latencyMs: {
      "heavy-reader": distribution(latencies["heavy-reader"]),
      "public-read": distribution(latencies["public-read"]),
      "write-batch": distribution(latencies["write-batch"]),
    },
    maxConcurrentByClientInstance: state.maxConcurrentByClientInstance,
    publicReadsAdmittedBesideHeldReader,
    publicRequestCount: publicRequestIds.size,
    queueMs: {
      "heavy-reader": distribution(queues["heavy-reader"]),
      "public-read": distribution(queues["public-read"]),
      "write-batch": distribution(queues["write-batch"]),
    },
    scope: "worker-isolate-simulator",
    violations,
  };
}
