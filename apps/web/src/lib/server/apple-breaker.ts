// THE APPLE FAILURE-REGIME BREAKER + CALL METER (RFC musickit-second-authority, Cross-cutting).
//
// ── THE FAILURE REGIME THAT MATTERS ──────────────────────────────────────────────────────────
// The Apple Music client backs off on a 429 (rate limit) already. The regime it does NOT handle
// is the one that actually darkens Fluncle: a developer-token SUSPENSION surfaces as a 401/403,
// and the shipped client's response to that is to CLEAR the cached token and re-mint — i.e. to
// retry HARDER. One undocumented budget is shared by every Apple-touching path (the two sweeps,
// and later U4's live preview rung + U5's editorial fuel), and the U0 oracle is a designed single
// point of failure: one bad token fails FIVE surfaces at once. A hard retry loop against a
// suspended token is exactly how you turn a transient suspension into a permanent one.
//
// So this is a PERSISTENT breaker on the `settings` KV (the `capture-budget.ts` / `label-images.ts`
// circuit-breaker precedent, made durable so it survives a Worker recycle): K consecutive 401/403
// responses TRIP it, and while tripped every Apple-touching path short-circuits — no call at all —
// until a cooldown elapses or the operator resets it. A 429 does not trip it (that is the other
// regime, handled by the sweeps' own rate backoff); a success RESETS the streak.
//
// ── THE CALL METER ───────────────────────────────────────────────────────────────────────────
// A shared rolling-window counter, also on the KV, that every Apple caller RECORDS into and the
// sweeps CONSULT before each batch — so U1's bulk drain cannot invisibly collide with U4/U5's
// live user-facing calls against the one shared budget. It is a FIXED-WINDOW counter (a single
// KV bucket that resets when its window elapses), not a per-call timestamp log: the KV holds
// flags, not a table, and a fixed window is the honest shape a single row can carry. It is a
// soft governor (the sweep pauses a tick when the window is spent), not a hard guarantee.
//
// Both live on the same `settings` KV every other kill switch rides — never a second store.

import { getSetting, setSetting } from "./settings";

// ── Keys ──────────────────────────────────────────────────────────────────────────────────────

/** ISO of when the breaker last TRIPPED, or unset when it has never tripped / was reset. */
export const APPLE_BREAKER_TRIPPED_AT_KEY = "apple_auth_breaker_tripped_at";
/** The consecutive-401/403 streak (a non-negative integer string). Reset to 0 on any success. */
export const APPLE_BREAKER_FAILURES_KEY = "apple_auth_breaker_failures";
/** ISO of the current call-meter window's start. */
export const APPLE_CALLS_WINDOW_START_KEY = "apple_calls_window_start";
/** The call count inside the current window (a non-negative integer string). */
export const APPLE_CALLS_WINDOW_COUNT_KEY = "apple_calls_window_count";

// ── Policy constants ────────────────────────────────────────────────────────────────────────

/** K — consecutive 401/403 responses that trip the breaker. Small: a suspension fans out fast. */
export const APPLE_BREAKER_MAX_AUTH_FAILURES = 3;

/**
 * How long the breaker stays tripped before a path may try Apple again. Long enough that a
 * genuine suspension is not hammered, short enough that a transient glitch self-heals without an
 * operator. The operator reset op (`reset_apple_breaker`) clears it early.
 */
export const APPLE_BREAKER_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

/** The call meter's window. */
export const APPLE_CALL_WINDOW_MS = 60 * 1000; // 1 minute

/**
 * The soft ceiling of Apple calls per window the sweeps respect. Apple's guidance is ~20 req/min;
 * this sits just under it, shared across every caller so the sweeps leave headroom for the live
 * rungs. Not a hard cap — a caller that ignores the meter is not blocked, it just is not paced.
 */
export const APPLE_CALL_WINDOW_MAX = 18;

// ── The auth outcome a caller reports ──────────────────────────────────────────────────────────

/**
 * What one Apple call's outcome was, from the breaker's point of view:
 *   - `auth_failure` — a 401/403 (a bad/suspended developer token): increments the streak.
 *   - `ok`           — a 2xx (or an honest no-match): resets the streak AND clears any trip.
 *   - `other`        — a 429, a network throw, any non-auth non-2xx: leaves the streak unchanged
 *                      (a 429 is the OTHER regime; it must neither trip this breaker nor reset a
 *                      real auth streak that a transient throttle interrupted).
 */
export type AppleAuthOutcome = "auth_failure" | "ok" | "other";

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
export function appleBreakerVerdict(input: { now: number; trippedAt: string | null }): {
  cooldownRemainingMs: number;
  tripped: boolean;
} {
  if (!input.trippedAt) {
    return { cooldownRemainingMs: 0, tripped: false };
  }

  const trippedMs = Date.parse(input.trippedAt);

  if (!Number.isFinite(trippedMs)) {
    // An unparseable stamp must not wedge Apple forever — treat it as not tripped.
    return { cooldownRemainingMs: 0, tripped: false };
  }

  const remaining = APPLE_BREAKER_COOLDOWN_MS - (input.now - trippedMs);

  return remaining > 0
    ? { cooldownRemainingMs: remaining, tripped: true }
    : { cooldownRemainingMs: 0, tripped: false };
}

// ── The breaker ────────────────────────────────────────────────────────────────────────────────

/** The whole breaker readout — what the reset op returns and observability shows. */
export type AppleBreakerState = {
  consecutiveAuthFailures: number;
  cooldownRemainingMs: number;
  tripped: boolean;
  trippedAt: string | null;
};

/** Read the breaker's state. */
export async function getAppleBreakerState(now: number = Date.now()): Promise<AppleBreakerState> {
  const [trippedAt, failures] = await Promise.all([
    getSetting(APPLE_BREAKER_TRIPPED_AT_KEY),
    getSetting(APPLE_BREAKER_FAILURES_KEY),
  ]);

  const verdict = appleBreakerVerdict({ now, trippedAt: trippedAt ?? null });

  return {
    consecutiveAuthFailures: parseCount(failures),
    cooldownRemainingMs: verdict.cooldownRemainingMs,
    tripped: verdict.tripped,
    trippedAt: verdict.tripped ? (trippedAt ?? null) : null,
  };
}

/**
 * May an Apple-touching path make a call right now? False while the breaker is tripped and inside
 * its cooldown. Every Apple caller (the sweeps here, U4/U5 later) consults this BEFORE calling.
 */
export async function areAppleCallsAllowed(now: number = Date.now()): Promise<boolean> {
  return !(await getAppleBreakerState(now)).tripped;
}

/**
 * Record one Apple call's auth outcome, folding it into the durable breaker state. On the K-th
 * consecutive 401/403 the breaker TRIPS (stamps `trippedAt`, resets the streak so the count does
 * not run away). A success clears both the streak and any live trip. See {@link AppleAuthOutcome}.
 */
export async function recordAppleAuthOutcome(
  outcome: AppleAuthOutcome,
  now: number = Date.now(),
): Promise<void> {
  if (outcome === "other") {
    // A 429 / network blip: the other regime. Touch nothing.
    return;
  }

  if (outcome === "ok") {
    // A working token: clear the streak and lift any trip.
    await Promise.all([
      setSetting(APPLE_BREAKER_FAILURES_KEY, "0"),
      setSetting(APPLE_BREAKER_TRIPPED_AT_KEY, ""),
    ]);

    return;
  }

  // auth_failure — advance the streak; trip on the K-th.
  const failures = parseCount(await getSetting(APPLE_BREAKER_FAILURES_KEY)) + 1;

  if (failures >= APPLE_BREAKER_MAX_AUTH_FAILURES) {
    await Promise.all([
      setSetting(APPLE_BREAKER_TRIPPED_AT_KEY, new Date(now).toISOString()),
      setSetting(APPLE_BREAKER_FAILURES_KEY, "0"),
    ]);

    return;
  }

  await setSetting(APPLE_BREAKER_FAILURES_KEY, String(failures));
}

/** Clear the breaker — the operator's `reset_apple_breaker`. Lifts a trip and zeroes the streak. */
export async function resetAppleBreaker(): Promise<AppleBreakerState> {
  await Promise.all([
    setSetting(APPLE_BREAKER_TRIPPED_AT_KEY, ""),
    setSetting(APPLE_BREAKER_FAILURES_KEY, "0"),
  ]);

  return getAppleBreakerState();
}

// ── The call meter ───────────────────────────────────────────────────────────────────────────

/** Read the current window's call count, honouring the window rollover. PURE-ish (one KV read). */
export async function readAppleCallCount(now: number = Date.now()): Promise<number> {
  const [start, count] = await Promise.all([
    getSetting(APPLE_CALLS_WINDOW_START_KEY),
    getSetting(APPLE_CALLS_WINDOW_COUNT_KEY),
  ]);

  const startMs = start ? Date.parse(start) : Number.NaN;

  if (!Number.isFinite(startMs) || now - startMs >= APPLE_CALL_WINDOW_MS) {
    // The window has elapsed (or never started) — nothing counted in the live window.
    return 0;
  }

  return parseCount(count);
}

/**
 * Is there budget for another Apple call in the current window? The sweeps consult this before a
 * batch; a spent window means "pause this tick", not "fail" — the next tick's window is fresh.
 */
export async function isAppleCallBudgetAvailable(now: number = Date.now()): Promise<boolean> {
  return (await readAppleCallCount(now)) < APPLE_CALL_WINDOW_MAX;
}

/** Record one Apple call into the shared meter, rolling the window over when it has elapsed. */
export async function recordAppleCall(now: number = Date.now()): Promise<void> {
  const [start, count] = await Promise.all([
    getSetting(APPLE_CALLS_WINDOW_START_KEY),
    getSetting(APPLE_CALLS_WINDOW_COUNT_KEY),
  ]);

  const startMs = start ? Date.parse(start) : Number.NaN;

  if (!Number.isFinite(startMs) || now - startMs >= APPLE_CALL_WINDOW_MS) {
    // Open a fresh window at this call.
    await Promise.all([
      setSetting(APPLE_CALLS_WINDOW_START_KEY, new Date(now).toISOString()),
      setSetting(APPLE_CALLS_WINDOW_COUNT_KEY, "1"),
    ]);

    return;
  }

  await setSetting(APPLE_CALLS_WINDOW_COUNT_KEY, String(parseCount(count) + 1));
}
