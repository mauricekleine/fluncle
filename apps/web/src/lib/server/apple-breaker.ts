import { makeBreaker, makeCallWindow, type BreakerPatch } from "./breaker";
import { runServerEffect } from "./effect/runtime";
import { getSetting, getSettings, setSetting } from "./settings";

export const APPLE_BREAKER_TRIPPED_AT_KEY = "apple_auth_breaker_tripped_at";

export const APPLE_BREAKER_FAILURES_KEY = "apple_auth_breaker_failures";

export const APPLE_CALLS_WINDOW_START_KEY = "apple_calls_window_start";

export const APPLE_CALLS_WINDOW_COUNT_KEY = "apple_calls_window_count";

export const APPLE_BREAKER_MAX_AUTH_FAILURES = 3;

export const APPLE_BREAKER_COOLDOWN_MS = 30 * 60 * 1000;

export const APPLE_CALL_WINDOW_MS = 60 * 1000;

export const APPLE_CALL_WINDOW_MAX = 18;

export type AppleAuthOutcome = "auth_failure" | "ok" | "other";

const breaker = makeBreaker({
  cooldownMs: APPLE_BREAKER_COOLDOWN_MS,
  maxFailures: APPLE_BREAKER_MAX_AUTH_FAILURES,
});
const callWindow = makeCallWindow(APPLE_CALL_WINDOW_MS);

export function appleBreakerVerdict(input: { now: number; trippedAt: string | null }): {
  cooldownRemainingMs: number;
  tripped: boolean;
} {
  const { cooldownRemainingMs, tripped } = breaker.verdict(input.now, input.trippedAt);

  return { cooldownRemainingMs, tripped };
}

async function persistBreakerPatch(patch: BreakerPatch): Promise<void> {
  await Promise.all([
    setSetting(APPLE_BREAKER_FAILURES_KEY, patch.failures),
    ...(patch.trippedAt === undefined
      ? []
      : [setSetting(APPLE_BREAKER_TRIPPED_AT_KEY, patch.trippedAt)]),
  ]);
}

export type AppleBreakerState = {
  consecutiveAuthFailures: number;
  cooldownRemainingMs: number;
  tripped: boolean;
  trippedAt: string | null;
};

export async function getAppleBreakerState(now: number = Date.now()): Promise<AppleBreakerState> {
  const values = await getSettings([APPLE_BREAKER_TRIPPED_AT_KEY, APPLE_BREAKER_FAILURES_KEY]);
  const trippedAt = values.get(APPLE_BREAKER_TRIPPED_AT_KEY);
  const failures = values.get(APPLE_BREAKER_FAILURES_KEY);

  const verdict = appleBreakerVerdict({ now, trippedAt: trippedAt ?? null });

  return {
    consecutiveAuthFailures: breaker.failureCount({ failures }, now),
    cooldownRemainingMs: verdict.cooldownRemainingMs,
    tripped: verdict.tripped,
    trippedAt: verdict.tripped ? (trippedAt ?? null) : null,
  };
}

export async function areAppleCallsAllowed(now: number = Date.now()): Promise<boolean> {
  return !(await getAppleBreakerState(now)).tripped;
}

export async function recordAppleAuthOutcome(
  outcome: AppleAuthOutcome,
  now: number = Date.now(),
): Promise<void> {
  if (outcome === "other") {
    return;
  }

  const patch =
    outcome === "ok"
      ? breaker.reset
      : await runServerEffect(
          breaker.recordFailure({ failures: await getSetting(APPLE_BREAKER_FAILURES_KEY) }, now),
        );

  await persistBreakerPatch(patch);
}

export async function resetAppleBreaker(): Promise<AppleBreakerState> {
  await persistBreakerPatch(breaker.reset);

  return getAppleBreakerState();
}

export async function readAppleCallCount(now: number = Date.now()): Promise<number> {
  const values = await getSettings([APPLE_CALLS_WINDOW_START_KEY, APPLE_CALLS_WINDOW_COUNT_KEY]);
  const start = values.get(APPLE_CALLS_WINDOW_START_KEY);
  const count = values.get(APPLE_CALLS_WINDOW_COUNT_KEY);

  return callWindow.count(start, count, now);
}

export async function isAppleCallBudgetAvailable(now: number = Date.now()): Promise<boolean> {
  return (await readAppleCallCount(now)) < APPLE_CALL_WINDOW_MAX;
}

export async function recordAppleCall(now: number = Date.now()): Promise<void> {
  const values = await getSettings([APPLE_CALLS_WINDOW_START_KEY, APPLE_CALLS_WINDOW_COUNT_KEY]);
  const start = values.get(APPLE_CALLS_WINDOW_START_KEY);
  const count = values.get(APPLE_CALLS_WINDOW_COUNT_KEY);

  const patch = await runServerEffect(callWindow.record(start, count, now));

  await Promise.all([
    setSetting(APPLE_CALLS_WINDOW_COUNT_KEY, patch.count),
    ...(patch.start === undefined ? [] : [setSetting(APPLE_CALLS_WINDOW_START_KEY, patch.start)]),
  ]);
}
