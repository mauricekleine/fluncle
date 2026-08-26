import { distribution } from "./budgets";
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
