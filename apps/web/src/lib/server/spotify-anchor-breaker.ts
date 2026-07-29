// THE SPOTIFY ANCHOR BREAKER — sustained throttling PAUSES the optional anchor search, and nothing else.
//
// ── THE FAILURE REGIME THAT MATTERS ──────────────────────────────────────────────────────────────
// One official Spotify app serves EVERY Spotify-touching path: the mint on a track add, publish, the
// Frontier-playlist refresh, /reach — and, when the operator arms the dark flag, the catalogue's
// anchor SEARCH rungs (./anchor-spotify-search.ts). Only one of those is optional. A sustained anchor
// sweep DID starve that app with 429s (2026-07-18), which is why the rungs ship dark; the two
// governors that survived that day are per-CALL, and neither can see a STORM:
//
//   - `spotifyFetch`'s 429/Retry-After backoff (./spotify.ts) waits out ONE call's throttle in
//     isolation. It has no memory, so a hundred throttled calls look to it like a hundred first ones.
//   - The box sweep's ≥2s pacer holds the anchor rungs under ~60 searches/min. It is open-loop — it
//     paces the same whether Spotify is answering 200s or 429s.
//
// Between them there is no state that says "Spotify has been pushing back for ten minutes, so the
// OPTIONAL work should stop". This module is that state. It is the AUTH-BREAKER half of the Apple
// pattern (./apple-breaker.ts) ported to Spotify's throttling regime, the sibling of the fixed-window
// meter in ./spotify-budget.ts. Together the three read as one family on purpose.
//
// ── WHAT TRIPS IT: A 429 ANYWHERE, DELIBERATELY ──────────────────────────────────────────────────
// The recorder hangs off `spotifyFetch`, the chokepoint EVERY Spotify call passes through — so a 429
// earned by the Frontier refresh trips this breaker exactly as one earned by the anchor sweep does.
// That is the intent, not a leak. The breaker's job is to protect the SHARED app, and the anchor
// search is the only caller on it whose work can wait; when the app is under pressure the optional
// consumer should yield FIRST, whoever is causing the pressure. Recording only the anchor rungs' own
// 429s would blind the breaker to precisely the case it exists for — a user-facing peak the sweep
// should get out of the way of.
//
// ── WHAT IT PAUSES: THE ANCHOR SEARCH, AND ONLY THE ANCHOR SEARCH ────────────────────────────────
// THE LOAD-BEARING SAFETY PROPERTY. The breaker has exactly ONE consumer: the third clause of
// `anchorSpotifySearchAllowed` (./anchor-spotify-search.ts). Nothing else reads it. A mint, a
// publish, a Frontier refresh, a /reach collection and a `/search` from the add box all run
// completely unchanged while it is tripped — `spotifyFetch` RECORDS into the breaker and never
// CONSULTS it. A breaker that could darken a user-facing path would be a bigger outage than the one
// it is guarding against, so the asymmetry is structural: the record side is universal, the read
// side is one line in one gate.
//
// ── THE COUNTER SHAPE: A DECAYING WINDOW, NOT A CONSECUTIVE STREAK ───────────────────────────────
// Apple's breaker counts CONSECUTIVE 401/403s and a success resets the streak, which is right for a
// suspended token (it fails every call). Throttling is not like that: under a real 429 storm most
// calls still succeed, so a consecutive-failures counter would be reset by the next 200 and never
// reach its threshold. So this one counts 429s inside a rolling FAILURE WINDOW and a success resets
// nothing — the window's own expiry is the reset. N throttles inside the window is the honest
// definition of "sustained", and an isolated 429 the per-call backoff already absorbed decays away.
//
// ── DEFAULT-DENY, AND WHY THAT IS AFFORDABLE HERE ────────────────────────────────────────────────
// The dark flag's discipline, inverted: a `settings` read that throws, or a trip stamp that will not
// parse, reads as TRIPPED — anchor search not allowed. Apple's breaker does the opposite ("never
// wedge Apple") because ITS consumers include live paths. Ours has one consumer and it is optional
// work with no deadline, so the cost of failing closed is a paused sweep and the cost of failing
// open is pointing a sweep at an app we cannot confirm is healthy. A corrupt stamp is not a
// permanent wedge either: the next 429 anywhere normalises it into a definite, expiring trip, and
// `reset_spotify_anchor_breaker` clears it instantly.
//
// It rides the same `settings` KV every other kill switch and breaker does (./settings.ts) — never a
// second store — and takes `now` as an injected arg (the apple-breaker precedent) so the cooldown
// and the failure window are deterministic and the tests pin them.

import { logEvent } from "./log";
import { getSetting, setSetting } from "./settings";

// ── Keys ──────────────────────────────────────────────────────────────────────────────────────
//
// THE THREE ADOPTED KEYS. `spotify_anchor_breaker_{reason,tripped_at,failures}` already existed as
// rows in the production `settings` table, written once and then orphaned: nothing in the codebase
// read or wrote them, so they held the same values from 2026-07-18 onward because no code COULD
// change them. They are adopted rather than superseded — the names describe exactly this mechanism,
// a fresh set would leave the old three sitting there looking live, and their stored values are
// already the values this code writes (`reason = "throttled"`, an ISO `tripped_at`, an integer
// `failures`). Adoption makes them true; superseding them would only add a second lie. The stale
// 2026-07-18 `tripped_at` needs no migration: a trip that far past is expired by the cooldown, so
// the breaker reads as CLEAR on the first deploy (pinned by a test using the literal prod values).

/** ISO of when the breaker last TRIPPED, or unset/empty when clear. ADOPTED (see above). */
export const SPOTIFY_ANCHOR_BREAKER_TRIPPED_AT_KEY = "spotify_anchor_breaker_tripped_at";
/** The 429 count inside the live failure window (a non-negative integer string). ADOPTED. */
export const SPOTIFY_ANCHOR_BREAKER_FAILURES_KEY = "spotify_anchor_breaker_failures";
/** Why it tripped — a machine word, `"throttled"` today. ADOPTED (prod already holds that value). */
export const SPOTIFY_ANCHOR_BREAKER_REASON_KEY = "spotify_anchor_breaker_reason";
/**
 * ISO of the most recent recorded 429 — the failure window's decay anchor. THE ONE NEW KEY: the
 * three adopted ones carry a count with no time attached, and a count that never decays would trip
 * on three throttles a month apart. Unset (as in production today) reads as "no live window", so the
 * adopted `failures` value restarts cleanly at 1 on the next 429 rather than inheriting a stale count.
 */
export const SPOTIFY_ANCHOR_BREAKER_LAST_FAILURE_AT_KEY = "spotify_anchor_breaker_last_failure_at";

// ── Policy constants — THE ONE PLACE THE BREAKER IS TUNED ───────────────────────────────────────
//
// Three numbers, all here, all changeable in one edit. They are deliberately conservative in the
// direction of pausing: the anchor backlog is not urgent (the worklist is derived, so a skipped tick
// loses nothing and "run again" is "resume"), while a starved mint is user-facing breakage.

/**
 * N — 429 responses inside the failure window that trip the breaker. Five, because the per-call
 * backoff in `spotifyFetch` already absorbs an isolated throttle without anyone noticing: one or two
 * 429s is Spotify's normal backpressure, not a regime. Five inside ten minutes is a wall.
 */
export const SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES = 5;

/**
 * The rolling window the failures must land inside to count together. Ten minutes: long enough that
 * a genuinely sustained storm accumulates (the box paces the rungs at ≤60 searches/min, so a
 * throttled sweep earns its fifth 429 in well under a minute), short enough that unrelated
 * throttles hours apart never add up into a phantom trip.
 */
export const SPOTIFY_ANCHOR_BREAKER_FAILURE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

/**
 * How long the anchor search stays paused after a trip. One hour, matching the `fluncle-anchor`
 * sweep's `OnUnitActiveSec=1h` cadence: a trip costs the catalogue exactly ONE tick and then the
 * rungs re-arm themselves, so the breaker self-heals with no operator in the loop. If Spotify is
 * still pushing back, the next tick's throttles trip it again — a sawtooth, not a stall.
 */
export const SPOTIFY_ANCHOR_BREAKER_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

/** The only cause today: sustained 429s on the shared app. Written to the reason key on a trip. */
export const SPOTIFY_ANCHOR_BREAKER_REASON_THROTTLED = "throttled";

// ── Pure helpers ───────────────────────────────────────────────────────────────────────────────

/** Parse a non-negative integer KV string, or the fallback (the apple-breaker discipline). */
function parseCount(raw: string | undefined, fallback = 0): number {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) {
    return fallback;
  }

  const parsed = Number(raw.trim());

  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

/** An ISO stamp → epoch ms, or NaN for absent/empty/unparseable. */
function parseStamp(raw: null | string | undefined): number {
  return raw ? Date.parse(raw) : Number.NaN;
}

/**
 * The breaker's verdict from its stored trip stamp. PURE — the whole decision, no database.
 *
 * DEFAULT-DENY on ambiguity: a stamp that is present but unparseable reads as TRIPPED (`corrupt`),
 * not as clear. See the module header for why that is the right default HERE and the opposite of
 * Apple's — the only thing a false trip costs is a paused optional sweep.
 */
export function spotifyAnchorBreakerVerdict(input: { now: number; trippedAt: null | string }): {
  /** True when the stamp exists but cannot be read — tripped by the default-deny rule. */
  corrupt: boolean;
  cooldownRemainingMs: number;
  tripped: boolean;
} {
  if (!input.trippedAt) {
    return { cooldownRemainingMs: 0, corrupt: false, tripped: false };
  }

  const trippedMs = parseStamp(input.trippedAt);

  if (!Number.isFinite(trippedMs)) {
    // A stamp we cannot read is a breaker state we cannot vouch for: deny, and report it as corrupt
    // so the recorder can normalise it into a definite, expiring trip on the next 429.
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

/**
 * What the failure count becomes when a 429 lands right now. PURE. The decaying-window rule: a
 * throttle inside the live window ADVANCES the stored count, one outside it (or with no window
 * recorded at all, as production's orphaned rows have today) restarts the count at 1.
 */
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

// ── The breaker ────────────────────────────────────────────────────────────────────────────────

/** The whole breaker readout — what the operator ops return and observability shows. */
export type SpotifyAnchorBreakerState = {
  cooldownRemainingMs: number;
  /** Why it is tripped (`"throttled"`), or null when clear. */
  reason: null | string;
  /** 429s counted in the live failure window (0 once the window has decayed, or after a trip). */
  throttlesInWindow: number;
  /** True ⇒ the Spotify anchor SEARCH rungs are paused. Nothing else is affected. */
  tripped: boolean;
  /** ISO of the live trip, or null when clear. */
  trippedAt: null | string;
};

/**
 * Read the breaker's durable state. THROWS on a store fault — the honest read, used by the operator
 * ops (which want the error) and by {@link spotifyAnchorSearchBreakerTripped} (which swallows it
 * into a default-deny). A corrupt trip stamp is NOT an error: it reads back as `tripped` with the
 * stored stamp, per the default-deny rule.
 */
export async function getSpotifyAnchorBreakerState(
  now: number = Date.now(),
): Promise<SpotifyAnchorBreakerState> {
  const [trippedAt, failures, reason, lastFailureAt] = await Promise.all([
    getSetting(SPOTIFY_ANCHOR_BREAKER_TRIPPED_AT_KEY),
    getSetting(SPOTIFY_ANCHOR_BREAKER_FAILURES_KEY),
    getSetting(SPOTIFY_ANCHOR_BREAKER_REASON_KEY),
    getSetting(SPOTIFY_ANCHOR_BREAKER_LAST_FAILURE_AT_KEY),
  ]);

  const verdict = spotifyAnchorBreakerVerdict({ now, trippedAt: trippedAt ?? null });
  const lastMs = parseStamp(lastFailureAt);
  const windowLive =
    Number.isFinite(lastMs) && now - lastMs < SPOTIFY_ANCHOR_BREAKER_FAILURE_WINDOW_MS;

  return {
    cooldownRemainingMs: verdict.cooldownRemainingMs,
    reason: verdict.tripped ? reason || null : null,
    throttlesInWindow: windowLive ? parseCount(failures) : 0,
    tripped: verdict.tripped,
    trippedAt: verdict.tripped ? (trippedAt ?? null) : null,
  };
}

/**
 * Is the anchor-search breaker tripped right now? THE ONE READ SIDE — `anchorSpotifySearchAllowed`
 * is its only caller, so this predicate can pause the anchor search and can pause nothing else.
 *
 * DEFAULT-DENY: a `settings` read that throws returns TRUE (tripped ⇒ not allowed). The opposite of
 * the fail-OPEN call meter in ./spotify-budget.ts, and deliberately so — that meter governs every
 * Spotify path including user-facing ones, so failing closed there would be an outage; this governs
 * only optional catalogue work, so failing closed costs one skipped sweep tick.
 */
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

/**
 * Record one observed Spotify 429 — called from `spotifyFetch` for EVERY throttled response, on
 * every path (see the module header on why "anywhere" is the intent).
 *
 * TOTAL BY CONTRACT: it never throws and never returns a value the caller must handle. A breaker
 * that can break the call it is observing is worse than no breaker, and this one sits inside the
 * user-facing mint/publish path, so a `settings` fault here is logged and swallowed. The worst case
 * is a throttle that goes uncounted.
 *
 * Three behaviours worth knowing:
 *   - ALREADY TRIPPED ⇒ a no-op. The anchor search is already paused; letting later 429s re-stamp
 *     would let unrelated pressure extend the pause without bound and the cooldown would never be
 *     reached. Cooldown expiry re-arms, and if the storm is still on, the next N throttles re-trip.
 *   - CORRUPT STAMP ⇒ normalised to `now`. That is the self-heal for the default-deny wedge: an
 *     unreadable stamp becomes a definite trip that expires one cooldown later.
 *   - Otherwise the failure count advances under the decaying-window rule and TRIPS at N, stamping
 *     `tripped_at` + `reason` and zeroing the count so it cannot run away.
 */
export async function recordSpotifyThrottle(now: number = Date.now()): Promise<void> {
  try {
    const [trippedAt, failures, lastFailureAt] = await Promise.all([
      getSetting(SPOTIFY_ANCHOR_BREAKER_TRIPPED_AT_KEY),
      getSetting(SPOTIFY_ANCHOR_BREAKER_FAILURES_KEY),
      getSetting(SPOTIFY_ANCHOR_BREAKER_LAST_FAILURE_AT_KEY),
    ]);

    const verdict = spotifyAnchorBreakerVerdict({ now, trippedAt: trippedAt ?? null });

    if (verdict.corrupt) {
      // Turn an unreadable stamp into a definite, expiring trip (the default-deny self-heal).
      await setSetting(SPOTIFY_ANCHOR_BREAKER_TRIPPED_AT_KEY, new Date(now).toISOString());

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
      await Promise.all([
        setSetting(SPOTIFY_ANCHOR_BREAKER_TRIPPED_AT_KEY, stamp),
        setSetting(SPOTIFY_ANCHOR_BREAKER_REASON_KEY, SPOTIFY_ANCHOR_BREAKER_REASON_THROTTLED),
        setSetting(SPOTIFY_ANCHOR_BREAKER_FAILURES_KEY, "0"),
        setSetting(SPOTIFY_ANCHOR_BREAKER_LAST_FAILURE_AT_KEY, stamp),
      ]);
      // "warn", not "error": the breaker doing its job is expected backpressure, and the anchor
      // sweep's own summary line is where the operator sees the paused ticks.
      logEvent("warn", "spotify.anchor-breaker-tripped", {
        cooldownMs: SPOTIFY_ANCHOR_BREAKER_COOLDOWN_MS,
        reason: SPOTIFY_ANCHOR_BREAKER_REASON_THROTTLED,
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

/**
 * Clear the breaker — the operator's `reset_spotify_anchor_breaker`. Lifts a live (or corrupt) trip,
 * zeroes the failure count, and drops the failure window so the next 429 starts a fresh one.
 */
export async function resetSpotifyAnchorBreaker(): Promise<SpotifyAnchorBreakerState> {
  await Promise.all([
    setSetting(SPOTIFY_ANCHOR_BREAKER_TRIPPED_AT_KEY, ""),
    setSetting(SPOTIFY_ANCHOR_BREAKER_REASON_KEY, ""),
    setSetting(SPOTIFY_ANCHOR_BREAKER_FAILURES_KEY, "0"),
    setSetting(SPOTIFY_ANCHOR_BREAKER_LAST_FAILURE_AT_KEY, ""),
  ]);

  return getSpotifyAnchorBreakerState();
}
