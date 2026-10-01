import { getDb, typedRow } from "./db";
import { getSetting, setSetting } from "./settings";
import { bumpRateLimitCounter, readRateLimitCount } from "./rate-limit-counters";

export const SPOTIFY_CALL_WINDOW_MS = 30 * 1000;

export const SPOTIFY_CALL_WINDOW_MAX = 24;
export const SPOTIFY_QUOTA_HOLD_UNTIL_KEY = "spotify_quota_hold_until";
export const SPOTIFY_ANCHOR_DAILY_BUDGET_KEY = "anchor_spotify_daily_calls";
export const SPOTIFY_ARTIST_DAILY_BUDGET_KEY = "artist_spotify_daily_calls";
export const SPOTIFY_PUBLIC_SEARCH_DAILY_BUDGET_KEY = "public_search_spotify_daily_calls";
export const SPOTIFY_TAP_DAILY_BUDGET_KEY = "spotify_label_releases_daily_budget";
export const SPOTIFY_TAP_DAILY_BUDGET_DEFAULT = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_CALL_ACTION = "spotify-api-daily";
const ESSENTIAL_CALL_ACTION = "spotify-essential-daily";
const TAP_CALL_ACTION = "spotify-tap-daily";
const DAILY_BUCKET = "app";
const CALL_WINDOW_ACTION = "spotify-api-window";
const HOLD_FALLBACK_MS = DAY_MS;
const HOLD_MAX_MS = 26 * 60 * 60 * 1000;

export type SpotifyConsumer =
  | "anchor"
  | "artist_images"
  | "cosmetic"
  | "essential"
  | "frontier"
  | "label_tap"
  | "public_search";

const CONSUMER_BUDGETS: Record<
  Exclude<SpotifyConsumer, "cosmetic" | "essential" | "frontier">,
  { action: string; fallback: number }
> = {
  anchor: {
    action: "spotify-anchor-daily",
    fallback: 700,
  },
  artist_images: {
    action: "spotify-artist-daily",
    fallback: 150,
  },
  label_tap: {
    action: TAP_CALL_ACTION,
    fallback: SPOTIFY_TAP_DAILY_BUDGET_DEFAULT,
  },
  public_search: {
    action: "spotify-public-search-daily",
    fallback: 150,
  },
};

export async function readSpotifyQuotaHoldUntil(now = Date.now()): Promise<null | string> {
  const raw = await getSetting(SPOTIFY_QUOTA_HOLD_UNTIL_KEY);
  if (!raw) {
    return null;
  }
  const until = Date.parse(raw);
  if (!Number.isFinite(until)) {
    throw new Error("Spotify quota hold is unreadable");
  }
  return until > now ? new Date(until).toISOString() : null;
}

export async function clearSpotifyQuotaHold(): Promise<void> {
  await setSetting(SPOTIFY_QUOTA_HOLD_UNTIL_KEY, "");
}

export async function recordSpotifyQuotaHold(
  retryAfterSeconds: null | number,
  now = Date.now(),
): Promise<string> {
  const duration =
    retryAfterSeconds !== null && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? Math.min(retryAfterSeconds * 1000, HOLD_MAX_MS)
      : HOLD_FALLBACK_MS;
  const until = new Date(now + duration).toISOString();
  const result = await (
    await getDb()
  ).execute({
    args: [SPOTIFY_QUOTA_HOLD_UNTIL_KEY, until],
    sql: `insert into settings (key, value) values (?, ?)
      on conflict(key) do update set value = max(value, excluded.value)
      returning value`,
  });
  const stored = typedRow<{ value: string }>(result.rows)?.value;
  if (!stored) {
    throw new Error("Spotify quota hold could not be recorded");
  }
  return stored;
}

export async function readSpotifyConsumerDailyBudget(
  consumer: Exclude<SpotifyConsumer, "cosmetic" | "essential" | "frontier">,
): Promise<number> {
  const config = CONSUMER_BUDGETS[consumer];
  const raw =
    consumer === "anchor"
      ? await getSetting(SPOTIFY_ANCHOR_DAILY_BUDGET_KEY)
      : consumer === "artist_images"
        ? await getSetting(SPOTIFY_ARTIST_DAILY_BUDGET_KEY)
        : consumer === "label_tap"
          ? await getSetting(SPOTIFY_TAP_DAILY_BUDGET_KEY)
          : await getSetting(SPOTIFY_PUBLIC_SEARCH_DAILY_BUDGET_KEY);
  return parseCount(raw, config.fallback);
}

export async function setSpotifyConsumerDailyBudget(
  consumer: Exclude<SpotifyConsumer, "cosmetic" | "essential" | "frontier">,
  calls: number,
): Promise<void> {
  if (!Number.isSafeInteger(calls) || calls < 0 || calls > 1_000_000) {
    throw new Error("Spotify daily budget must be an integer from 0 to 1000000");
  }
  if (consumer === "anchor") {
    await setSetting(SPOTIFY_ANCHOR_DAILY_BUDGET_KEY, String(calls));
  } else if (consumer === "artist_images") {
    await setSetting(SPOTIFY_ARTIST_DAILY_BUDGET_KEY, String(calls));
  } else if (consumer === "label_tap") {
    await setSetting(SPOTIFY_TAP_DAILY_BUDGET_KEY, String(calls));
  } else {
    await setSetting(SPOTIFY_PUBLIC_SEARCH_DAILY_BUDGET_KEY, String(calls));
  }
}

export async function readSpotifyConsumerDailyCallsSpent(
  consumer: Exclude<SpotifyConsumer, "cosmetic" | "essential" | "frontier">,
  now = Date.now(),
): Promise<number> {
  return readRateLimitCount({
    action: CONSUMER_BUDGETS[consumer].action,
    bucket: DAILY_BUCKET,
    now,
    windowMs: DAY_MS,
  });
}

export async function chargeSpotifyConsumerDailyCall(
  consumer: Exclude<SpotifyConsumer, "cosmetic" | "essential" | "frontier">,
  now = Date.now(),
): Promise<boolean> {
  const config = CONSUMER_BUDGETS[consumer];
  const limit = await readSpotifyConsumerDailyBudget(consumer);
  if (limit < 1) {
    return false;
  }
  return (
    (await bumpRateLimitCounter({
      action: config.action,
      bucket: DAILY_BUCKET,
      limit,
      now,
      windowMs: DAY_MS,
    })) !== undefined
  );
}

export async function readSpotifyDailyCallCount(now = Date.now()): Promise<number> {
  return readRateLimitCount({
    action: DAILY_CALL_ACTION,
    bucket: DAILY_BUCKET,
    now,
    windowMs: DAY_MS,
  });
}

export async function readSpotifyEssentialDailyCalls(now = Date.now()): Promise<number> {
  return readRateLimitCount({
    action: ESSENTIAL_CALL_ACTION,
    bucket: DAILY_BUCKET,
    now,
    windowMs: DAY_MS,
  });
}

export async function recordSpotifyDailyCall(
  now = Date.now(),
  consumer: SpotifyConsumer = "essential",
): Promise<void> {
  await bumpRateLimitCounter({
    action: DAILY_CALL_ACTION,
    bucket: DAILY_BUCKET,
    limit: 1_000_000_000,
    now,
    windowMs: DAY_MS,
  });
  if (consumer === "essential") {
    await bumpRateLimitCounter({
      action: ESSENTIAL_CALL_ACTION,
      bucket: DAILY_BUCKET,
      limit: 1_000_000_000,
      now,
      windowMs: DAY_MS,
    });
  }
}

export async function readSpotifyTapDailyBudget(): Promise<number> {
  return readSpotifyConsumerDailyBudget("label_tap");
}

export async function setSpotifyTapDailyBudget(calls: number): Promise<void> {
  await setSpotifyConsumerDailyBudget("label_tap", calls);
}

export async function readSpotifyTapDailyCallsSpent(now = Date.now()): Promise<number> {
  return readSpotifyConsumerDailyCallsSpent("label_tap", now);
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

export async function readSpotifyCallCount(now: number = Date.now()): Promise<number> {
  return readRateLimitCount({
    action: CALL_WINDOW_ACTION,
    bucket: DAILY_BUCKET,
    now,
    windowMs: SPOTIFY_CALL_WINDOW_MS,
  });
}

export async function isSpotifyCallBudgetAvailable(now: number = Date.now()): Promise<boolean> {
  try {
    return (await readSpotifyCallCount(now)) < SPOTIFY_CALL_WINDOW_MAX;
  } catch {
    return false;
  }
}

export async function recordSpotifyCall(now: number = Date.now()): Promise<boolean> {
  return (
    (await bumpRateLimitCounter({
      action: CALL_WINDOW_ACTION,
      bucket: DAILY_BUCKET,
      limit: SPOTIFY_CALL_WINDOW_MAX,
      now,
      windowMs: SPOTIFY_CALL_WINDOW_MS,
    })) !== undefined
  );
}
