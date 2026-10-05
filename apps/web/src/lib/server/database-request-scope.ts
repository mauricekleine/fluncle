import { type Client } from "@libsql/client/web";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  type WorkerDatabaseConcurrencyGate,
  type WorkerDatabaseConcurrencyLease,
} from "../database-concurrency";

export type DatabaseClientSlot = "primary" | "telemetry";

type DatabaseRequestScope = {
  clients: Map<DatabaseClientSlot, Promise<Client | undefined>>;
  inFlight: number;
  observedMaximum: number;
  transactions: Map<WorkerDatabaseConcurrencyGate, RequestTransactionAdmission>;
  values: Map<symbol, unknown>;
};

export type DatabaseRequestOperationLease = {
  observedMaximum: () => number;
  release: () => void;
};

export type DatabaseRequestTransactionLease = {
  release: () => void;
};

type RequestTransactionAdmission = {
  borrowedLeases: WeakSet<WorkerDatabaseConcurrencyLease>;
  borrowers: number;
  ownedLeases: Set<WorkerDatabaseConcurrencyLease>;
  refCount: number;
};

const databaseRequestScope = new AsyncLocalStorage<DatabaseRequestScope>();
const SETTINGS_MEMO_KEY = Symbol("fluncle.settings-memo");

export function getRequestScopedSettingsMemo():
  | Map<string, Promise<string | undefined>>
  | undefined {
  return getRequestScopedValue(SETTINGS_MEMO_KEY, () => new Map());
}

export function clearRequestScopedSettingsMemo(): void {
  getRequestScopedSettingsMemo()?.clear();
}

export function runWithDatabaseRequestScope<Result>(run: () => Result): Result {
  if (databaseRequestScope.getStore() !== undefined) {
    return run();
  }

  return databaseRequestScope.run(
    {
      clients: new Map(),
      inFlight: 0,
      observedMaximum: 0,
      transactions: new Map(),
      values: new Map(),
    },
    run,
  );
}

function releaseUnusedAdmission(
  scope: DatabaseRequestScope,
  gate: WorkerDatabaseConcurrencyGate,
  admission: RequestTransactionAdmission,
): void {
  if (admission.refCount !== 0 || admission.borrowers !== 0) {
    return;
  }

  scope.transactions.delete(gate);
  for (const lease of admission.ownedLeases) {
    lease.release();
  }
}

export function getRequestScopedTransactionLease(
  gate: WorkerDatabaseConcurrencyGate,
): WorkerDatabaseConcurrencyLease | undefined {
  const scope = databaseRequestScope.getStore();
  const admission = scope?.transactions.get(gate);
  if (scope === undefined || admission === undefined || admission.refCount === 0) {
    return undefined;
  }

  const snapshot = gate.snapshot();
  if (![...admission.ownedLeases].some((lease) => lease.isActive())) {
    return undefined;
  }

  admission.borrowers += 1;
  let released = false;
  const lease: WorkerDatabaseConcurrencyLease = {
    aggregateInFlight: snapshot.aggregateInFlight,
    isActive: () =>
      !released && [...admission.ownedLeases].some((ownedLease) => ownedLease.isActive()),
    queueWaitMs: 0,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      admission.borrowers -= 1;
      releaseUnusedAdmission(scope, gate, admission);
    },
  };
  admission.borrowedLeases.add(lease);
  return lease;
}

export function enterDatabaseRequestTransaction(
  gate: WorkerDatabaseConcurrencyGate,
  lease: WorkerDatabaseConcurrencyLease,
): DatabaseRequestTransactionLease {
  const scope = databaseRequestScope.getStore();
  if (scope === undefined) {
    return lease;
  }

  let admission = scope.transactions.get(gate);
  if (admission === undefined) {
    admission = {
      borrowedLeases: new WeakSet(),
      borrowers: 0,
      ownedLeases: new Set(),
      refCount: 0,
    };
    scope.transactions.set(gate, admission);
  }

  const borrowed = admission.borrowedLeases.has(lease);
  if (!borrowed) {
    admission.ownedLeases.add(lease);
  }
  admission.refCount += 1;
  if (borrowed) {
    lease.release();
  }
  const heldAdmission = admission;
  let released = false;
  return {
    release: () => {
      if (released) {
        return;
      }
      released = true;
      heldAdmission.refCount -= 1;
      releaseUnusedAdmission(scope, gate, heldAdmission);
    },
  };
}

export function getRequestScopedValue<Value>(key: symbol, create: () => Value): Value | undefined {
  const scope = databaseRequestScope.getStore();
  if (scope === undefined) {
    return undefined;
  }
  if (!scope.values.has(key)) {
    scope.values.set(key, create());
  }
  return scope.values.get(key) as Value;
}

export function getRequestScopedDatabaseClient<ClientResult extends Client | undefined>(
  slot: DatabaseClientSlot,
  create: () => Promise<ClientResult>,
): Promise<ClientResult> {
  const scope = databaseRequestScope.getStore();
  if (scope === undefined) {
    return create();
  }

  const existing = scope.clients.get(slot);
  if (existing !== undefined) {
    return existing as Promise<ClientResult>;
  }

  const created = Promise.resolve().then(create);
  scope.clients.set(slot, created);
  return created;
}

export function enterDatabaseRequestOperation(): DatabaseRequestOperationLease {
  const scope = databaseRequestScope.getStore();
  if (scope === undefined) {
    return { observedMaximum: () => 0, release: () => undefined };
  }

  scope.inFlight += 1;
  scope.observedMaximum = Math.max(scope.observedMaximum, scope.inFlight);

  let released = false;
  return {
    observedMaximum: () => scope.observedMaximum,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      scope.inFlight -= 1;
    },
  };
}
