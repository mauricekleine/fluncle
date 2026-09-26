#!/usr/bin/env bun

const API_BASE_URL = process.env.FLUNCLE_API_BASE_URL ?? "https://www.fluncle.com";
const API_TOKEN = process.env.FLUNCLE_API_TOKEN ?? "";

const BATCH = Number(process.env.FLUNCLE_LABEL_RELEASES_LABELS ?? "5");

const MAX_PASSES = Number(process.env.FLUNCLE_LABEL_RELEASES_MAX_PASSES ?? "40");

const BUDGET_WAIT_MS = Number(process.env.FLUNCLE_LABEL_RELEASES_BUDGET_WAIT_MS ?? "30000");

const MAX_BUDGET_WAITS = Number(process.env.FLUNCLE_LABEL_RELEASES_MAX_BUDGET_WAITS ?? "12");
const MAX_THROTTLE_WAITS = 3;
const MAX_THROTTLE_WAIT_MS = 120_000;

const log = (message: string) => console.error(`[label-releases-sweep] ${message}`);

export type PassResult = {
  albumsMatched: number;
  albumsSeen: number;

  budgetPaused: boolean;

  configured: boolean;
  failedLabels: string[];

  fetchCeilingHit: boolean;

  labelsProbed: number;
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
  };

  let budgetWaits = 0;
  let throttleWaits = 0;

  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
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

    if (result.rateLimited) {
      summary.rateLimited = true;
      throttleWaits += 1;
      if (throttleWaits > MAX_THROTTLE_WAITS || result.retryAfterMs > MAX_THROTTLE_WAIT_MS) {
        summary.blockedReason = "spotify_throttle";
        return summary;
      }
      deps.log(`Spotify throttle — waiting ${result.retryAfterMs}ms before the next label`);
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

    signal: AbortSignal.timeout(120_000),
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
    log,
    runPass,
    wait,
    withinWindow: () => isSpotifyFreeWindow(new Date()),
  });

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
