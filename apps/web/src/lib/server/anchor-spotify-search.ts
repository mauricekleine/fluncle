// THE SPOTIFY SEARCH RUNGS' GATE — the dark flag + the mint-protection window (anchor slice 2).
//
// Slice 1 shipped the resolver waterfall as: FREE ListenBrainz rung → (miss) metered Apify search.
// Slice 2 inserts the FREE Spotify SEARCH rungs between them (lib/server/anchor.ts `resolveAnchorFree`):
//   ListenBrainz → Spotify-ISRC-search → Spotify-fuzzy-search → Apify
// so Apify shrinks to a true last resort — the ~75-85% cost cut.
//
// ── WHY THE SPOTIFY RUNGS SHIP DARK ──────────────────────────────────────────────────────────────
// The Spotify search rungs call the ONE official Spotify app that ALSO serves the user-facing paths:
// the mint on a track add, publish, and the Frontier-playlist refresh. At catalogue scale a sustained
// by-ISRC / fuzzy sweep DID earn 429s (measured 2026-07-18) — which is exactly why catalogue anchoring
// left Spotify for the box's Apify sweep in the first place. A STARVED FRIDAY MINT is user-facing
// breakage, so re-introducing Spotify search here is the highest-stakes change in the slice, and it
// carries two hard guardrails:
//
//   1. THE DARK FLAG (`anchor_spotify_search_enabled`, DEFAULT FALSE). When it is not the exact
//      string "true", the Spotify search rungs are SKIPPED ENTIRELY — not one `findSpotifyTrackByIsrc`
//      or `searchTrackCandidates` call is issued. This is the load-bearing safety property: OFF ⇒ zero
//      Spotify search requests. It rides the same `settings` KV every other kill switch does
//      (./settings.ts) — never a second flag mechanism — and reads default-OFF like the clip drip's
//      switch (only the literal "true" enables it; an unset row, an empty DB, or any unrecognised value
//      all read as OFF, so the feature ships dark and STAYS dark until an operator deliberately writes
//      "true").
//
//   2. THE FRIDAY-FRONTIER-REFRESH WINDOW. Even with the flag on, the Spotify rungs SKIP during the
//      week's heaviest user-facing Spotify window so anchor search can never contend with a mint. The
//      Frontier refresh is now a paced ~15-min drain (docs/agents/hermes/frontier-refresh-timer), but
//      it was historically a Friday-07:00 BURST and Friday morning remains the peak (the weekly
//      Editions roll over on new-music Friday, and the newsletter follows). So the rungs are gated OFF
//      across a conservative Friday-MORNING window in Amsterdam time — a named constant below, trivial
//      to widen. The low req/min ceiling (enforced by the box sweep's pacer) plus the existing Spotify
//      429/Retry-After backoff (spotify.ts) protect the shared app the rest of the week; this window is
//      the belt-and-suspenders guard over the known peak. A mint always has headroom: the anchor
//      search is a metered trickle that backs off on the first 429, so it yields the shared token to
//      the user-facing paths rather than competing with them.

import { getSetting, setSetting } from "./settings";

/** The dark flag on the shared `settings` KV. DEFAULT FALSE — only the literal "true" enables it. */
export const ANCHOR_SPOTIFY_SEARCH_ENABLED_KEY = "anchor_spotify_search_enabled";

/**
 * Whether the Spotify SEARCH rungs of the anchor waterfall are enabled — THE DARK FLAG.
 *
 * DEFAULT-DENY, the clip-drip switch's shape: ONLY the explicit string "true" enables the rungs. An
 * unset key, an empty database, a fresh preview, or any value nobody recognises all read as OFF. This
 * is the property that lets the feature ship dark and stay honest — a Spotify search request against
 * the shared official app happens only because an operator deliberately wrote "true" into this row,
 * and anything that loses that row falls back to SKIPPING the rungs rather than to hammering Spotify.
 */
export async function isAnchorSpotifySearchEnabled(): Promise<boolean> {
  return (await getSetting(ANCHOR_SPOTIFY_SEARCH_ENABLED_KEY)) === "true";
}

/** Flip the dark flag (operator). Writing anything but `true` leaves the rungs SKIPPED. */
export async function setAnchorSpotifySearchEnabled(enabled: boolean): Promise<void> {
  await setSetting(ANCHOR_SPOTIFY_SEARCH_ENABLED_KEY, enabled ? "true" : "false");
}

// ── THE FRIDAY-FRONTIER-REFRESH WINDOW ─────────────────────────────────────────────────────────────

/** The window's timezone — the operator's local wall-clock, DST-correct via `Intl`. */
export const FRONTIER_REFRESH_GATE_TIMEZONE = "Europe/Amsterdam";

/** The gated weekday (`Intl` `en-US` `weekday: "short"` spelling). */
export const FRONTIER_REFRESH_GATE_WEEKDAY = "Fri";

/** Window start hour, inclusive (local time). */
export const FRONTIER_REFRESH_GATE_START_HOUR = 6;

/** Window end hour, EXCLUSIVE (local time) — Friday 06:00–09:00 Amsterdam brackets the peak refresh. */
export const FRONTIER_REFRESH_GATE_END_HOUR = 9;

/**
 * Whether `now` falls inside the conservative Friday-morning Frontier-refresh window — the belt-and-
 * suspenders guard that keeps the Spotify anchor rungs off the shared official app during the week's
 * heaviest user-facing Spotify window (see the module header). Pure + timezone-correct: it reads the
 * weekday + hour in Amsterdam time (DST handled by `Intl`), so it needs no ambient state and is
 * trivially unit-tested against fixed `Date`s.
 */
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

/**
 * Whether the Spotify search rungs may run RIGHT NOW: the dark flag is on AND `now` is outside the
 * Friday-morning refresh window. When this is false, `resolveAnchorFree` issues ZERO Spotify search
 * calls — the load-bearing safety property, checked before either rung. `now` is injected so the
 * decision is deterministic in tests (the caller passes the real clock in production).
 */
export async function anchorSpotifySearchAllowed(now: Date): Promise<boolean> {
  if (isWithinFrontierRefreshWindow(now)) {
    return false;
  }

  return isAnchorSpotifySearchEnabled();
}
