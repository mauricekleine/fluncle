import { logEvent } from "./log";
import { getSettings, setSetting } from "./settings";
import { clearSpotifyQuotaHold, readSpotifyQuotaHoldUntil } from "./spotify-budget";

export const SPOTIFY_ANCHOR_BREAKER_TRIPPED_AT_KEY = "spotify_anchor_breaker_tripped_at";

export const SPOTIFY_ANCHOR_BREAKER_FAILURES_KEY = "spotify_anchor_breaker_failures";

export const SPOTIFY_ANCHOR_BREAKER_REASON_KEY = "spotify_anchor_breaker_reason";

const SPOTIFY_ANCHOR_BREAKER_LAST_FAILURE_AT_KEY = "spotify_anchor_breaker_last_failure_at";
export async function getSpotifyAnchorQuotaUntil(
  now: number,
  settings?: ReadonlyMap<string, string | undefined>,
): Promise<null | string> {
  return readSpotifyQuotaHoldUntil(now, settings);
}

export const SPOTIFY_ANCHOR_BREAKER_KEYS = [
  SPOTIFY_ANCHOR_BREAKER_TRIPPED_AT_KEY,
  SPOTIFY_ANCHOR_BREAKER_FAILURES_KEY,
  SPOTIFY_ANCHOR_BREAKER_REASON_KEY,
  SPOTIFY_ANCHOR_BREAKER_LAST_FAILURE_AT_KEY,
] as const;

export const SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES = 5;

export const SPOTIFY_ANCHOR_BREAKER_FAILURE_WINDOW_MS = 10 * 60 * 1000;

export const SPOTIFY_ANCHOR_BREAKER_COOLDOWN_MS = 60 * 60 * 1000;

export const SPOTIFY_ANCHOR_BREAKER_REASON_THROTTLED = "throttled";
export const SPOTIFY_ANCHOR_BREAKER_REASON_QUOTA = "quota_exceeded";

function parseCount(raw: string | undefined, fallback = 0): number {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) {
    return fallback;
  }

  const parsed = Number(raw.trim());

  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function parseStamp(raw: null | string | undefined): number {
  return raw ? Date.parse(raw) : Number.NaN;
}

export function spotifyAnchorBreakerVerdict(input: { now: number; trippedAt: null | string }): {
  corrupt: boolean;
  cooldownRemainingMs: number;
  tripped: boolean;
} {
  if (!input.trippedAt) {
    return { cooldownRemainingMs: 0, corrupt: false, tripped: false };
  }

  const trippedMs = parseStamp(input.trippedAt);

  if (!Number.isFinite(trippedMs)) {
    return {
      cooldownRemainingMs: SPOTIFY_ANCHOR_BREAKER_COOLDOWN_MS,
      corrupt: true,
      tripped: true,
    };
  }

  const remaining = SPOTIFY_ANCHOR_BREAKER_COOLDOWN_MS - (input.now - trippedMs);

  return remaining > 0
    ? { cooldownRemainingMs: remaining, corrupt: false, tripped: true }
    : { cooldownRemainingMs: 0, corrupt: false, tripped: false };
}

export function spotifyAnchorFailureStreak(input: {
  failures: number;
  lastFailureAt: null | string;
  now: number;
}): number {
  const lastMs = parseStamp(input.lastFailureAt);
  const windowLive =
    Number.isFinite(lastMs) && input.now - lastMs < SPOTIFY_ANCHOR_BREAKER_FAILURE_WINDOW_MS;

  return windowLive ? input.failures + 1 : 1;
}

export type SpotifyAnchorBreakerState = {
  cooldownRemainingMs: number;

  reason: null | string;

  throttlesInWindow: number;

  tripped: boolean;

  trippedAt: null | string;
};

export async function getSpotifyAnchorBreakerState(
  now: number = Date.now(),
  settings?: ReadonlyMap<string, string | undefined>,
): Promise<SpotifyAnchorBreakerState> {
  const values = settings ?? (await getSettings(SPOTIFY_ANCHOR_BREAKER_KEYS));
  const trippedAt = values.get(SPOTIFY_ANCHOR_BREAKER_TRIPPED_AT_KEY);
  const failures = values.get(SPOTIFY_ANCHOR_BREAKER_FAILURES_KEY);
  const reason = values.get(SPOTIFY_ANCHOR_BREAKER_REASON_KEY);
  const lastFailureAt = values.get(SPOTIFY_ANCHOR_BREAKER_LAST_FAILURE_AT_KEY);

  const verdict = spotifyAnchorBreakerVerdict({ now, trippedAt: trippedAt ?? null });
  const lastMs = parseStamp(lastFailureAt);
  const windowLive =
    Number.isFinite(lastMs) && now - lastMs < SPOTIFY_ANCHOR_BREAKER_FAILURE_WINDOW_MS;

  return {
    cooldownRemainingMs: verdict.cooldownRemainingMs,
    reason: verdict.tripped ? reason || SPOTIFY_ANCHOR_BREAKER_REASON_THROTTLED : null,
    throttlesInWindow: windowLive ? parseCount(failures) : 0,
    tripped: verdict.tripped,
    trippedAt: verdict.tripped ? (trippedAt ?? null) : null,
  };
}

export async function spotifyAnchorSearchBreakerTripped(
  now: number = Date.now(),
): Promise<boolean> {
  try {
    return (await getSpotifyAnchorBreakerState(now)).tripped;
  } catch (error) {
    logEvent("warn", "spotify.anchor-breaker-read-failed", { error });

    return true;
  }
}

export async function recordSpotifyThrottle(
  now: number = Date.now(),
  quotaExceeded = false,
): Promise<void> {
  try {
    const values = await getSettings([
      SPOTIFY_ANCHOR_BREAKER_TRIPPED_AT_KEY,
      SPOTIFY_ANCHOR_BREAKER_FAILURES_KEY,
      SPOTIFY_ANCHOR_BREAKER_LAST_FAILURE_AT_KEY,
    ]);
    const trippedAt = values.get(SPOTIFY_ANCHOR_BREAKER_TRIPPED_AT_KEY);
    const failures = values.get(SPOTIFY_ANCHOR_BREAKER_FAILURES_KEY);
    const lastFailureAt = values.get(SPOTIFY_ANCHOR_BREAKER_LAST_FAILURE_AT_KEY);

    const verdict = spotifyAnchorBreakerVerdict({ now, trippedAt: trippedAt ?? null });

    if (verdict.corrupt) {
      await Promise.all([
        setSetting(SPOTIFY_ANCHOR_BREAKER_TRIPPED_AT_KEY, new Date(now).toISOString()),
        setSetting(SPOTIFY_ANCHOR_BREAKER_REASON_KEY, SPOTIFY_ANCHOR_BREAKER_REASON_THROTTLED),
      ]);

      return;
    }

    if (verdict.tripped) {
      return;
    }

    const streak = spotifyAnchorFailureStreak({
      failures: parseCount(failures),
      lastFailureAt: lastFailureAt ?? null,
      now,
    });
    const stamp = new Date(now).toISOString();
    if (streak >= SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES) {
      const reason = quotaExceeded
        ? SPOTIFY_ANCHOR_BREAKER_REASON_QUOTA
        : SPOTIFY_ANCHOR_BREAKER_REASON_THROTTLED;
      await Promise.all([
        setSetting(SPOTIFY_ANCHOR_BREAKER_TRIPPED_AT_KEY, stamp),
        setSetting(SPOTIFY_ANCHOR_BREAKER_REASON_KEY, reason),
        setSetting(SPOTIFY_ANCHOR_BREAKER_FAILURES_KEY, "0"),
        setSetting(SPOTIFY_ANCHOR_BREAKER_LAST_FAILURE_AT_KEY, stamp),
      ]);

      logEvent("warn", "spotify.anchor-breaker-tripped", {
        cooldownMs: SPOTIFY_ANCHOR_BREAKER_COOLDOWN_MS,
        reason,
        throttles: streak,
      });

      return;
    }

    await Promise.all([
      setSetting(SPOTIFY_ANCHOR_BREAKER_FAILURES_KEY, String(streak)),
      setSetting(SPOTIFY_ANCHOR_BREAKER_LAST_FAILURE_AT_KEY, stamp),
    ]);
  } catch (error) {
    logEvent("warn", "spotify.anchor-breaker-record-failed", { error });
  }
}

export async function resetSpotifyAnchorBreaker(): Promise<SpotifyAnchorBreakerState> {
  await Promise.all([
    setSetting(SPOTIFY_ANCHOR_BREAKER_TRIPPED_AT_KEY, ""),
    setSetting(SPOTIFY_ANCHOR_BREAKER_REASON_KEY, ""),
    setSetting(SPOTIFY_ANCHOR_BREAKER_FAILURES_KEY, "0"),
    setSetting(SPOTIFY_ANCHOR_BREAKER_LAST_FAILURE_AT_KEY, ""),
    clearSpotifyQuotaHold(),
  ]);

  return getSpotifyAnchorBreakerState();
}
