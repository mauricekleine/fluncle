#!/usr/bin/env bun

import {
  databaseAdmissionYieldSummary,
  runDatabaseAdmissionPhase,
} from "./database-admission-phase";

const API_BASE_URL = process.env.FLUNCLE_API_BASE_URL ?? "https://www.fluncle.com";
const API_TOKEN = process.env.FLUNCLE_API_TOKEN ?? "";
const ADMISSION_OWNER = "fluncle-reconcile-hub-counts";

export const WINDOW_PAGE_LIMIT = 8;

export const WINDOW_YIELD_RETRIES = 1;

export const WINDOW_START_BUDGET_MS = 600_000;

export const MAX_WINDOWS = 200;

const WINDOW_TIMEOUT_MS = 120_000;

const log = (message: string) => console.error(`[reconcile-hub-counts] ${message}`);

export const RECONCILE_TABLES = ["labels", "albums", "artists"] as const;
export type ReconcileTable = (typeof RECONCILE_TABLES)[number];

export type ReconcileCursor = { afterId: null | string; table: ReconcileTable };

export type ReconcileTableResult = {
  corrected?: number;
  deferred?: number;
  latestCorrected?: number;
};

export type ReconcileHubCountsResponse = {
  albums?: ReconcileTableResult;
  artists?: ReconcileTableResult;
  labels?: ReconcileTableResult;
  next?: ReconcileCursor | null;
  ok?: boolean;
  pages?: number;
  tookMs?: number;
};

export type ReconcileHubCountsSummary = {
  admissionOutcome?: string;
  albums: null | number;
  artists: null | number;

  checked: number;

  corrected: null | number;

  deferred: null | number;
  error: null | string;

  errors: number;
  gateState?: string;
  labels: null | number;
  latestCorrected: null | number;
  ok: boolean;

  partial: boolean;

  produced: null | number;
  reason: null | string;
  throttled?: boolean;

  tookMs: null | number;

  windows: number;
};

export type ReconcileHubCountsDeps = {
  log: (message: string) => void;
  now?: () => number;
  reconcile: (cursor: ReconcileCursor | null) => Promise<ReconcileHubCountsResponse | undefined>;
};

type TableTotals = { corrected: number; deferred: number; latest: null | number };

type Totals = Record<ReconcileTable, null | TableTotals>;

type Walk = {
  cursor: ReconcileCursor | null;
  error: null | string;
  legacy: boolean;
  reason: null | string;
  stop: "complete" | "failed" | "partial" | "yielded";
  tookMs: null | number;
  windows: number;
};

function correctedOf(table: ReconcileTableResult | undefined): null | number {
  return typeof table?.corrected === "number" ? table.corrected : null;
}

function deferredOf(table: ReconcileTableResult | undefined): number {
  return typeof table?.deferred === "number" ? table.deferred : 0;
}

function latestOf(table: ReconcileTableResult | undefined): null | number {
  return typeof table?.latestCorrected === "number" ? table.latestCorrected : null;
}

function addLatest(running: null | number, value: null | number): null | number {
  return value === null ? running : (running ?? 0) + value;
}

export function parseReconcileCursor(value: unknown): ReconcileCursor | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("reconcile_hub_counts returned an invalid cursor");
  }
  const candidate = value as Record<string, unknown>;
  const table = RECONCILE_TABLES.find((name) => name === candidate.table);
  const afterId = candidate.afterId;
  if (
    table === undefined ||
    (afterId !== null && (typeof afterId !== "string" || afterId === ""))
  ) {
    throw new Error("reconcile_hub_counts returned an invalid cursor");
  }

  return { afterId, table };
}

export function windowBody(cursor: ReconcileCursor | null): {
  cursor?: ReconcileCursor;
  pageLimit: number;
} {
  return cursor === null
    ? { pageLimit: WINDOW_PAGE_LIMIT }
    : { cursor, pageLimit: WINDOW_PAGE_LIMIT };
}

function foldLegacyResponse(totals: Totals, response: ReconcileHubCountsResponse): void {
  for (const table of RECONCILE_TABLES) {
    const corrected = correctedOf(response[table]);
    if (corrected !== null) {
      totals[table] = {
        corrected,
        deferred: deferredOf(response[table]),
        latest: latestOf(response[table]),
      };
    }
  }
}

function foldWindowResponse(
  totals: Totals,
  cursor: ReconcileCursor | null,
  response: ReconcileHubCountsResponse,
): ReconcileCursor | null {
  const next = parseReconcileCursor(response.next);
  const firstIndex = cursor === null ? 0 : RECONCILE_TABLES.indexOf(cursor.table);
  const lastIndex =
    next === null
      ? RECONCILE_TABLES.length - 1
      : RECONCILE_TABLES.indexOf(next.table) - (next.afterId === null ? 1 : 0);

  for (const table of RECONCILE_TABLES.slice(firstIndex, lastIndex + 1)) {
    const corrected = correctedOf(response[table]);
    if (corrected === null) {
      throw new Error(`reconcile_hub_counts window omitted ${table}`);
    }
    const running = totals[table] ?? { corrected: 0, deferred: 0, latest: null };
    running.corrected += corrected;
    running.deferred += deferredOf(response[table]);
    running.latest = addLatest(running.latest, latestOf(response[table]));
    totals[table] = running;
  }

  if (
    next !== null &&
    cursor !== null &&
    next.table === cursor.table &&
    next.afterId === cursor.afterId
  ) {
    throw new Error("reconcile_hub_counts cursor did not advance");
  }

  return next;
}

async function walkWindows(deps: ReconcileHubCountsDeps, totals: Totals): Promise<Walk> {
  const now = deps.now ?? (() => performance.now());
  const startedAt = now();
  const walk: Walk = {
    cursor: null,
    error: null,
    legacy: false,
    reason: null,
    stop: "partial",
    tookMs: null,
    windows: 0,
  };

  try {
    while (walk.windows < MAX_WINDOWS) {
      if (walk.windows > 0 && now() - startedAt >= WINDOW_START_BUDGET_MS) {
        walk.reason = "wall_budget";
        return walk;
      }

      const response = await deps.reconcile(walk.cursor);
      if (response === undefined) {
        walk.stop = "yielded";
        return walk;
      }
      if (response.ok !== true) {
        throw new Error("reconcile_hub_counts did not ack");
      }

      walk.windows += 1;
      if (typeof response.tookMs === "number") {
        walk.tookMs = (walk.tookMs ?? 0) + response.tookMs;
      }

      if (!("next" in response)) {
        foldLegacyResponse(totals, response);
        walk.legacy = true;
        walk.stop = "complete";
        return walk;
      }

      const next = foldWindowResponse(totals, walk.cursor, response);
      if (next === null) {
        walk.stop = "complete";
        return walk;
      }
      walk.cursor = next;
    }
    walk.reason = "window_budget";
  } catch (error) {
    walk.stop = "failed";
    walk.error = error instanceof Error ? error.message : String(error);
  }

  return walk;
}

function sumOf(totals: Totals, field: "corrected" | "deferred"): number {
  return RECONCILE_TABLES.reduce((sum, table) => sum + (totals[table]?.[field] ?? 0), 0);
}

function latestSum(totals: Totals): null | number {
  return RECONCILE_TABLES.reduce<null | number>(
    (sum, table) => addLatest(sum, totals[table]?.latest ?? null),
    null,
  );
}

function logAudit(
  write: (message: string) => void,
  summary: ReconcileHubCountsSummary,
  walk: Walk,
): void {
  if (walk.windows === 0) {
    return;
  }
  const stopped =
    walk.stop === "yielded"
      ? " partial=database_admission"
      : walk.stop === "partial"
        ? ` partial=${walk.reason ?? "unknown"}`
        : "";

  write(
    `AUDIT corrected=${summary.corrected ?? "?"} labels=${summary.labels ?? "?"} ` +
      `albums=${summary.albums ?? "?"} artists=${summary.artists ?? "?"} ` +
      `tookMs=${summary.tookMs ?? "?"}` +
      (summary.deferred === null ? "" : ` deferred=${summary.deferred}`) +
      (summary.latestCorrected === null ? "" : ` latest=${summary.latestCorrected}`) +
      stopped,
  );
}

function legacySummary(
  deps: ReconcileHubCountsDeps,
  summary: ReconcileHubCountsSummary,
  totals: Totals,
  walk: Walk,
): ReconcileHubCountsSummary {
  const perTable = [summary.labels, summary.albums, summary.artists];
  summary.checked = perTable.filter((value) => value !== null).length;
  summary.corrected = perTable.every((value) => value !== null) ? sumOf(totals, "corrected") : null;
  summary.produced =
    summary.corrected === null ? null : summary.corrected + (summary.latestCorrected ?? 0);

  if (summary.checked === 0) {
    summary.ok = false;
    summary.error = "reconcile_hub_counts inspected no tables";
    summary.errors = 1;
    deps.log(`reconcile failed: ${summary.error}`);

    return summary;
  }

  logAudit(deps.log, summary, walk);
  return summary;
}

export async function runReconcileHubCountsTick(
  deps: ReconcileHubCountsDeps,
): Promise<ReconcileHubCountsSummary> {
  const totals: Totals = { albums: null, artists: null, labels: null };
  const walk = await walkWindows(deps, totals);
  const summary: ReconcileHubCountsSummary = {
    albums: totals.albums?.corrected ?? null,
    artists: totals.artists?.corrected ?? null,

    checked: walk.cursor === null ? 0 : RECONCILE_TABLES.indexOf(walk.cursor.table),
    corrected: null,
    deferred: null,
    error: null,
    errors: 0,
    labels: totals.labels?.corrected ?? null,
    latestCorrected: latestSum(totals),
    ok: true,
    partial: false,
    produced: null,
    reason: walk.reason,
    tookMs: walk.tookMs,
    windows: walk.windows,
  };

  if (walk.stop === "failed") {
    summary.ok = false;
    summary.error = walk.error;
    summary.errors = 1;
    deps.log(`reconcile failed: ${walk.error ?? "unknown error"}`);

    return summary;
  }
  if (walk.legacy) {
    return legacySummary(deps, summary, totals, walk);
  }

  const landed = sumOf(totals, "corrected");
  const written = landed + (summary.latestCorrected ?? 0);
  summary.deferred = sumOf(totals, "deferred");
  summary.produced = written;
  if (walk.stop === "complete") {
    summary.checked = RECONCILE_TABLES.length;
    summary.corrected = landed;
  } else {
    summary.partial = true;
  }
  logAudit(deps.log, summary, walk);

  if (walk.stop === "yielded") {
    return {
      ...summary,
      ...databaseAdmissionYieldSummary({
        checked: summary.checked,
        partial: true,
        produced: written,
      }),
    } as ReconcileHubCountsSummary;
  }

  return summary;
}

async function postReconcileWindow(
  cursor: ReconcileCursor | null,
): Promise<ReconcileHubCountsResponse> {
  const res = await fetch(`${API_BASE_URL}/api/v1/admin/hub-counts/reconcile`, {
    body: JSON.stringify(windowBody(cursor)),
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
    },
    method: "POST",
    signal: AbortSignal.timeout(WINDOW_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(
      `reconcile_hub_counts failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }

  return (await res.json()) as ReconcileHubCountsResponse;
}

export function parseWindowEnvelope(stdout: string): ReconcileHubCountsResponse {
  const line = stdout.trim().split("\n").at(-1) ?? "";
  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error("reconcile window returned an invalid envelope");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("reconcile window returned an invalid envelope");
  }

  const envelope = parsed as Record<string, unknown>;

  if (envelope.kind === "failed") {
    throw new Error(
      typeof envelope.error === "string" ? envelope.error : "reconcile window failed",
    );
  }
  if (
    envelope.kind === "window" &&
    typeof envelope.response === "object" &&
    envelope.response !== null &&
    !Array.isArray(envelope.response)
  ) {
    return envelope.response as ReconcileHubCountsResponse;
  }

  throw new Error("reconcile window returned an invalid envelope");
}

function admittedWindow(
  cursor: ReconcileCursor | null,
): Promise<ReconcileHubCountsResponse | undefined> {
  const phase = runDatabaseAdmissionPhase({
    command: [process.execPath, import.meta.path, "--admission-phase", JSON.stringify(cursor)],
    owner: ADMISSION_OWNER,
    yieldRetries: WINDOW_YIELD_RETRIES,
  });

  return Promise.resolve(phase.kind === "yielded" ? undefined : parseWindowEnvelope(phase.stdout));
}

async function runWindowChild(
  cursorArgument: string | undefined,
): Promise<Record<string, unknown>> {
  try {
    const cursor = parseReconcileCursor(JSON.parse(cursorArgument ?? "null"));

    return { kind: "window", response: await postReconcileWindow(cursor) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), kind: "failed" };
  }
}

async function main(): Promise<void> {
  const started = Date.now();

  if (!API_TOKEN) {
    console.log(
      JSON.stringify({
        checked: 0,
        errors: 1,
        ok: false,
        produced: null,
        reason: "missing_api_token",
      }),
    );
    process.exit(1);
  }

  const summary = await runReconcileHubCountsTick({
    log,

    reconcile: process.env.FLUNCLE_ADMISSION_RUNNER_PID ? postReconcileWindow : admittedWindow,
  });

  console.log(JSON.stringify({ ...summary, elapsedMs: Date.now() - started }));

  if (!summary.ok) {
    process.exit(1);
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const phaseIndex = argv.indexOf("--admission-phase");

  if (phaseIndex >= 0) {
    void runWindowChild(argv[phaseIndex + 1]).then((envelope) => {
      console.log(JSON.stringify(envelope));
    });
  } else {
    main().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      log(`reconcile-hub-counts failed: ${message}`);
      console.log(
        JSON.stringify({
          checked: 0,
          error: message,
          errors: 1,
          ok: false,
          produced: null,
          reason: "reconcile_failed",
        }),
      );
      process.exit(1);
    });
  }
}
