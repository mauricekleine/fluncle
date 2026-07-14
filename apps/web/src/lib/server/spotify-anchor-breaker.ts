// THE SPOTIFY ANCHOR BREAKER — a persistent, self-healing circuit breaker for the crawler's
// by-ISRC Spotify anchor fill (`fillSpotifyAnchors` in crawl.ts, docs/catalogue-crawler.md).
//
// ── THE REGIME THAT MATTERS ──────────────────────────────────────────────────────────────────
// The catalogue crawler demotes Spotify to a per-track ISRC lookup that backfills the
// `spotify_uri`/`spotify_url` anchor onto rows the walk already wrote. That fill is bounded
// (20/tick) and its queue is DERIVED (`isrc is not null and spotify_uri is null`), so it forgets
// nothing — an anchor a tick misses is picked up by the next.
//
// The failure that darkens it is not a per-row miss; it is a SUSTAINED "Spotify won't answer"
// regime: either a 429 the app has earned app-wide (its client budget is shared with publish,
// the reach collector, and search), or a lost/expired `spotify_auth` grant surfacing as
// `spotify_not_authenticated` on every call. Under either, EVERY tick fires an anchor lookup,
// gets nothing, and reports `anchorsFilled: 0` — and before this breaker existed the crawl pass
// discarded the throttled flag, so 0-because-throttled, 0-because-unauthorized, and 0-because-
// drained were the SAME observable answer. 5,446 rows can sit stalled for half a day with no
// signal an operator can act on. (Measured 2026-07-14: a 12h journal summed `anchorsFilled: 0`
// across 59 ticks while `catalogue status` reported `anchorsPending: 5446`.)
//
// So this mirrors `apple-breaker.ts` (the sibling Apple catalogue backfill's blessed pattern):
// a PERSISTENT breaker on the `settings` KV so it survives a Worker recycle. K consecutive
// failing PASSES (a 429 or an auth failure) TRIP it; while tripped, `fillSpotifyAnchors`
// short-circuits — no Spotify call at all — until a cooldown elapses. A success RESETS the
// streak and lifts any trip. The tripped state is durable and INSPECTABLE — it surfaces on
// `get_crawl_status` / `fluncle admin catalogue status`, so `anchorsFilled: 0` is never mute.
//
// Unlike the Apple breaker, a 429 DOES trip this one: the anchor fill's ONLY cross-tick backoff
// is this breaker (within a pass it stops on the first 429; across passes there was nothing), so
// a persistent throttle must pause the fill rather than be re-poked every 12 minutes.
//
// It lives on the same `settings` KV every other kill switch rides — never a second store.

import { getSetting, setSetting } from "./settings";

// ── Keys ──────────────────────────────────────────────────────────────────────────────────────

/** ISO of when the breaker last TRIPPED, or unset when it has never tripped / was reset. */
export const SPOTIFY_ANCHOR_BREAKER_TRIPPED_AT_KEY = "spotify_anchor_breaker_tripped_at";
/** The consecutive-failure streak (a non-negative integer string). Reset to 0 on any success. */
export const SPOTIFY_ANCHOR_BREAKER_FAILURES_KEY = "spotify_anchor_breaker_failures";
/** The last failing reason (`throttled` | `unauthorized`), so status can say WHY it is paused. */
export const SPOTIFY_ANCHOR_BREAKER_REASON_KEY = "spotify_anchor_breaker_reason";

// ── Policy constants ────────────────────────────────────────────────────────────────────────

/** K — consecutive failing passes that trip the breaker. Small: a sustained regime is uniform. */
export const SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES = 3;

/**
 * How long the breaker stays tripped before the fill may try Spotify again. Long enough that a
 * genuine ban or a dead grant is not re-poked every 12-minute tick, short enough that a transient
 * throttle self-heals without an operator — and the moment Spotify answers, the streak clears and
 * the derived queue drains 20/tick as designed.
 */
export const SPOTIFY_ANCHOR_BREAKER_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

// ── The failing reason a pass reports ──────────────────────────────────────────────────────────

/**
 * Why a fill pass could not write anchors, from the breaker's point of view:
 *   - `throttled`    — a 429 (Spotify is rate-limiting the app): advances the streak.
 *   - `unauthorized` — a 401/`spotify_not_authenticated` (the grant is gone): advances the streak.
 *   - `ok`           — Spotify answered (whether or not anything matched): resets the streak AND
 *                      lifts any trip.
 */
export type SpotifyAnchorOutcome = "ok" | "throttled" | "unauthorized";

/** A stored failing reason, or `null` when the breaker is healthy. */
export type SpotifyAnchorReason = "throttled" | "unauthorized" | null;

// ── Pure helpers ───────────────────────────────────────────────────────────────────────────────

/** Parse a non-negative integer KV string, or the fallback (the capture-budget discipline). */
function parseCount(raw: string | undefined, fallback = 0): number {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) {
    return fallback;
  }

  const parsed = Number(raw.trim());

  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

/** The breaker's verdict from its stored trip time. PURE — the whole decision, no database. */
export function spotifyAnchorBreakerVerdict(input: { now: number; trippedAt: string | null }): {
  cooldownRemainingMs: number;
  tripped: boolean;
} {
  if (!input.trippedAt) {
    return { cooldownRemainingMs: 0, tripped: false };
  }

  const trippedMs = Date.parse(input.trippedAt);

  if (!Number.isFinite(trippedMs)) {
    // An unparseable stamp must not wedge the anchor forever — treat it as not tripped.
    return { cooldownRemainingMs: 0, tripped: false };
  }

  const remaining = SPOTIFY_ANCHOR_BREAKER_COOLDOWN_MS - (input.now - trippedMs);

  return remaining > 0
    ? { cooldownRemainingMs: remaining, tripped: true }
    : { cooldownRemainingMs: 0, tripped: false };
}

// ── The breaker ────────────────────────────────────────────────────────────────────────────────

/** The whole breaker readout — what `get_crawl_status` surfaces and observability shows. */
export type SpotifyAnchorBreakerState = {
  consecutiveFailures: number;
  cooldownRemainingMs: number;
  reason: SpotifyAnchorReason;
  tripped: boolean;
};

/** Read the breaker's state. */
export async function getSpotifyAnchorBreakerState(
  now: number = Date.now(),
): Promise<SpotifyAnchorBreakerState> {
  const [trippedAt, failures, reason] = await Promise.all([
    getSetting(SPOTIFY_ANCHOR_BREAKER_TRIPPED_AT_KEY),
    getSetting(SPOTIFY_ANCHOR_BREAKER_FAILURES_KEY),
    getSetting(SPOTIFY_ANCHOR_BREAKER_REASON_KEY),
  ]);

  const verdict = spotifyAnchorBreakerVerdict({ now, trippedAt: trippedAt ?? null });
  const storedReason: SpotifyAnchorReason =
    reason === "throttled" || reason === "unauthorized" ? reason : null;

  return {
    consecutiveFailures: parseCount(failures),
    cooldownRemainingMs: verdict.cooldownRemainingMs,
    // A live trip keeps its reason; once healed, there is nothing to explain.
    reason: verdict.tripped || parseCount(failures) > 0 ? storedReason : null,
    tripped: verdict.tripped,
  };
}

/** May the anchor fill call Spotify right now? False while tripped and inside its cooldown. */
export async function areSpotifyAnchorCallsAllowed(now: number = Date.now()): Promise<boolean> {
  return !(await getSpotifyAnchorBreakerState(now)).tripped;
}

/**
 * Fold one fill pass's outcome into the durable breaker state. On the K-th consecutive failing
 * pass the breaker TRIPS (stamps `trippedAt`, resets the streak so the count does not run away,
 * keeps the reason). A success clears the streak, the reason, and any live trip.
 */
export async function recordSpotifyAnchorOutcome(
  outcome: SpotifyAnchorOutcome,
  now: number = Date.now(),
): Promise<void> {
  if (outcome === "ok") {
    await Promise.all([
      setSetting(SPOTIFY_ANCHOR_BREAKER_FAILURES_KEY, "0"),
      setSetting(SPOTIFY_ANCHOR_BREAKER_TRIPPED_AT_KEY, ""),
      setSetting(SPOTIFY_ANCHOR_BREAKER_REASON_KEY, ""),
    ]);

    return;
  }

  // A failing pass — advance the streak, remember why; trip on the K-th.
  const failures = parseCount(await getSetting(SPOTIFY_ANCHOR_BREAKER_FAILURES_KEY)) + 1;

  if (failures >= SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES) {
    await Promise.all([
      setSetting(SPOTIFY_ANCHOR_BREAKER_TRIPPED_AT_KEY, new Date(now).toISOString()),
      setSetting(SPOTIFY_ANCHOR_BREAKER_FAILURES_KEY, "0"),
      setSetting(SPOTIFY_ANCHOR_BREAKER_REASON_KEY, outcome),
    ]);

    return;
  }

  await Promise.all([
    setSetting(SPOTIFY_ANCHOR_BREAKER_FAILURES_KEY, String(failures)),
    setSetting(SPOTIFY_ANCHOR_BREAKER_REASON_KEY, outcome),
  ]);
}

/** Clear the breaker early — lifts a trip and zeroes the streak. The cooldown self-heals too. */
export async function resetSpotifyAnchorBreaker(): Promise<SpotifyAnchorBreakerState> {
  await Promise.all([
    setSetting(SPOTIFY_ANCHOR_BREAKER_TRIPPED_AT_KEY, ""),
    setSetting(SPOTIFY_ANCHOR_BREAKER_FAILURES_KEY, "0"),
    setSetting(SPOTIFY_ANCHOR_BREAKER_REASON_KEY, ""),
  ]);

  return getSpotifyAnchorBreakerState();
}
