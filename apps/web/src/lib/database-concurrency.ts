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
