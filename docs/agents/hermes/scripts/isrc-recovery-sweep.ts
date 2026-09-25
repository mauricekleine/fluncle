#!/usr/bin/env bun

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  databaseAdmissionYieldSummary,
  runDatabaseAdmissionPhase,
} from "./database-admission-phase";
import {
  dueWorkRepairPendingGate,
  failureBodyUnlessRepairPending,
  isDueWorkRepairPending,
  throwIfPageRepairPending,
} from "./due-work-repair-pending";

const DEFAULT_API_BASE_URL = "https://www.fluncle.com";
const DEFAULT_BATCH = 100;
const MAX_WORK_LIMIT = 200;
export const ADMISSION_OWNER = "fluncle-isrc-recovery";
export const ISRC_RECOVERY_EXPECTED_INTERVAL_MS = 10 * 60 * 1000;
export const ISRC_RECOVERY_PACE_MS = 1_100;

const DEEZER_API_BASE_URL = process.env.FLUNCLE_DEEZER_API_BASE_URL ?? "https://api.deezer.com";

export const DEEZER_CANDIDATE_LIMIT = 5;
const DEEZER_QUOTA_ERROR_CODE = 4;
const DEEZER_TIMEOUT_MS = 10_000;
const DEEZER_USER_AGENT = "Fluncle/1.0 (+https://www.fluncle.com)";
const DEEZER_QUOTA_RETRY_DELAYS_MS = [1_200, 2_500];

export const DEEZER_QUOTA_ABORT_STREAK = 3;

export const SETTLE_WINDOW_ROWS = 10;

export const SETTLE_WINDOW_BUDGET_MS = 20_000;

export const ISRC_RECOVERY_WALL_BUDGET_MS = 840_000;

export const DEEZER_BLIND_MIN_SEARCHED = 25;
export const DEEZER_BLIND_EMPTY_SHARE = 0.98;

export type IsrcRecoveryWorkItem = {
  deezerQuery?: string;
  trackId?: string;
};

export type DeezerCandidatePayload = {
  artistName: string;
  deezerTrackId?: string;
  durationMs: number;
  isrc: string;
  title: string;
};

export type ResolveAnchorVerdict = {
  anchored: boolean;
  isrcRecoveredByDeezer: boolean;
};

export type DeezerSearchOutcome =
  | { candidates: DeezerCandidatePayload[]; droppedIncomplete: number; outcome: "ok" }
  | { outcome: "quota" }
  | { outcome: "transport-failed" };

export type IsrcRecoverySettleItem = {
  candidates: DeezerCandidatePayload[];

  cleanEmpty: boolean;
  trackId: string;
};

export type IsrcRecoverySettleVerdict =
  | { message: string; outcome: "failed"; trackId: string }
  | ({ outcome: "settled"; trackId: string } & ResolveAnchorVerdict);

export type IsrcRecoveryQueueWindow =
  | { kind: "queue"; queueDepth: number; rows: IsrcRecoveryWorkItem[] }
  | { kind: "repair-pending"; message: string };

export type IsrcRecoverySettleWindow = {
  deferred: string[];
  kind: "settle";
  verdicts: IsrcRecoverySettleVerdict[];
};

export type IsrcRecoveryWindows = {
  readQueue: (limit: number) => Promise<IsrcRecoveryQueueWindow | undefined>;
  settle: (
    items: readonly IsrcRecoverySettleItem[],
  ) => Promise<IsrcRecoverySettleWindow | undefined>;
};

export type IsrcRecoverySummary = {
  admissionOutcome?: string;
  admissionYieldReason?: string;
  checked: number;
  deezerEmpty: number;

  deezerHitsDroppedIncomplete: number;
  errors: number;
  expectedIntervalMs: number;

  failed: number;
  gateRefused: number;
  ok: boolean;
  produced: number;

  queueDepth: number | null;

  quotaBlocked: number;

  reason: string | null;
  recovered: number;

  skipped: number;
  transportFailed: number;

  unsettled: number;
} & { gateState?: "paused"; partial?: boolean; throttled?: boolean };

export type IsrcRecoveryDeps = {
  log: (message: string) => void;

  now?: () => number;
  searchDeezer: (query: string) => Promise<DeezerSearchOutcome>;
  sleep: (ms: number) => Promise<void>;
  windows: IsrcRecoveryWindows;
};

export type RuntimeEffects = {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  log: (message: string) => void;
  output: (line: string) => void;
  sleep: (ms: number) => Promise<void>;

  windows?: IsrcRecoveryWindows;
};

function emptySummary(): IsrcRecoverySummary {
  return {
    checked: 0,
    deezerEmpty: 0,
    deezerHitsDroppedIncomplete: 0,
    errors: 0,
    expectedIntervalMs: ISRC_RECOVERY_EXPECTED_INTERVAL_MS,
    failed: 0,
    gateRefused: 0,
    ok: true,
    produced: 0,
    queueDepth: null,
    quotaBlocked: 0,
    reason: null,
    recovered: 0,
    skipped: 0,
    transportFailed: 0,
    unsettled: 0,
  };
}

function settleQueueRow(summary: IsrcRecoverySummary): void {
  if (summary.queueDepth !== null && summary.queueDepth > 0) {
    summary.queueDepth -= 1;
  }
}

function admissionYieldSummary(summary: IsrcRecoverySummary): IsrcRecoverySummary {
  return {
    ...summary,
    ...databaseAdmissionYieldSummary({ produced: summary.produced }),
    gateState: "paused",
    partial: summary.checked > 0 || summary.produced > 0,
  };
}

type SearchedRows = {
  answered: number;
  items: IsrcRecoverySettleItem[];
};

async function searchClaimedRows(
  rows: readonly IsrcRecoveryWorkItem[],
  summary: IsrcRecoverySummary,
  deps: IsrcRecoveryDeps,
): Promise<SearchedRows> {
  const items: IsrcRecoverySettleItem[] = [];
  let consecutiveQuota = 0;
  let answered = 0;

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    summary.checked += 1;

    const trackId = row?.trackId?.trim() ?? "";
    const deezerQuery = row?.deezerQuery?.trim() ?? "";

    if (!trackId || !deezerQuery) {
      summary.failed += 1;
      summary.skipped += 1;
      consecutiveQuota = 0;
      deps.log(`${trackId || "unknown-track"}: work row omitted trackId or deezerQuery`);
    } else {
      const search = await deps.searchDeezer(deezerQuery);

      if (search.outcome === "quota") {
        summary.quotaBlocked += 1;
        consecutiveQuota += 1;

        if (consecutiveQuota >= DEEZER_QUOTA_ABORT_STREAK) {
          summary.quotaBlocked += rows.length - index - 1;
          deps.log(`aborting after ${consecutiveQuota} consecutive Deezer quota outcomes`);
          break;
        }
      } else if (search.outcome === "transport-failed") {
        summary.failed += 1;
        summary.transportFailed += 1;
        consecutiveQuota = 0;
      } else {
        consecutiveQuota = 0;
        answered += 1;
        summary.deezerHitsDroppedIncomplete += search.droppedIncomplete;
        items.push({
          candidates: search.candidates.slice(0, DEEZER_CANDIDATE_LIMIT),

          cleanEmpty: search.candidates.length === 0 && search.droppedIncomplete === 0,
          trackId,
        });
      }
    }

    if (index < rows.length - 1) {
      await deps.sleep(ISRC_RECOVERY_PACE_MS);
    }
  }

  return { answered, items };
}

function applySettleWindow(
  window: IsrcRecoverySettleWindow,
  items: readonly IsrcRecoverySettleItem[],
  summary: IsrcRecoverySummary,
  deps: IsrcRecoveryDeps,
): number {
  const byTrackId = new Map(items.map((item) => [item.trackId, item]));
  let judged = 0;

  for (const verdict of window.verdicts) {
    if (verdict.outcome === "failed") {
      summary.failed += 1;
      summary.transportFailed += 1;
      deps.log(`${verdict.trackId}: ${verdict.message}`);
      continue;
    }

    const item = byTrackId.get(verdict.trackId);

    if (item !== undefined) {
      judged += 1;
    }
    if (verdict.isrcRecoveredByDeezer) {
      summary.recovered += 1;
      summary.produced += 1;
    } else if ((item?.candidates.length ?? 0) > 0) {
      summary.gateRefused += 1;
    } else if (item?.cleanEmpty === true) {
      summary.deezerEmpty += 1;
    }

    settleQueueRow(summary);
  }

  return judged;
}

export async function runIsrcRecoverySweep(
  limit: number,
  deps: IsrcRecoveryDeps,
): Promise<IsrcRecoverySummary> {
  const summary = emptySummary();
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const spentMs = (): number => now() - startedAt;
  let claimed: IsrcRecoveryQueueWindow | undefined;

  try {
    claimed = await deps.windows.readQueue(limit);
  } catch (error) {
    deps.log(error instanceof Error ? error.message : String(error));

    if (isDueWorkRepairPending(error)) {
      return { ...summary, ...dueWorkRepairPendingGate(summary) };
    }

    summary.errors = 1;
    summary.ok = false;
    return summary;
  }

  if (claimed === undefined) {
    return admissionYieldSummary(summary);
  }

  if (claimed.kind === "repair-pending") {
    deps.log(claimed.message);
    return { ...summary, ...dueWorkRepairPendingGate(summary) };
  }

  summary.queueDepth = claimed.queueDepth;

  const searched = await searchClaimedRows(claimed.rows, summary, deps);
  let pending = [...searched.items];
  let yielded = false;

  let judged = 0;

  while (pending.length > 0) {
    if (spentMs() >= ISRC_RECOVERY_WALL_BUDGET_MS) {
      summary.partial = true;
      summary.reason = "wall_budget";
      deps.log(`stopping with ${pending.length} row(s) unsettled: the tick's wall budget is spent`);
      break;
    }

    const chunk = pending.slice(0, SETTLE_WINDOW_ROWS);
    const window = await deps.windows.settle(chunk);

    if (window === undefined) {
      yielded = true;
      break;
    }

    judged += applySettleWindow(window, chunk, summary, deps);

    if (window.deferred.length > 0) {
      deps.log(
        `a settle window spent its budget with ${window.deferred.length} row(s) unattempted`,
      );
    }

    const answered = new Set(window.verdicts.map((verdict) => verdict.trackId));
    pending = [
      ...chunk.filter((item) => !answered.has(item.trackId)),
      ...pending.slice(chunk.length),
    ];

    if (answered.size === 0) {
      summary.partial = true;
      deps.log(
        `a settle window answered about no row; leaving ${pending.length} for the next tick`,
      );
      break;
    }
  }

  summary.unsettled = pending.length;

  const blind =
    judged >= DEEZER_BLIND_MIN_SEARCHED && summary.deezerEmpty / judged >= DEEZER_BLIND_EMPTY_SHARE;

  if (yielded && !blind) {
    return admissionYieldSummary(summary);
  }
  if (blind) {
    summary.ok = false;
    summary.reason = "deezer_blind";
    deps.log(
      `Deezer answered empty for ${summary.deezerEmpty}/${judged} judged rows — the ask, not the catalogue`,
    );
  }

  return summary;
}

type DeezerAttempt =
  | { candidates: DeezerCandidatePayload[]; droppedIncomplete: number; outcome: "ok" }
  | { outcome: "quota" }
  | { outcome: "transport-failed" };

async function attemptDeezerSearch(query: string, request: typeof fetch): Promise<DeezerAttempt> {
  let response: Response;

  try {
    response = await request(
      `${DEEZER_API_BASE_URL}/search/track?q=${encodeURIComponent(query)}&limit=${DEEZER_CANDIDATE_LIMIT}`,
      {
        headers: { "User-Agent": DEEZER_USER_AGENT },
        signal: AbortSignal.timeout(DEEZER_TIMEOUT_MS),
      },
    );
  } catch {
    return { outcome: "transport-failed" };
  }

  if (!response.ok) {
    return { outcome: "transport-failed" };
  }

  let body: unknown;

  try {
    body = await response.json();
  } catch {
    return { outcome: "transport-failed" };
  }

  const parsed = body as {
    data?: {
      artist?: { name?: string };
      duration?: number;
      id?: number;
      isrc?: string;
      title?: string;
    }[];
    error?: { code?: unknown };
  };

  if (parsed.error) {
    if (parsed.error.code === DEEZER_QUOTA_ERROR_CODE) {
      return { outcome: "quota" };
    }
    return { outcome: "transport-failed" };
  }

  if (!Array.isArray(parsed.data)) {
    return { outcome: "transport-failed" };
  }

  const candidates: DeezerCandidatePayload[] = [];
  let droppedIncomplete = 0;

  for (const hit of parsed.data.slice(0, DEEZER_CANDIDATE_LIMIT)) {
    const artistName = hit.artist?.name?.trim() ?? "";
    const isrc = hit.isrc?.trim() ?? "";
    const title = hit.title?.trim() ?? "";

    if (!artistName || !isrc || !title || typeof hit.duration !== "number" || hit.duration <= 0) {
      droppedIncomplete += 1;
      continue;
    }

    candidates.push({
      artistName,
      ...(typeof hit.id === "number" ? { deezerTrackId: String(hit.id) } : {}),
      durationMs: Math.round(hit.duration * 1000),
      isrc,
      title,
    });
  }

  return { candidates, droppedIncomplete, outcome: "ok" };
}

export async function searchDeezerCandidates(
  query: string,
  effects: Pick<RuntimeEffects, "fetch" | "sleep">,
  retryDelaysMs: number[] = DEEZER_QUOTA_RETRY_DELAYS_MS,
): Promise<DeezerSearchOutcome> {
  for (let attempt = 0; ; attempt += 1) {
    const result = await attemptDeezerSearch(query, effects.fetch);

    if (result.outcome !== "quota") {
      return result;
    }

    const delay = retryDelaysMs[attempt];
    if (delay === undefined) {
      return { outcome: "quota" };
    }
    await effects.sleep(delay);
  }
}

function parseLimit(args: string[], configured: string | undefined): number {
  const fromArgs = args.find((arg) => arg.startsWith("--limit="))?.slice("--limit=".length);
  const flagIndex = args.indexOf("--limit");
  const raw = fromArgs ?? (flagIndex >= 0 ? args[flagIndex + 1] : undefined) ?? configured;
  const parsed = Number(raw ?? DEFAULT_BATCH);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_BATCH;
  }
  return Math.min(Math.trunc(parsed), MAX_WORK_LIMIT);
}

function apiBaseUrl(effects: RuntimeEffects): string {
  return effects.env.FLUNCLE_API_BASE_URL ?? DEFAULT_API_BASE_URL;
}

export async function readIsrcRecoveryQueueWindow(
  limit: number,
  effects: RuntimeEffects,
): Promise<IsrcRecoveryQueueWindow> {
  const token = effects.env.FLUNCLE_API_TOKEN ?? "";

  try {
    const response = await effects.fetch(
      `${apiBaseUrl(effects)}/api/v1/admin/tracks/work?kind=isrc-recovery&limit=${limit}&count=true&debtAware=true`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (!response.ok) {
      const body = await failureBodyUnlessRepairPending(response, "isrc-recovery queue read");
      throw new Error(
        `isrc-recovery queue read failed (${response.status}): ${body.slice(0, 200)}`,
      );
    }

    const body = (await response.json()) as { queued?: unknown; tracks?: unknown };

    throwIfPageRepairPending("isrc-recovery queue read", body);
    if (!Array.isArray(body.tracks)) {
      throw new Error("isrc-recovery queue read returned a non-array tracks body");
    }
    if (
      typeof body.queued !== "number" ||
      !Number.isInteger(body.queued) ||
      body.queued < body.tracks.length
    ) {
      throw new Error("isrc-recovery queue read returned an invalid whole-queue count");
    }

    return { kind: "queue", queueDepth: body.queued, rows: body.tracks as IsrcRecoveryWorkItem[] };
  } catch (error) {
    if (isDueWorkRepairPending(error)) {
      return { kind: "repair-pending", message: error.message };
    }
    throw error;
  }
}

export async function settleIsrcRecoveryWindow(
  items: readonly IsrcRecoverySettleItem[],
  effects: RuntimeEffects,
  now: () => number = Date.now,
): Promise<IsrcRecoverySettleWindow> {
  const baseUrl = apiBaseUrl(effects);
  const token = effects.env.FLUNCLE_API_TOKEN ?? "";
  const startedAt = now();
  const verdicts: IsrcRecoverySettleVerdict[] = [];
  const deferred: string[] = [];

  for (const [index, item] of items.entries()) {
    if (index > 0 && now() - startedAt >= SETTLE_WINDOW_BUDGET_MS) {
      deferred.push(item.trackId);
      continue;
    }

    try {
      const response = await effects.fetch(`${baseUrl}/api/v1/admin/catalogue/anchor/resolve`, {
        body: JSON.stringify({
          deezerCandidates: item.candidates,
          spotifySearch: false,
          trackId: item.trackId,
        }),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        method: "POST",
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        throw new Error(
          `resolve_anchor ${item.trackId} failed (${response.status}): ${(await response.text()).slice(0, 200)}`,
        );
      }

      const body = (await response.json()) as {
        anchored?: unknown;
        isrcRecoveredByDeezer?: unknown;
      };

      verdicts.push({
        anchored: body.anchored === true,
        isrcRecoveredByDeezer: body.isrcRecoveredByDeezer === true,
        outcome: "settled",
        trackId: item.trackId,
      });
    } catch (error) {
      verdicts.push({
        message: error instanceof Error ? error.message : String(error),
        outcome: "failed",
        trackId: item.trackId,
      });
    }
  }

  return { deferred, kind: "settle", verdicts };
}

export function inProcessWindows(effects: RuntimeEffects): IsrcRecoveryWindows {
  return {
    readQueue: (limit) => readIsrcRecoveryQueueWindow(limit, effects),
    settle: (items) => settleIsrcRecoveryWindow(items, effects),
  };
}

export type IsrcRecoveryPhase = "claim" | "settle";

export function isIsrcRecoveryPhase(value: string | undefined): value is IsrcRecoveryPhase {
  return value === "claim" || value === "settle";
}

function phaseCommand(phase: IsrcRecoveryPhase, statePath: string): string[] {
  return [
    process.execPath,
    import.meta.path,
    "--admission-phase",
    phase,
    "--phase-state",
    statePath,
  ];
}

function windowEnvelope(stdout: string, phase: IsrcRecoveryPhase): Record<string, unknown> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`isrc-recovery ${phase} window returned an invalid envelope`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`isrc-recovery ${phase} window returned an invalid envelope`);
  }

  const envelope = parsed as Record<string, unknown>;

  if (envelope.kind === "failed") {
    const message = envelope.error;

    throw new Error(typeof message === "string" ? message : `isrc-recovery ${phase} window failed`);
  }

  return envelope;
}

export function parseQueueWindowEnvelope(stdout: string): IsrcRecoveryQueueWindow {
  const envelope = windowEnvelope(stdout, "claim");

  if (envelope.kind === "repair-pending") {
    const message = envelope.message;

    return {
      kind: "repair-pending",
      message: typeof message === "string" ? message : "isrc-recovery queue read deferred",
    };
  }

  if (
    envelope.kind === "queue" &&
    typeof envelope.queueDepth === "number" &&
    Number.isInteger(envelope.queueDepth) &&
    Array.isArray(envelope.rows)
  ) {
    return {
      kind: "queue",
      queueDepth: envelope.queueDepth,
      rows: envelope.rows as IsrcRecoveryWorkItem[],
    };
  }

  throw new Error("isrc-recovery claim window returned an invalid envelope");
}

export function parseSettleWindowEnvelope(stdout: string): IsrcRecoverySettleWindow {
  const envelope = windowEnvelope(stdout, "settle");

  if (envelope.kind !== "settle" || !Array.isArray(envelope.verdicts)) {
    throw new Error("isrc-recovery settle window returned an invalid envelope");
  }

  const deferred = Array.isArray(envelope.deferred)
    ? envelope.deferred.filter((value): value is string => typeof value === "string")
    : [];

  return {
    deferred,
    kind: "settle",
    verdicts: envelope.verdicts.map((row) => {
      const record = row as { outcome?: unknown; trackId?: unknown };

      if (typeof record.trackId !== "string") {
        throw new Error("isrc-recovery settle window returned an invalid envelope");
      }

      if (record.outcome === "failed") {
        const message = (row as { message?: unknown }).message;

        return {
          message: typeof message === "string" ? message : "resolve_anchor failed",
          outcome: "failed" as const,
          trackId: record.trackId,
        };
      }

      if (record.outcome !== "settled") {
        throw new Error("isrc-recovery settle window returned an invalid envelope");
      }

      const verdict = row as { anchored?: unknown; isrcRecoveredByDeezer?: unknown };

      return {
        anchored: verdict.anchored === true,
        isrcRecoveredByDeezer: verdict.isrcRecoveredByDeezer === true,
        outcome: "settled" as const,
        trackId: record.trackId,
      };
    }),
  };
}

export function admittedWindows(): IsrcRecoveryWindows {
  const runPhase = (phase: IsrcRecoveryPhase, state: unknown): string | undefined => {
    const directory = mkdtempSync(join(tmpdir(), "fluncle-isrc-recovery-phase-"));
    const statePath = join(directory, `${phase}.json`);

    writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });

    try {
      const result = runDatabaseAdmissionPhase({
        command: phaseCommand(phase, statePath),
        owner: ADMISSION_OWNER,
        yieldRetries: 0,
      });

      return result.kind === "yielded" ? undefined : result.stdout;
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  };

  return {
    readQueue: (limit) => {
      const stdout = runPhase("claim", { limit });

      return Promise.resolve(stdout === undefined ? undefined : parseQueueWindowEnvelope(stdout));
    },
    settle: (items) => {
      const stdout = runPhase("settle", { items });

      return Promise.resolve(stdout === undefined ? undefined : parseSettleWindowEnvelope(stdout));
    },
  };
}

async function runWindowChild(
  phase: IsrcRecoveryPhase,
  statePath: string | undefined,
  effects: RuntimeEffects,
): Promise<Record<string, unknown>> {
  try {
    if (statePath === undefined) {
      return { error: "invalid isrc-recovery admission phase invocation", kind: "failed" };
    }

    const state = JSON.parse(readFileSync(statePath, "utf8")) as {
      items?: IsrcRecoverySettleItem[];
      limit?: number;
    };

    if (phase === "claim") {
      return await readIsrcRecoveryQueueWindow(Number(state.limit ?? DEFAULT_BATCH), effects);
    }

    return await settleIsrcRecoveryWindow(state.items ?? [], effects);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), kind: "failed" };
  }
}

export async function runIsrcRecoveryCli(
  args: string[],
  effects: RuntimeEffects,
): Promise<{ exitCode: number; summary: IsrcRecoverySummary }> {
  let summary: IsrcRecoverySummary;

  if (!(effects.env.FLUNCLE_API_TOKEN ?? "").trim()) {
    summary = { ...emptySummary(), errors: 1, ok: false };
  } else {
    const limit = parseLimit(args, effects.env.FLUNCLE_ISRC_RECOVERY_BATCH);

    const windows =
      effects.windows ??
      (effects.env.FLUNCLE_ADMISSION_RUNNER_PID ? inProcessWindows(effects) : admittedWindows());

    summary = await runIsrcRecoverySweep(limit, {
      log: effects.log,
      searchDeezer: (query) => searchDeezerCandidates(query, effects),
      sleep: effects.sleep,
      windows,
    });
  }

  effects.output(JSON.stringify(summary));
  return { exitCode: summary.ok ? 0 : 1, summary };
}

function argumentValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);

  return index >= 0 ? argv[index + 1] : undefined;
}

if (import.meta.main) {
  const effects: RuntimeEffects = {
    env: process.env,
    fetch: globalThis.fetch,
    log: (message) => console.error(`[isrc-recovery-sweep] ${message}`),
    output: (line) => console.log(line),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
  const argv = process.argv.slice(2);
  const admissionPhase = argumentValue(argv, "--admission-phase");

  if (admissionPhase === undefined) {
    runIsrcRecoveryCli(argv, effects)
      .then(({ exitCode }) => {
        process.exitCode = exitCode;
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        effects.log(message);
        effects.output(JSON.stringify({ ...emptySummary(), errors: 1, ok: false }));
        process.exitCode = 1;
      });
  } else if (isIsrcRecoveryPhase(admissionPhase)) {
    runWindowChild(admissionPhase, argumentValue(argv, "--phase-state"), effects)
      .then((envelope) => {
        console.log(JSON.stringify(envelope));
      })
      .catch((error: unknown) => {
        console.log(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
            kind: "failed",
          }),
        );
      });
  } else {
    console.log(
      JSON.stringify({ error: "invalid isrc-recovery admission phase invocation", kind: "failed" }),
    );
    process.exitCode = 1;
  }
}
