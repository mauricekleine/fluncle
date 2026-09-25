import { getSetting, setSetting } from "./settings";

export const APPLE_BREAKER_TRIPPED_AT_KEY = "apple_auth_breaker_tripped_at";

export const APPLE_BREAKER_FAILURES_KEY = "apple_auth_breaker_failures";

export const APPLE_CALLS_WINDOW_START_KEY = "apple_calls_window_start";

export const APPLE_CALLS_WINDOW_COUNT_KEY = "apple_calls_window_count";

export const APPLE_BREAKER_MAX_AUTH_FAILURES = 3;

export const APPLE_BREAKER_COOLDOWN_MS = 30 * 60 * 1000;

export const APPLE_CALL_WINDOW_MS = 60 * 1000;

export const APPLE_CALL_WINDOW_MAX = 18;

export type AppleAuthOutcome = "auth_failure" | "ok" | "other";

function parseCount(raw: string | undefined, fallback = 0): number {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) {
    return fallback;
  }

  const parsed = Number(raw.trim());

  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

export function appleBreakerVerdict(input: { now: number; trippedAt: string | null }): {
  cooldownRemainingMs: number;
  tripped: boolean;
} {
  if (!input.trippedAt) {
    return { cooldownRemainingMs: 0, tripped: false };
  }

  const trippedMs = Date.parse(input.trippedAt);

  if (!Number.isFinite(trippedMs)) {
    return { cooldownRemainingMs: 0, tripped: false };
  }

  const remaining = APPLE_BREAKER_COOLDOWN_MS - (input.now - trippedMs);

  return remaining > 0
    ? { cooldownRemainingMs: remaining, tripped: true }
    : { cooldownRemainingMs: 0, tripped: false };
}

export type AppleBreakerState = {
  consecutiveAuthFailures: number;
  cooldownRemainingMs: number;
  tripped: boolean;
  trippedAt: string | null;
};

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

  if (outcome === "ok") {
    await Promise.all([
      setSetting(APPLE_BREAKER_FAILURES_KEY, "0"),
      setSetting(APPLE_BREAKER_TRIPPED_AT_KEY, ""),
    ]);

    return;
  }

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

export async function resetAppleBreaker(): Promise<AppleBreakerState> {
  await Promise.all([
    setSetting(APPLE_BREAKER_TRIPPED_AT_KEY, ""),
    setSetting(APPLE_BREAKER_FAILURES_KEY, "0"),
  ]);

  return getAppleBreakerState();
}

export async function readAppleCallCount(now: number = Date.now()): Promise<number> {
  const [start, count] = await Promise.all([
    getSetting(APPLE_CALLS_WINDOW_START_KEY),
    getSetting(APPLE_CALLS_WINDOW_COUNT_KEY),
  ]);

  const startMs = start ? Date.parse(start) : Number.NaN;

  if (!Number.isFinite(startMs) || now - startMs >= APPLE_CALL_WINDOW_MS) {
    return 0;
  }

  return parseCount(count);
}

export async function isAppleCallBudgetAvailable(now: number = Date.now()): Promise<boolean> {
  return (await readAppleCallCount(now)) < APPLE_CALL_WINDOW_MAX;
}

export async function recordAppleCall(now: number = Date.now()): Promise<void> {
  const [start, count] = await Promise.all([
    getSetting(APPLE_CALLS_WINDOW_START_KEY),
    getSetting(APPLE_CALLS_WINDOW_COUNT_KEY),
  ]);

  const startMs = start ? Date.parse(start) : Number.NaN;

  if (!Number.isFinite(startMs) || now - startMs >= APPLE_CALL_WINDOW_MS) {
    await Promise.all([
      setSetting(APPLE_CALLS_WINDOW_START_KEY, new Date(now).toISOString()),
      setSetting(APPLE_CALLS_WINDOW_COUNT_KEY, "1"),
    ]);

    return;
  }

  await setSetting(APPLE_CALLS_WINDOW_COUNT_KEY, String(parseCount(count) + 1));
}
