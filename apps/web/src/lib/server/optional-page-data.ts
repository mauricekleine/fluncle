import { waitUntil } from "cloudflare:workers";
import {
  WORKER_DB_AGGREGATE_CONCURRENCY,
  workerDatabaseConcurrencyGate,
} from "../database-concurrency";
import { logEvent } from "./log";
import { markRenderDegraded, runWithOptionalDatabaseSignal } from "./database-request-scope";

export const OPTIONAL_PAGE_DATA_BUDGET_MS = 1_000;

export function optionalPageDataBudget() {
  const deadline = Date.now() + OPTIONAL_PAGE_DATA_BUDGET_MS;
  return <Value>(operationId: string, load: () => Promise<Value>, fallback: Value) =>
    optionalPageData(operationId, load, fallback, deadline);
}

export async function optionalPageData<Value>(
  operationId: string,
  load: () => Promise<Value>,
  fallback: Value,
  deadlineMs = Date.now() + OPTIONAL_PAGE_DATA_BUDGET_MS,
): Promise<Value> {
  const remainingMs = Math.min(OPTIONAL_PAGE_DATA_BUDGET_MS, deadlineMs - Date.now());
  if (remainingMs <= 0) {
    markRenderDegraded();
    logEvent("warn", "page.optional-omitted", { operationId, reason: "deadline" });
    return fallback;
  }
  if (
    workerDatabaseConcurrencyGate.snapshot().aggregateInFlight >= WORKER_DB_AGGREGATE_CONCURRENCY
  ) {
    markRenderDegraded();
    logEvent("warn", "page.optional-omitted", { operationId, reason: "database_busy" });
    return fallback;
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let work: Promise<Value> | undefined;
  const deadline = new Promise<Value>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      if (work) {
        try {
          waitUntil(
            work.then(
              () => undefined,
              () => undefined,
            ),
          );
        } catch {
          logEvent("warn", "page.optional-settlement-untracked", { operationId });
        }
      }
      markRenderDegraded();
      logEvent("warn", "page.optional-omitted", { operationId, reason: "deadline" });
      resolve(fallback);
    }, remainingMs);
  });

  try {
    work = runWithOptionalDatabaseSignal(controller.signal, load);
    return await Promise.race([work, deadline]);
  } catch {
    if (!controller.signal.aborted) {
      markRenderDegraded();
      logEvent("warn", "page.optional-omitted", { operationId, reason: "error" });
    }
    return fallback;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
