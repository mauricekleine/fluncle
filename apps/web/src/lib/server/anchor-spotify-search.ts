import { logEvent } from "./log";
import {
  getSpotifyAnchorBreakerState,
  getSpotifyAnchorQuotaUntil,
  SPOTIFY_ANCHOR_BREAKER_REASON_QUOTA,
} from "./spotify-anchor-breaker";
import { getSetting, setSetting } from "./settings";
import { isSpotifyCallBudgetAvailable, recordSpotifyCall } from "./spotify-budget";

export const ANCHOR_SPOTIFY_SEARCH_ENABLED_KEY = "anchor_spotify_search_enabled";

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
  | "flag_off"
  | "friday_window"
  | "open"
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
    const breaker = await getSpotifyAnchorBreakerState(now.getTime());
    const validTrip = breaker.trippedAt !== null && !Number.isNaN(Date.parse(breaker.trippedAt));
    if (breaker.tripped && !validTrip) {
      return { nextEligibleAt: null, reason: "breaker_throttle" };
    }
    const quotaUntil = await getSpotifyAnchorQuotaUntil(now.getTime());
    if (breaker.tripped && breaker.reason === SPOTIFY_ANCHOR_BREAKER_REASON_QUOTA) {
      return {
        nextEligibleAt: new Date(
          Math.max(
            now.getTime() + breaker.cooldownRemainingMs,
            quotaUntil ? Date.parse(quotaUntil) : 0,
          ),
        ).toISOString(),
        reason: "breaker_quota",
      };
    }
    if (quotaUntil) {
      return { nextEligibleAt: quotaUntil, reason: "breaker_quota" };
    }
    if (breaker.tripped) {
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

  return (await isSpotifyCallBudgetAvailable(now.getTime()))
    ? { nextEligibleAt: null, reason: "open" }
    : { nextEligibleAt: null, reason: "shared_meter" };
}

export async function anchorSpotifySearchAllowed(now: Date): Promise<boolean> {
  return (await anchorSpotifySearchGate(now)).reason === "open";
}

export async function anchorSpotifyBreakerAllows(now: Date): Promise<boolean> {
  try {
    return !(await getSpotifyAnchorBreakerState(now.getTime())).tripped;
  } catch {
    return false;
  }
}

export async function recordAnchorSpotifyCall(now: Date): Promise<void> {
  try {
    await recordSpotifyCall(now.getTime());
  } catch (error) {
    logEvent("warn", "anchor.call-meter-record-failed", { error });
  }
}
