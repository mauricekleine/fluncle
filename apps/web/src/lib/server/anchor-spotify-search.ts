// THE SPOTIFY SEARCH RUNGS' GATE — the dark flag + the mint-protection window (anchor slice 2).
//
// The resolver waterfall is: FREE ListenBrainz rung → (miss) metered Apify search.
// Slice 2 inserts the FREE Spotify SEARCH rungs between them (lib/server/anchor.ts `resolveAnchorFree`):
//   ListenBrainz → Spotify-ISRC-search → Spotify-fuzzy-search → Apify
// so Apify shrinks to a true last resort — the ~75-85% cost cut.
//
// ── WHY THE SPOTIFY RUNGS SHIP DARK ──────────────────────────────────────────────────────────────
// The Spotify search rungs call the ONE official Spotify app that ALSO serves the user-facing paths:
// the mint on a track add, publish, and the Frontier-playlist refresh. At catalogue scale a sustained
// by-ISRC / fuzzy sweep can earn 429s — which is exactly why catalogue anchoring
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
//      Friday morning remains the peak (the weekly
//      Editions roll over on new-music Friday, and the newsletter follows). So the rungs are gated OFF
//      across a conservative Friday-MORNING window in Amsterdam time — a named constant below, trivial
//      to widen. The low req/min ceiling (enforced by the box sweep's pacer) plus the existing Spotify
//      429/Retry-After backoff (spotify.ts) protect the shared app the rest of the week; this window is
//      the belt-and-suspenders guard over the known peak. A mint always has headroom: the anchor
//      search is a metered trickle that backs off on the first 429, so it yields the shared token to
//      the user-facing paths rather than competing with them.
//
//   3. THE CIRCUIT BREAKER (./spotify-anchor-breaker.ts). The two guards above are a static schedule
//      and a per-call wait; neither can see that Spotify has been pushing back for the last ten
//      minutes. The breaker is that memory: N 429s inside a rolling window on ANY Spotify path trip
//      it, and while it is tripped these rungs are SKIPPED exactly as the dark flag skips them — no
//      `findSpotifyTrackByIsrc`, no `searchTrackCandidates`. It reads DEFAULT-DENY (an unreadable
//      breaker state pauses the rungs), and it pauses NOTHING ELSE: the mint, publish, and the
//      Frontier refresh never consult it. That is what makes the rungs safe to run unattended —
//      "yields on the first 429" stops being a per-call hope and becomes an enforced pause.
//
//   4. THE SHARED CALL METER (./spotify-budget.ts). The breaker answers "has Spotify been pushing
//      back?"; the meter answers "how much of this 30s window has the platform already spent?" —
//      the question that decides whether a background sweep is about to collide with a live mint.
//      The search rungs now CONSULT it (a spent window pauses them, the subordinate-consumer rule)
//      and every anchor-path Spotify request RECORDS into it, including the ListenBrainz rung's
//      by-id read, which otherwise draws on the shared app completely unseen.
//
// ── AND THE RUNG THAT IS NOT A SEARCH ────────────────────────────────────────────────────────────
// The ListenBrainz rung's ONE by-id metadata read (`GET /v1/tracks/{id}`, lib/server/anchor.ts) is a
// Spotify call this module did not govern — it is not a search, so none of the three
// guards above saw it. Through a throttle window that meant 100% of free candidates died on that read
// and their rows were re-bought from Apify. `anchorSpotifyBreakerAllows` is its gate now: the BREAKER
// only, deliberately not the meter — see that function's own note for why pausing a free by-id read
// on a busy window would spend money to save a call.

import { logEvent } from "./log";
import { spotifyAnchorSearchBreakerTripped } from "./spotify-anchor-breaker";
import { getSetting, setSetting } from "./settings";
import { isSpotifyCallBudgetAvailable, recordSpotifyCall } from "./spotify-budget";

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
 * Friday-morning refresh window AND the throttle breaker is not tripped AND the shared call meter
 * still has budget in its window. When this is false, `resolveAnchorFree` issues ZERO Spotify search
 * calls — the load-bearing safety property, checked before either rung. `now` is injected so the
 * decision is deterministic in tests (the caller passes the real clock in production).
 *
 * ORDER IS DELIBERATE: the pure Friday window first (free), then the dark flag, then the breaker,
 * then the shared meter. The flag is OFF by default, so a flag-OFF deployment pays EXACTLY the reads
 * it paid before either of those two existed — their `settings` reads are spent only once the rungs
 * are actually armed, which is also the only state in which they can matter.
 *
 * All four are ANDed, so each addition can only ever subtract permission. Callers are unchanged:
 * `anchor.ts` already treats a false here as "skip the Spotify rungs this call", and its stamp rule
 * reads the dark flag separately — so a breaker- or budget-closed gate correctly leaves the row
 * un-stamped and it keeps its turn for a later tick.
 *
 * THE METER CLAUSE IS THE SUBORDINATION (`./spotify-budget.ts`). The search rungs draw on the ONE
 * official app the mint, publish, and the Frontier refresh draw on, and they are the only consumer
 * on it whose work has no deadline — so when the shared 30s window is spent, THIS is what pauses. It
 * is FAIL-OPEN inside the meter (a KV fault reads as budget available), which is right: the breaker
 * beside it is the fail-CLOSED half, and doubling the deny would pause the sweep on a store hiccup.
 */
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

/**
 * Is the shared-app throttle breaker CLEAR right now — the one gate the anchor waterfall's other
 * Spotify caller consults. The ListenBrainz rung's single by-id metadata read
 * (`GET /v1/tracks/{id}`) hits the same official app the search rungs do, and until this existed it
 * consulted nothing: through Spotify's daily throttle windows every LB candidate died on that read
 * (`summary.failed == summary.lbMetadataFailed` across whole ticks) and the row fell to the PAID
 * Apify rung with a free candidate in hand. Now it yields instead — the breaker is durable state, so
 * one tripped read pauses the rung for the rest of the tick and the rows fall through UNSTAMPED,
 * exactly as a miss does today.
 *
 * IT IS THE BREAKER ONLY, NEVER THE CALL METER, and the asymmetry with
 * {@link anchorSpotifySearchAllowed} above is the whole point. A skipped SEARCH costs nothing (the
 * row falls to Apify exactly as a search miss would), so that rung can afford to yield to the shared
 * 30s window. A skipped BY-ID READ throws away a free anchor and buys a billed Apify search in its
 * place — pausing it on a busy window would spend money to save a call, which is the leak this gate
 * exists to close. So the by-id read yields only when the breaker says the call would be pushed back
 * anyway, and otherwise runs and RECORDS itself into the shared meter
 * ({@link recordAnchorSpotifyCall}) so the paths that DO pause see it.
 */
export async function anchorSpotifyBreakerAllows(now: Date): Promise<boolean> {
  return !(await spotifyAnchorSearchBreakerTripped(now.getTime()));
}

/**
 * Record ONE anchor-path Spotify call into the shared fixed-window meter (`./spotify-budget.ts`) —
 * the `fetchArtistImages` discipline: TOTAL by contract, so a `settings` fault is logged and
 * swallowed rather than failing the call it is observing. Every Spotify request the anchor waterfall
 * makes goes through here (the ListenBrainz rung's by-id read, the exact-ISRC search, the fuzzy
 * search), so the meter's shared view counts the catalogue's draw instead of under-reporting it — and
 * the user-facing paths that consult it get an honest number to pace against.
 */
export async function recordAnchorSpotifyCall(now: Date): Promise<void> {
  try {
    await recordSpotifyCall(now.getTime());
  } catch (error) {
    logEvent("warn", "anchor.call-meter-record-failed", { error });
  }
}
