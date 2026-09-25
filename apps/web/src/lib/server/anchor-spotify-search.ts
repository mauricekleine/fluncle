import { logEvent } from "./log";
import { spotifyAnchorSearchBreakerTripped } from "./spotify-anchor-breaker";
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

export async function anchorSpotifySearchAllowed(now: Date): Promise<boolean> {
  if (isWithinFrontierRefreshWindow(now)) {
    return false;
  }

  if (!(await isAnchorSpotifySearchEnabled())) {
    return false;
  }

  if (!(await anchorSpotifyBreakerAllows(now))) {
    return false;
  }

  return isSpotifyCallBudgetAvailable(now.getTime());
}

export async function anchorSpotifyBreakerAllows(now: Date): Promise<boolean> {
  return !(await spotifyAnchorSearchBreakerTripped(now.getTime()));
}

export async function recordAnchorSpotifyCall(now: Date): Promise<void> {
  try {
    await recordSpotifyCall(now.getTime());
  } catch (error) {
    logEvent("warn", "anchor.call-meter-record-failed", { error });
  }
}
