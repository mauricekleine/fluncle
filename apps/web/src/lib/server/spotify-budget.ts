import { getSetting, setSetting } from "./settings";
import { bumpRateLimitCounter, readRateLimitCount } from "./rate-limit-counters";

export const SPOTIFY_CALLS_WINDOW_START_KEY = "spotify_calls_window_start";

export const SPOTIFY_CALLS_WINDOW_COUNT_KEY = "spotify_calls_window_count";

export const SPOTIFY_CALL_WINDOW_MS = 30 * 1000;

export const SPOTIFY_CALL_WINDOW_MAX = 24;
export const SPOTIFY_TAP_DAILY_BUDGET_KEY = "spotify_label_releases_daily_budget";
export const SPOTIFY_TAP_DAILY_BUDGET_DEFAULT = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_CALL_ACTION = "spotify-api-daily";
const TAP_CALL_ACTION = "spotify-tap-daily";
const DAILY_BUCKET = "app";

export async function readSpotifyDailyCallCount(now = Date.now()): Promise<number> {
  return readRateLimitCount({
    action: DAILY_CALL_ACTION,
    bucket: DAILY_BUCKET,
    now,
    windowMs: DAY_MS,
  });
}

export async function recordSpotifyDailyCall(now = Date.now()): Promise<void> {
  await bumpRateLimitCounter({
    action: DAILY_CALL_ACTION,
    bucket: DAILY_BUCKET,
    limit: 1_000_000_000,
    now,
    windowMs: DAY_MS,
  });
}

export async function readSpotifyTapDailyBudget(): Promise<number> {
  const raw = await getSetting(SPOTIFY_TAP_DAILY_BUDGET_KEY);
  return parseCount(raw, SPOTIFY_TAP_DAILY_BUDGET_DEFAULT);
}

export async function setSpotifyTapDailyBudget(calls: number): Promise<void> {
  if (!Number.isSafeInteger(calls) || calls < 0 || calls > 1_000_000) {
    throw new Error("Tap daily budget must be an integer from 0 to 1000000");
  }
  await setSetting(SPOTIFY_TAP_DAILY_BUDGET_KEY, String(calls));
}

export async function readSpotifyTapDailyCallsSpent(now = Date.now()): Promise<number> {
  return readRateLimitCount({
    action: TAP_CALL_ACTION,
    bucket: DAILY_BUCKET,
    now,
    windowMs: DAY_MS,
  });
}

export async function chargeSpotifyTapDailyCall(
  budget: number,
  now = Date.now(),
): Promise<boolean> {
  if (budget < 1) {
    return false;
  }
  return (
    (await bumpRateLimitCounter({
      action: TAP_CALL_ACTION,
      bucket: DAILY_BUCKET,
      limit: budget,
      now,
      windowMs: DAY_MS,
    })) !== undefined
  );
}

function parseCount(raw: string | undefined, fallback = 0): number {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) {
    return fallback;
  }

  const parsed = Number(raw.trim());

  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

export function spotifyCallWindow(input: { count: number; now: number; startMs: number }): {
  count: number;

  live: boolean;

  msUntilReset: number;
} {
  const { count, now, startMs } = input;

  if (!Number.isFinite(startMs) || now - startMs >= SPOTIFY_CALL_WINDOW_MS) {
    return { count: 0, live: false, msUntilReset: 0 };
  }

  return { count, live: true, msUntilReset: SPOTIFY_CALL_WINDOW_MS - (now - startMs) };
}

async function readSpotifyCallWindow(
  now: number,
): Promise<{ count: number; msUntilReset: number }> {
  const [start, count] = await Promise.all([
    getSetting(SPOTIFY_CALLS_WINDOW_START_KEY),
    getSetting(SPOTIFY_CALLS_WINDOW_COUNT_KEY),
  ]);

  const startMs = start ? Date.parse(start) : Number.NaN;
  const window = spotifyCallWindow({ count: parseCount(count), now, startMs });

  return { count: window.count, msUntilReset: window.msUntilReset };
}

export async function readSpotifyCallCount(now: number = Date.now()): Promise<number> {
  return (await readSpotifyCallWindow(now)).count;
}

export async function isSpotifyCallBudgetAvailable(now: number = Date.now()): Promise<boolean> {
  try {
    return (await readSpotifyCallWindow(now)).count < SPOTIFY_CALL_WINDOW_MAX;
  } catch {
    return true;
  }
}

export async function recordSpotifyCall(now: number = Date.now()): Promise<void> {
  const [start, count] = await Promise.all([
    getSetting(SPOTIFY_CALLS_WINDOW_START_KEY),
    getSetting(SPOTIFY_CALLS_WINDOW_COUNT_KEY),
  ]);

  const startMs = start ? Date.parse(start) : Number.NaN;

  if (!Number.isFinite(startMs) || now - startMs >= SPOTIFY_CALL_WINDOW_MS) {
    await Promise.all([
      setSetting(SPOTIFY_CALLS_WINDOW_START_KEY, new Date(now).toISOString()),
      setSetting(SPOTIFY_CALLS_WINDOW_COUNT_KEY, "1"),
    ]);

    return;
  }

  await setSetting(SPOTIFY_CALLS_WINDOW_COUNT_KEY, String(parseCount(count) + 1));
}
