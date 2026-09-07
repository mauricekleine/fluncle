/**
 * The primary Worker client preserves ordinary request fan-out while capping
 * libSQL's default of 20 concurrent requests.
 */
export const PRIMARY_DB_CONCURRENCY = 4;

/**
 * One Worker isolate admits at most four database operations across every
 * client it creates. This matches the deliberate primary-client fan-out while
 * preventing concurrent requests from multiplying that cap. It is an isolate
 * bound, not cross-isolate or cross-unit admission control.
 */
export const WORKER_DB_AGGREGATE_CONCURRENCY = 4;

/**
 * Only one heavy read occupies the isolate gate at once, leaving three seats
 * for ordinary reads and writes when that reader is held.
 */
export const WORKER_DB_HEAVY_READ_CONCURRENCY = 1;

/**
 * The telemetry client matches `readRunLedger`'s three-query fan-out while
 * keeping ledger diagnostics independent from the primary client.
 */
export const TELEMETRY_DB_CONCURRENCY = 3;

/**
 * The catalogue-public-entities count intentionally permits its three-count
 * read to fan out together.
 */
export const CATALOGUE_PUBLIC_ENTITY_COUNT_DB_CONCURRENCY = 3;

/**
 * Maintenance, benchmark, seed, and readiness remote clients use one slot:
 * these tools perform sequential or deliberately batched work.
 */
export const REMOTE_DB_CONCURRENCY = 1;

/**
 * Local, file, and test clients use one slot to document serial intent even
 * though the current sqlite3 transport ignores this option.
 */
export const LOCAL_DB_CONCURRENCY = 1;

export type WorkerDatabaseAccessClass = "heavy-read" | "read" | "write";

export type WorkerDatabaseConcurrencyLease = {
  aggregateInFlight: number;
  queueWaitMs: number;
  release: () => void;
};

export type WorkerDatabaseConcurrencySnapshot = {
  aggregateInFlight: number;
  aggregateObservedMaximum: number;
};

const WORKER_DB_ADMISSION_POLL_MS = 1;

function waitForAdmissionTurn(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, WORKER_DB_ADMISSION_POLL_MS);
  });
}

/** A queued heavy read cannot consume or convoy the ordinary seats beside it. */
export class WorkerDatabaseConcurrencyGate {
  readonly #aggregateCeiling: number;
  readonly #heavyReadCeiling: number;
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

  async acquire(accessClass: WorkerDatabaseAccessClass): Promise<WorkerDatabaseConcurrencyLease> {
    const enqueuedAtMs = Date.now();

    for (;;) {
      const lease = this.#tryAcquire(accessClass, enqueuedAtMs);
      if (lease !== undefined) {
        return lease;
      }

      // A module-global resolver would let one request resolve another request's
      // Promise, which Workerd cancels. Each waiter wakes in its own request
      // context and competes only when its access class has capacity.
      await waitForAdmissionTurn();
    }
  }

  snapshot(): WorkerDatabaseConcurrencySnapshot {
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
    enqueuedAtMs: number,
  ): WorkerDatabaseConcurrencyLease | undefined {
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

    let released = false;
    return {
      aggregateInFlight: this.#aggregateInFlight,
      queueWaitMs: Math.max(0, Date.now() - enqueuedAtMs),
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.#aggregateInFlight -= 1;
        if (accessClass === "heavy-read") {
          this.#heavyReadsInFlight -= 1;
        }
      },
    };
  }
}

export const workerDatabaseConcurrencyGate = new WorkerDatabaseConcurrencyGate();
