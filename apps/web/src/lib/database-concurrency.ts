import { ApiError } from "./server/api-error";
import { logEvent } from "./server/log";

export const PRIMARY_DB_CONCURRENCY = 4;

export const WORKER_DB_AGGREGATE_CONCURRENCY = 4;

export const WORKER_DB_HEAVY_READ_CONCURRENCY = 1;

export const TELEMETRY_DB_CONCURRENCY = 3;

export const CATALOGUE_PUBLIC_ENTITY_COUNT_DB_CONCURRENCY = 3;

export const REMOTE_DB_CONCURRENCY = 1;

export const LOCAL_DB_CONCURRENCY = 1;

export type WorkerDatabaseAccessClass = "heavy-read" | "read" | "write";

export type WorkerDatabaseConcurrencyLease = {
  aggregateInFlight: number;
  isActive: () => boolean;
  queueWaitMs: number;
  release: () => void;
};

export type WorkerDatabaseConcurrencySnapshot = {
  aggregateInFlight: number;
  aggregateObservedMaximum: number;
};

export const WORKER_DB_ADMISSION_POLL_MAX_MS = 10;

export const WORKER_DB_QUEUE_WAIT_MAX_MS = 60_000;

export const WORKER_DB_LEASE_HOLD_MAX_MS = 300_000;

type HeldDatabaseLease = {
  accessClass: WorkerDatabaseAccessClass;
  acquiredAtMs: number;
};

function waitForAdmissionTurn(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

export class WorkerDatabaseConcurrencyGate {
  readonly #aggregateCeiling: number;
  readonly #heavyReadCeiling: number;
  readonly #leases = new Set<HeldDatabaseLease>();
  #aggregateInFlight = 0;
  #aggregateObservedMaximum = 0;
  #heavyReadsInFlight = 0;

  constructor(
    aggregateCeiling = WORKER_DB_AGGREGATE_CONCURRENCY,
    heavyReadCeiling = WORKER_DB_HEAVY_READ_CONCURRENCY,
  ) {
    if (!Number.isSafeInteger(aggregateCeiling) || aggregateCeiling < 1) {
      throw new Error("aggregate database concurrency ceiling must be a positive integer");
    }
    if (
      !Number.isSafeInteger(heavyReadCeiling) ||
      heavyReadCeiling < 1 ||
      heavyReadCeiling > aggregateCeiling
    ) {
      throw new Error("heavy-read database concurrency ceiling must fit the aggregate ceiling");
    }

    this.#aggregateCeiling = aggregateCeiling;
    this.#heavyReadCeiling = heavyReadCeiling;
  }

  async acquire(
    accessClass: WorkerDatabaseAccessClass,
    reentrantLease?: () => WorkerDatabaseConcurrencyLease | undefined,
  ): Promise<WorkerDatabaseConcurrencyLease> {
    const enqueuedAtMs = Date.now();
    let pollMs = 1;

    for (;;) {
      const nowMs = Date.now();
      const queueWaitMs = Math.max(0, nowMs - enqueuedAtMs);
      if (queueWaitMs >= WORKER_DB_QUEUE_WAIT_MAX_MS) {
        logEvent("warn", "database.admission-timeout", { accessClass, queueWaitMs });
        throw new ApiError("database_busy", "Try again in a minute.", 503);
      }

      const lease = reentrantLease?.() ?? this.#tryAcquire(accessClass, queueWaitMs, nowMs);
      if (lease !== undefined) {
        return lease;
      }

      await waitForAdmissionTurn(Math.min(pollMs, WORKER_DB_QUEUE_WAIT_MAX_MS - queueWaitMs));
      pollMs = Math.min(pollMs * 2, WORKER_DB_ADMISSION_POLL_MAX_MS);
    }
  }

  snapshot(): WorkerDatabaseConcurrencySnapshot {
    this.#reclaimLostLeases(Date.now());
    return {
      aggregateInFlight: this.#aggregateInFlight,
      aggregateObservedMaximum: this.#aggregateObservedMaximum,
    };
  }

  #canAdmit(accessClass: WorkerDatabaseAccessClass): boolean {
    return (
      this.#aggregateInFlight < this.#aggregateCeiling &&
      (accessClass !== "heavy-read" || this.#heavyReadsInFlight < this.#heavyReadCeiling)
    );
  }

  #tryAcquire(
    accessClass: WorkerDatabaseAccessClass,
    queueWaitMs: number,
    nowMs: number,
  ): WorkerDatabaseConcurrencyLease | undefined {
    this.#reclaimLostLeases(nowMs);
    if (!this.#canAdmit(accessClass)) {
      return undefined;
    }

    this.#aggregateInFlight += 1;
    if (accessClass === "heavy-read") {
      this.#heavyReadsInFlight += 1;
    }
    this.#aggregateObservedMaximum = Math.max(
      this.#aggregateObservedMaximum,
      this.#aggregateInFlight,
    );

    const heldLease = { accessClass, acquiredAtMs: nowMs };
    this.#leases.add(heldLease);
    return {
      aggregateInFlight: this.#aggregateInFlight,
      isActive: () => this.#leases.has(heldLease),
      queueWaitMs,
      release: () => this.#release(heldLease),
    };
  }

  #reclaimLostLeases(nowMs: number): void {
    for (const lease of this.#leases) {
      const heldMs = nowMs - lease.acquiredAtMs;
      if (heldMs >= WORKER_DB_LEASE_HOLD_MAX_MS) {
        this.#release(lease);
        logEvent("warn", "database.lease-reclaimed", { accessClass: lease.accessClass, heldMs });
      }
    }
  }

  #release(lease: HeldDatabaseLease): void {
    if (!this.#leases.delete(lease)) {
      return;
    }

    this.#aggregateInFlight -= 1;
    if (lease.accessClass === "heavy-read") {
      this.#heavyReadsInFlight -= 1;
    }
  }
}

export const workerDatabaseConcurrencyGate = new WorkerDatabaseConcurrencyGate();

export const workerTelemetryDatabaseConcurrencyGate = new WorkerDatabaseConcurrencyGate(
  TELEMETRY_DB_CONCURRENCY,
  1,
);
