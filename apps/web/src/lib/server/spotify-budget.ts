// THE SPOTIFY SHARED-APP CALL METER (the Frontier-pacing keystone).
//
// ── THE FAILURE REGIME THAT MATTERS ──────────────────────────────────────────────────────────
// Spotify rate-limits per-APP over a rolling ~30s window, and every subsystem shares the ONE app:
// the new-user playlist mint, the Frontier refresh, publish, /reach, search, the crawler's anchor
// sweep (the D8 tap) — all draw on the same budget with NO cross-path coordination. Today the only
// governor is `spotifyFetch`'s per-call 429 backoff (./spotify.ts): each caller waits out its own
// `Retry-After` in isolation. That is a backstop, not a plan — a bulk sweep can spend the whole
// window a millisecond before a user's mint arrives, and the mint hard-fails a 429 in the user's
// face. This meter is the missing shared view: a single fixed-window counter every Spotify caller
// RECORDS into and CONSULTS before a call, so a background drain leaves headroom for the live
// user-facing paths instead of colliding with them blind.
//
// It is the fixed-window CALL-METER half of the Apple pattern (./apple-breaker.ts), ported for
// Spotify. Apple's module also carries an AUTH circuit-breaker (a suspended developer token that
// must not be retried harder); Spotify has no such regime — its failure is 429 throttling, not
// token suspension — so only the meter comes across. The two read as siblings on purpose.
//
// It is a FIXED-WINDOW counter (a single KV bucket that resets when its window elapses), not a
// per-call timestamp log: the `settings` KV holds flags, not a table, and a fixed window is the
// honest shape a single row can carry. It is a SOFT governor (a caller pauses a tick when the
// window is spent), not a hard guarantee — the per-call 429 backoff in `spotifyFetch` remains the
// real safety net beneath it.
//
// It lives on the same `settings` KV every other kill switch and budget rides — never a second
// store — and takes `now` as an injected arg (the apple-breaker precedent) so windows are
// deterministic and the tests pin them.
//
// SHIPS INERT: nothing consults this yet. Wiring it into the mint + the Friday refresh + the tap is
// the follow-up slice. This slice is the isolated, immediately-mergeable primitive.

import { getSetting, setSetting } from "./settings";

// ── Keys ──────────────────────────────────────────────────────────────────────────────────────

/** ISO of the current call-meter window's start. */
export const SPOTIFY_CALLS_WINDOW_START_KEY = "spotify_calls_window_start";
/** The call count inside the current window (a non-negative integer string). */
export const SPOTIFY_CALLS_WINDOW_COUNT_KEY = "spotify_calls_window_count";

// ── Policy constants ────────────────────────────────────────────────────────────────────────
//
// DELIBERATELY CONSERVATIVE and TUNABLE. Spotify does not publish the exact sustainable rate for
// our tier, and we have not yet measured it from the `spotify.rate-limited-retry` warn-log volume
// (that measurement is a follow-up). The window is Spotify's own ~30s rolling window; the max is a
// defensible LOW number that leaves real headroom below wherever the true ceiling sits. Erring
// tight is safe here: the per-call 429 backoff in `spotifyFetch` is the backstop, so an
// over-conservative meter only means a background sweep pauses a tick sooner than it strictly must
// — it never fails a user. Raise the max deliberately once the warn-log measurement lands.

/** The call meter's window — Spotify's per-app rolling window is ~30s. */
export const SPOTIFY_CALL_WINDOW_MS = 30 * 1000; // 30 seconds

/**
 * The soft ceiling of Spotify calls per window every caller respects. 24 per 30s ≈ 0.8 req/s
 * sustained across ALL paths combined — a conservative fraction of what a healthy app can hold,
 * chosen to leave the live user-facing paths (a mint, a refresh) clear room under a background
 * sweep. Not a hard cap — a caller that ignores the meter is not blocked, it just is not paced.
 * Tune UP once the real sustainable rate is measured from the retry warn-log.
 */
export const SPOTIFY_CALL_WINDOW_MAX = 24;

// ── Pure helpers ───────────────────────────────────────────────────────────────────────────────

/** Parse a non-negative integer KV string, or the fallback (the apple-breaker discipline). */
function parseCount(raw: string | undefined, fallback = 0): number {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) {
    return fallback;
  }

  const parsed = Number(raw.trim());

  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

/**
 * The whole window decision, PURE — no database. Given the stored window start + count and `now`,
 * resolve the LIVE view: the effective count (0 once the window has elapsed or never opened), and
 * how long until the live window resets (0 when there is no live window, so budget is already free).
 * This is what the meter's KV reads feed, and what the tests hit directly.
 */
export function spotifyCallWindow(input: { count: number; now: number; startMs: number }): {
  /** The count that applies to `now` — 0 once the window has rolled over. */
  count: number;
  /** True while `now` still falls inside the window `startMs` opened. */
  live: boolean;
  /** Ms until the live window elapses (0 when not live — budget frees immediately). */
  msUntilReset: number;
} {
  const { count, now, startMs } = input;

  if (!Number.isFinite(startMs) || now - startMs >= SPOTIFY_CALL_WINDOW_MS) {
    // The window has elapsed (or never started) — nothing counted in the live window.
    return { count: 0, live: false, msUntilReset: 0 };
  }

  return { count, live: true, msUntilReset: SPOTIFY_CALL_WINDOW_MS - (now - startMs) };
}

// ── The call meter ───────────────────────────────────────────────────────────────────────────

/** Read the current window's live view (count + reset hint), honouring the rollover. One KV read. */
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

/** Read the current window's call count, honouring the window rollover. */
export async function readSpotifyCallCount(now: number = Date.now()): Promise<number> {
  return (await readSpotifyCallWindow(now)).count;
}

/**
 * May a Spotify-touching path make a call right now — is there budget in the current window?
 * Every caller consults this BEFORE a call. A spent window means "pause this tick" (the next
 * tick's window is fresh), not "fail".
 *
 * FAIL-OPEN: a KV read that throws returns TRUE. The meter must never HARD-BLOCK Spotify on a KV
 * hiccup — the per-call 429 backoff in `spotifyFetch` is the safety net, so on a store fault we
 * fall through to it rather than darkening every Spotify path.
 */
export async function areSpotifyCallsAllowed(now: number = Date.now()): Promise<boolean> {
  try {
    return (await readSpotifyCallWindow(now)).count < SPOTIFY_CALL_WINDOW_MAX;
  } catch {
    return true;
  }
}

/**
 * The pre-batch alias of {@link areSpotifyCallsAllowed} — the sibling of Apple's
 * `isAppleCallBudgetAvailable`. Same fail-open budget check, named for the caller that consults it
 * before draining a batch. Kept parallel so the two meters read as siblings.
 */
export async function isSpotifyCallBudgetAvailable(now: number = Date.now()): Promise<boolean> {
  return areSpotifyCallsAllowed(now);
}

/**
 * Ms until the current window's budget frees up — a retry hint for a deferred caller that found the
 * budget spent. 0 when budget is available now (window fresh or not full). FAIL-OPEN: a KV throw
 * returns 0 (retry now; the 429 backoff covers a real throttle).
 */
export async function spotifyBudgetResetMs(now: number = Date.now()): Promise<number> {
  try {
    const { count, msUntilReset } = await readSpotifyCallWindow(now);

    return count < SPOTIFY_CALL_WINDOW_MAX ? 0 : msUntilReset;
  } catch {
    return 0;
  }
}

/** Record one Spotify call into the shared meter, rolling the window over when it has elapsed. */
export async function recordSpotifyCall(now: number = Date.now()): Promise<void> {
  const [start, count] = await Promise.all([
    getSetting(SPOTIFY_CALLS_WINDOW_START_KEY),
    getSetting(SPOTIFY_CALLS_WINDOW_COUNT_KEY),
  ]);

  const startMs = start ? Date.parse(start) : Number.NaN;

  if (!Number.isFinite(startMs) || now - startMs >= SPOTIFY_CALL_WINDOW_MS) {
    // Open a fresh window at this call.
    await Promise.all([
      setSetting(SPOTIFY_CALLS_WINDOW_START_KEY, new Date(now).toISOString()),
      setSetting(SPOTIFY_CALLS_WINDOW_COUNT_KEY, "1"),
    ]);

    return;
  }

  await setSetting(SPOTIFY_CALLS_WINDOW_COUNT_KEY, String(parseCount(count) + 1));
}
