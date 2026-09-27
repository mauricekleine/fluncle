#!/usr/bin/env bun

import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { findJsonSummary } from "./cron-marker";

const API_BASE_URL = process.env.FLUNCLE_API_BASE_URL ?? "https://www.fluncle.com";
const API_TOKEN = process.env.FLUNCLE_API_TOKEN ?? "";

const BATCH = Number(process.env.FLUNCLE_LABEL_RELEASES_LABELS ?? "5");

const MAX_PASSES = Number(process.env.FLUNCLE_LABEL_RELEASES_MAX_PASSES ?? "40");

const BUDGET_WAIT_MS = Number(process.env.FLUNCLE_LABEL_RELEASES_BUDGET_WAIT_MS ?? "30000");

const MAX_BUDGET_WAITS = Number(process.env.FLUNCLE_LABEL_RELEASES_MAX_BUDGET_WAITS ?? "12");
const MAX_THROTTLE_WAITS = 3;
const MAX_THROTTLE_WAIT_MS = 120_000;
const TICK_WALL_MS = 12 * 60_000;
const PASS_TIMEOUT_MS = 120_000;
const CRON_OUTPUT_DIR =
  process.env.HEALTHCHECK_CRON_OUTPUT_DIR ??
  join(dirname(process.env.HOME ?? "/opt/data/home"), "cron", "output");

const log = (message: string) => console.error(`[label-releases-sweep] ${message}`);

export type PassResult = {
  albumsMatched: number;
  albumsSeen: number;

  budgetPaused: boolean;

  configured: boolean;
  failedLabels: string[];

  fetchCeilingHit: boolean;

  labelsProbed: number;
  tapDailyBudget: number;
  tapDailyCallsSpent: number;
  labelsDue: number;
  neverChecked: number;
  newRows: number;
  rateLimited: boolean;
  quotaExceeded: boolean;
  retryAfterMs: number;
  blockedReason: null | string;
  skippedKnown: number;
  skippedUndated: number;
  skippedUngrounded: number;
};

export type LabelReleasesSummary = {
  albumsMatched: number;
  albumsSeen: number;

  budgetPaused: boolean;

  checked: null | number;

  configured: boolean;
  error: null | string;

  errors: number;

  failed: number;

  failedLabels: number;

  labelsProbed: number;
  tapDailyBudget: number;
  tapDailyCallsSpent: number;
  labelsDue: number;
  neverChecked: number;
  newRows: number;
  ok: boolean;

  passes: number;

  produced: null | number;

  rateLimited: boolean;
  quotaExceeded: boolean;
  blockedReason: null | string;
  skippedKnown: number;
  skippedUndated: number;
  skippedUngrounded: number;
};

export type LabelReleasesDeps = {
  log: (message: string) => void;
  now?: () => Date;
  anchorReady?: (now: Date) => boolean;
  withinWindow?: () => boolean;

  runPass: (limit: number) => Promise<PassResult>;

  wait: (ms: number) => Promise<void>;
};

export function parseLimitArg(argv: string[], fallback: number): number {
  const index = argv.indexOf("--limit");
  const raw = index >= 0 ? argv[index + 1] : undefined;
  const parsed = Number(raw);

  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

export function isSpotifyFreeWindow(now: Date): boolean {
  return now.getUTCHours() >= 3 && now.getUTCHours() < 9;
}

export function anchorReadyForTap(dir: string, now: Date): boolean {
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((name) => name.endsWith(".md"))
      .map((name) => join(dir, name))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  } catch {
    return false;
  }
  const currentHour = now.toISOString().slice(0, 13);
  for (const path of files) {
    let modified: number;
    try {
      modified = statSync(path).mtimeMs;
    } catch {
      return false;
    }
    if (modified > now.getTime() || now.getTime() - modified > 60 * 60_000) {
      continue;
    }
    let summary: Record<string, unknown> | null;
    try {
      summary = findJsonSummary(readFileSync(path, "utf8"));
    } catch {
      return false;
    }
    if (
      summary?.ok !== true ||
      summary.gateState === "admission-skipped" ||
      summary.gateState === "paused"
    ) {
      return false;
    }
    return (
      new Date(modified).toISOString().slice(0, 13) === currentHour && summary.spotifyIsrcDue === 0
    );
  }
  return false;
}

export type TapDailyState = {
  blockedReasons: string[];
  day: string;
  labelsProbed: number;
  nonPriorityFirings: number;
  observedDemand: number | null;
  tapDailyBudget: number;
  tapDailyCallsSpent: number;
};

export function recordTapDailyState(
  dir: string,
  summary: LabelReleasesSummary,
  now: Date,
): TapDailyState {
  const day = now.toISOString().slice(0, 10);
  const stateDir = join(dir, "daily");
  const path = join(stateDir, `${day}.json`);
  let previous: TapDailyState | null = null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<TapDailyState>;
    if (
      parsed.day === day &&
      Number.isSafeInteger(parsed.labelsProbed) &&
      (parsed.observedDemand === null || Number.isSafeInteger(parsed.observedDemand))
    ) {
      previous = parsed as TapDailyState;
    }
  } catch {}
  const labelsProbed = (previous?.labelsProbed ?? 0) + summary.labelsProbed;
  const demand = summary.passes > 0 ? (previous?.labelsProbed ?? 0) + summary.labelsDue : null;
  const state: TapDailyState = {
    blockedReasons: [
      ...new Set([
        ...(previous?.blockedReasons ?? []),
        ...(summary.blockedReason ? [summary.blockedReason] : []),
      ]),
    ],
    day,
    labelsProbed,
    nonPriorityFirings:
      (previous?.nonPriorityFirings ?? 0) + (summary.blockedReason === "anchor_priority" ? 0 : 1),
    observedDemand:
      demand === null
        ? (previous?.observedDemand ?? null)
        : Math.max(previous?.observedDemand ?? 0, demand),
    tapDailyBudget:
      Number.isSafeInteger(summary.tapDailyBudget) && summary.tapDailyBudget >= 0
        ? summary.tapDailyBudget
        : (previous?.tapDailyBudget ?? 500),
    tapDailyCallsSpent: Math.max(previous?.tapDailyCallsSpent ?? 0, summary.tapDailyCallsSpent),
  };
  mkdirSync(stateDir, { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state));
  renameSync(temporary, path);
  return state;
}

export async function runLabelReleasesTick(
  limit: number,
  deps: LabelReleasesDeps,
): Promise<LabelReleasesSummary> {
  const summary: LabelReleasesSummary = {
    albumsMatched: 0,
    albumsSeen: 0,
    blockedReason: null,
    budgetPaused: false,
    checked: null,
    configured: true,
    error: null,
    errors: 0,
    failed: 0,
    failedLabels: 0,
    labelsDue: 0,
    labelsProbed: 0,
    neverChecked: 0,
    newRows: 0,
    ok: true,
    passes: 0,
    produced: null,
    quotaExceeded: false,
    rateLimited: false,
    skippedKnown: 0,
    skippedUndated: 0,
    skippedUngrounded: 0,
    tapDailyBudget: 500,
    tapDailyCallsSpent: 0,
  };

  let budgetWaits = 0;
  let throttleWaits = 0;
  const now = deps.now ?? (() => new Date());
  const started = now().getTime();

  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    if (deps.anchorReady?.(now()) === false) {
      summary.blockedReason = "anchor_priority";
      return summary;
    }
    if (now().getTime() - started + PASS_TIMEOUT_MS >= TICK_WALL_MS) {
      summary.blockedReason = "tick_wall_budget";
      return summary;
    }
    if (deps.withinWindow?.() === false) {
      summary.blockedReason = "outside_spotify_window";
      return summary;
    }
    let result: PassResult;

    try {
      result = await deps.runPass(limit);
    } catch (error) {
      summary.ok = false;
      summary.error = error instanceof Error ? error.message : String(error);
      summary.errors = 1;

      return summary;
    }

    summary.passes += 1;
    summary.labelsProbed += result.labelsProbed;
    summary.tapDailyBudget =
      Number.isSafeInteger(result.tapDailyBudget) && result.tapDailyBudget >= 0
        ? result.tapDailyBudget
        : summary.tapDailyBudget;
    summary.tapDailyCallsSpent = Math.max(summary.tapDailyCallsSpent, result.tapDailyCallsSpent);
    if (summary.passes === 1) {
      summary.labelsDue = result.labelsDue;
      summary.neverChecked = result.neverChecked;
    }
    summary.checked = (summary.checked ?? 0) + result.labelsProbed + result.failedLabels.length;
    summary.albumsSeen += result.albumsSeen;
    summary.albumsMatched += result.albumsMatched;
    summary.newRows += result.newRows;
    summary.produced = (summary.produced ?? 0) + result.labelsProbed;
    summary.skippedKnown += result.skippedKnown;
    summary.skippedUndated += result.skippedUndated;
    summary.skippedUngrounded += result.skippedUngrounded;
    summary.failed += result.failedLabels.length;
    summary.failedLabels += result.failedLabels.length;

    if (!result.configured) {
      summary.configured = false;
      deps.log("spotify grant gone (configured:false) — reconnect Spotify to resume the tap");

      return summary;
    }

    if (result.quotaExceeded || result.blockedReason === "spotify_quota") {
      summary.rateLimited = true;
      summary.quotaExceeded = true;
      summary.blockedReason = "spotify_quota";
      deps.log("Spotify daily quota closed — standing down until the next free window");

      return summary;
    }

    if (result.blockedReason === "spotify_breaker") {
      summary.blockedReason = "spotify_breaker";
      return summary;
    }

    if (result.blockedReason === "spotify_budget_spent") {
      summary.blockedReason = "spotify_budget_spent";
      return summary;
    }

    if (result.rateLimited) {
      summary.rateLimited = true;
      throttleWaits += 1;
      if (throttleWaits > MAX_THROTTLE_WAITS || result.retryAfterMs > MAX_THROTTLE_WAIT_MS) {
        summary.blockedReason = "spotify_throttle";
        return summary;
      }
      deps.log(`Spotify throttle — waiting ${result.retryAfterMs}ms before the next label`);
      if (now().getTime() - started + result.retryAfterMs + PASS_TIMEOUT_MS >= TICK_WALL_MS) {
        summary.blockedReason = "spotify_throttle";
        return summary;
      }
      await deps.wait(result.retryAfterMs);
      continue;
    }

    if (result.budgetPaused) {
      budgetWaits += 1;
      summary.budgetPaused = true;

      if (budgetWaits > MAX_BUDGET_WAITS) {
        summary.blockedReason = "spotify_budget";
        deps.log(
          `stood down ${MAX_BUDGET_WAITS}x for the shared Spotify budget — leaving the rest`,
        );

        return summary;
      }

      deps.log(`shared Spotify budget busy — standing down ${BUDGET_WAIT_MS}ms for a user path`);
      if (now().getTime() - started + BUDGET_WAIT_MS + PASS_TIMEOUT_MS >= TICK_WALL_MS) {
        summary.blockedReason = "spotify_budget";
        return summary;
      }
      await deps.wait(BUDGET_WAIT_MS);
      continue;
    }

    if (result.labelsProbed === 0) {
      return summary;
    }
  }

  deps.log(`hit the ${MAX_PASSES}-pass fuse — the next tick drains the rest`);

  return summary;
}

async function runPass(limit: number): Promise<PassResult> {
  const res = await fetch(`${API_BASE_URL}/api/v1/admin/backfill/label-releases`, {
    body: JSON.stringify({ dryRun: false, limit }),
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
    },
    method: "POST",

    signal: AbortSignal.timeout(PASS_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(
      `backfill_label_releases failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }

  const body = (await res.json()) as Partial<PassResult>;

  return {
    albumsMatched: Number(body.albumsMatched ?? 0),
    albumsSeen: Number(body.albumsSeen ?? 0),
    blockedReason: typeof body.blockedReason === "string" ? body.blockedReason : null,
    budgetPaused: Boolean(body.budgetPaused),
    configured: body.configured !== false,
    failedLabels: Array.isArray(body.failedLabels) ? body.failedLabels : [],
    fetchCeilingHit: Boolean(body.fetchCeilingHit),
    labelsDue: Number(body.labelsDue ?? 0),
    labelsProbed: Number(body.labelsProbed ?? 0),
    neverChecked: Number(body.neverChecked ?? 0),
    newRows: Number(body.newRows ?? 0),
    quotaExceeded: Boolean(body.quotaExceeded),
    rateLimited: Boolean(body.rateLimited),
    retryAfterMs: Number(body.retryAfterMs ?? 0),
    skippedKnown: Number(body.skippedKnown ?? 0),
    skippedUndated: Number(body.skippedUndated ?? 0),
    skippedUngrounded: Number(body.skippedUngrounded ?? 0),
    tapDailyBudget: Number(body.tapDailyBudget ?? 500),
    tapDailyCallsSpent: Number(body.tapDailyCallsSpent ?? 0),
  };
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function main(): Promise<void> {
  const started = Date.now();

  if (!API_TOKEN) {
    console.log(
      JSON.stringify({
        checked: null,
        errors: 1,
        ok: false,
        produced: null,
        reason: "missing_api_token",
      }),
    );
    process.exit(1);
  }

  const limit = parseLimitArg(
    process.argv.slice(2),
    Number.isFinite(BATCH) && BATCH > 0 ? Math.trunc(BATCH) : 5,
  );

  const summary = await runLabelReleasesTick(limit, {
    anchorReady: (now) => anchorReadyForTap(join(CRON_OUTPUT_DIR, "fluncle-anchor"), now),
    log,
    runPass,
    wait,
    withinWindow: () => isSpotifyFreeWindow(new Date()),
  });

  recordTapDailyState(join(CRON_OUTPUT_DIR, "fluncle-label-releases"), summary, new Date());

  console.log(JSON.stringify({ ...summary, elapsedMs: Date.now() - started }));

  if (!summary.ok) {
    process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    log(`label-releases-sweep failed: ${message}`);
    console.log(
      JSON.stringify({
        checked: null,
        error: message,
        errors: 1,
        ok: false,
        produced: null,
        reason: "label_releases_failed",
      }),
    );
    process.exit(1);
  });
}
