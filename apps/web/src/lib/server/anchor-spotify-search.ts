import { logEvent } from "./log";
import {
  getSpotifyAnchorBreakerState,
  getSpotifyAnchorQuotaUntil,
  SPOTIFY_ANCHOR_BREAKER_KEYS,
  SPOTIFY_ANCHOR_BREAKER_REASON_QUOTA,
} from "./spotify-anchor-breaker";
import { getSetting, getSettings, setSetting } from "./settings";
import {
  isSpotifyCallBudgetAvailable,
  readSpotifyConsumerDailyBudget,
  readSpotifyConsumerDailyCallsSpent,
  readSpotifyQuotaHoldUntil,
  SPOTIFY_ANCHOR_DAILY_BUDGET_KEY,
  SPOTIFY_QUOTA_HOLD_UNTIL_KEY,
} from "./spotify-budget";

export const ANCHOR_SPOTIFY_SEARCH_ENABLED_KEY = "anchor_spotify_search_enabled";

export const ANCHOR_QUOTA_EXCEPTION_START_HOUR_UTC = 9;

export async function isAnchorSpotifySearchEnabled(): Promise<boolean> {
  return (await getSetting(ANCHOR_SPOTIFY_SEARCH_ENABLED_KEY)) === "true";
}

export async function setAnchorSpotifySearchEnabled(enabled: boolean): Promise<void> {
  await setSetting(ANCHOR_SPOTIFY_SEARCH_ENABLED_KEY, enabled ? "true" : "false");
}

export const FRONTIER_REFRESH_GATE_TIMEZONE = "Europe/Amsterdam";

export const FRONTIER_REFRESH_GATE_WEEKDAY = "Fri";

export const FRONTIER_REFRESH_GATE_START_HOUR = 6;

export const FRONTIER_REFRESH_GATE_END_HOUR = 9;

export function isWithinFrontierRefreshWindow(now: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    hourCycle: "h23",
    timeZone: FRONTIER_REFRESH_GATE_TIMEZONE,
    weekday: "short",
  }).formatToParts(now);

  const weekday = parts.find((part) => part.type === "weekday")?.value;
  const hour = Number(parts.find((part) => part.type === "hour")?.value) % 24;

  if (weekday !== FRONTIER_REFRESH_GATE_WEEKDAY || !Number.isFinite(hour)) {
    return false;
  }

  return hour >= FRONTIER_REFRESH_GATE_START_HOUR && hour < FRONTIER_REFRESH_GATE_END_HOUR;
}

export type AnchorSpotifyGateReason =
  | "breaker_quota"
  | "breaker_throttle"
  | "daily_budget"
  | "flag_off"
  | "friday_window"
  | "open"
  | "quota_hold"
  | "shared_meter";

export type AnchorSpotifyGate = { nextEligibleAt: null | string; reason: AnchorSpotifyGateReason };

export async function anchorSpotifySearchGate(now: Date): Promise<AnchorSpotifyGate> {
  if (isWithinFrontierRefreshWindow(now)) {
    const next = new Date(now);
    while (isWithinFrontierRefreshWindow(next)) {
      next.setTime(next.getTime() + 60_000);
    }
    return { nextEligibleAt: next.toISOString(), reason: "friday_window" };
  }

  if (!(await isAnchorSpotifySearchEnabled())) {
    return { nextEligibleAt: null, reason: "flag_off" };
  }

  try {
    const values = await getSettings([
      ...SPOTIFY_ANCHOR_BREAKER_KEYS,
      SPOTIFY_QUOTA_HOLD_UNTIL_KEY,
    ]);
    const breaker = await getSpotifyAnchorBreakerState(now.getTime(), values);
    const validTrip = breaker.trippedAt !== null && !Number.isNaN(Date.parse(breaker.trippedAt));
    if (breaker.tripped && !validTrip) {
      return { nextEligibleAt: null, reason: "breaker_throttle" };
    }
    const quotaUntil = await getSpotifyAnchorQuotaUntil(now.getTime(), values);
    const quotaHoldEnd = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      ANCHOR_QUOTA_EXCEPTION_START_HOUR_UTC,
    );
    if (quotaUntil) {
      if (now.getTime() < quotaHoldEnd) {
        return {
          nextEligibleAt: new Date(Math.min(Date.parse(quotaUntil), quotaHoldEnd)).toISOString(),
          reason: "quota_hold",
        };
      }
      return { nextEligibleAt: quotaUntil, reason: "breaker_quota" };
    }
    if (breaker.tripped && breaker.reason !== SPOTIFY_ANCHOR_BREAKER_REASON_QUOTA) {
      return {
        nextEligibleAt: validTrip
          ? new Date(now.getTime() + breaker.cooldownRemainingMs).toISOString()
          : null,
        reason: "breaker_throttle",
      };
    }
  } catch (error) {
    logEvent("warn", "spotify.anchor-breaker-read-failed", { error });
    return { nextEligibleAt: null, reason: "breaker_throttle" };
  }

  try {
    const [spent, budget] = await Promise.all([
      readSpotifyConsumerDailyCallsSpent("anchor", now.getTime()),
      readSpotifyConsumerDailyBudget("anchor"),
    ]);
    if (spent >= budget) {
      return { nextEligibleAt: null, reason: "daily_budget" };
    }
  } catch (error) {
    logEvent("warn", "spotify.anchor-budget-read-failed", { error });
    return { nextEligibleAt: null, reason: "daily_budget" };
  }

  return (await isSpotifyCallBudgetAvailable(now.getTime()))
    ? { nextEligibleAt: null, reason: "open" }
    : { nextEligibleAt: null, reason: "shared_meter" };
}

export async function anchorSpotifySearchAllowed(now: Date): Promise<boolean> {
  return (await anchorSpotifySearchGate(now)).reason === "open";
}

export async function anchorSpotifyBreakerAllows(now: Date): Promise<boolean> {
  try {
    const values = await getSettings([
      ...SPOTIFY_ANCHOR_BREAKER_KEYS,
      SPOTIFY_QUOTA_HOLD_UNTIL_KEY,
      SPOTIFY_ANCHOR_DAILY_BUDGET_KEY,
    ]);
    const [breaker, holdUntil, spent, budget, meterAvailable] = await Promise.all([
      getSpotifyAnchorBreakerState(now.getTime(), values),
      readSpotifyQuotaHoldUntil(now.getTime(), values),
      readSpotifyConsumerDailyCallsSpent("anchor", now.getTime()),
      readSpotifyConsumerDailyBudget("anchor", values),
      isSpotifyCallBudgetAvailable(now.getTime()),
    ]);
    return (
      (!breaker.tripped || breaker.reason === SPOTIFY_ANCHOR_BREAKER_REASON_QUOTA) &&
      !holdUntil &&
      spent < budget &&
      meterAvailable
    );
  } catch {
    return false;
  }
}
