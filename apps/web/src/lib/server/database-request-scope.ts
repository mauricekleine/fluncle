import { type Client } from "@libsql/client/web";
import { AsyncLocalStorage } from "node:async_hooks";

export type DatabaseClientSlot = "primary" | "telemetry";

type DatabaseRequestScope = {
  clients: Map<DatabaseClientSlot, Promise<Client | undefined>>;
  inFlight: number;
  observedMaximum: number;
};

export type DatabaseRequestOperationLease = {
  observedMaximum: () => number;
  release: () => void;
};

const databaseRequestScope = new AsyncLocalStorage<DatabaseRequestScope>();

/** Share database clients and fan-out measurement across one Worker request. */
export function runWithDatabaseRequestScope<Result>(run: () => Result): Result {
  if (databaseRequestScope.getStore() !== undefined) {
    return run();
  }

  return databaseRequestScope.run({ clients: new Map(), inFlight: 0, observedMaximum: 0 }, run);
}

/** Memoize creation immediately so concurrent helpers cannot race out extra clients. */
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

/** Count operations admitted to the remote client, not helpers waiting at the gate. */
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
