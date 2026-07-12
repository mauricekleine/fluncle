import { beforeEach, describe, expect, it, vi } from "vitest";

// The cross-cutting Apple failure-regime breaker + call meter (RFC musickit-second-authority).
// The `settings` KV is mocked with an in-memory map so the durable trip/streak/window state is
// exercised without a database, and `now` is injected so the cooldown/window are deterministic.

const store = new Map<string, string>();

vi.mock("./settings", () => ({
  getSetting: async (key: string) => store.get(key),
  setSetting: async (key: string, value: string) => {
    store.set(key, value);
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
});

describe("appleBreakerVerdict (pure)", () => {
  it("is not tripped when never tripped", async () => {
    const { appleBreakerVerdict } = await import("./apple-breaker");

    expect(appleBreakerVerdict({ now: 1000, trippedAt: null })).toEqual({
      cooldownRemainingMs: 0,
      tripped: false,
    });
  });

  it("is tripped inside the cooldown and clears after it", async () => {
    const { appleBreakerVerdict, APPLE_BREAKER_COOLDOWN_MS } = await import("./apple-breaker");
    const trippedAt = new Date(0).toISOString();

    expect(appleBreakerVerdict({ now: 1000, trippedAt }).tripped).toBe(true);
    expect(appleBreakerVerdict({ now: APPLE_BREAKER_COOLDOWN_MS + 1, trippedAt }).tripped).toBe(
      false,
    );
  });

  it("treats an unparseable stamp as not tripped (never wedge Apple)", async () => {
    const { appleBreakerVerdict } = await import("./apple-breaker");

    expect(appleBreakerVerdict({ now: 1000, trippedAt: "not-a-date" }).tripped).toBe(false);
  });
});

describe("recordAppleAuthOutcome — the trip", () => {
  it("trips on the K-th consecutive 401/403 and blocks calls", async () => {
    const { areAppleCallsAllowed, recordAppleAuthOutcome, APPLE_BREAKER_MAX_AUTH_FAILURES } =
      await import("./apple-breaker");
    const now = 10_000;

    for (let i = 0; i < APPLE_BREAKER_MAX_AUTH_FAILURES - 1; i += 1) {
      await recordAppleAuthOutcome("auth_failure", now);
      expect(await areAppleCallsAllowed(now), "not tripped before the K-th").toBe(true);
    }

    await recordAppleAuthOutcome("auth_failure", now);

    expect(await areAppleCallsAllowed(now), "tripped on the K-th").toBe(false);
  });

  it("a success resets the streak and lifts any trip", async () => {
    const { areAppleCallsAllowed, getAppleBreakerState, recordAppleAuthOutcome } =
      await import("./apple-breaker");
    const now = 10_000;

    await recordAppleAuthOutcome("auth_failure", now);
    await recordAppleAuthOutcome("auth_failure", now);
    await recordAppleAuthOutcome("auth_failure", now); // trips (K = 3)
    expect(await areAppleCallsAllowed(now)).toBe(false);

    await recordAppleAuthOutcome("ok", now);

    expect(await areAppleCallsAllowed(now)).toBe(true);
    expect((await getAppleBreakerState(now)).consecutiveAuthFailures).toBe(0);
  });

  it("a 429/'other' outcome neither trips nor resets the streak", async () => {
    const { getAppleBreakerState, recordAppleAuthOutcome } = await import("./apple-breaker");
    const now = 10_000;

    await recordAppleAuthOutcome("auth_failure", now);
    await recordAppleAuthOutcome("other", now); // must NOT reset the streak
    await recordAppleAuthOutcome("auth_failure", now);

    // Two auth failures survived the intervening 429 (K = 3 not yet reached, streak intact).
    expect((await getAppleBreakerState(now)).consecutiveAuthFailures).toBe(2);
  });

  it("resetAppleBreaker clears a trip and the streak", async () => {
    const { areAppleCallsAllowed, recordAppleAuthOutcome, resetAppleBreaker } =
      await import("./apple-breaker");
    const now = 10_000;

    await recordAppleAuthOutcome("auth_failure", now);
    await recordAppleAuthOutcome("auth_failure", now);
    await recordAppleAuthOutcome("auth_failure", now);
    expect(await areAppleCallsAllowed(now)).toBe(false);

    const state = await resetAppleBreaker();

    expect(state.tripped).toBe(false);
    expect(state.consecutiveAuthFailures).toBe(0);
    expect(await areAppleCallsAllowed(now)).toBe(true);
  });
});

describe("the call meter", () => {
  it("counts calls in a window and rolls over when it elapses", async () => {
    const { readAppleCallCount, recordAppleCall, APPLE_CALL_WINDOW_MS } =
      await import("./apple-breaker");
    const t0 = 100_000;

    await recordAppleCall(t0);
    await recordAppleCall(t0 + 1);
    expect(await readAppleCallCount(t0 + 2)).toBe(2);

    // A read past the window elapse reads 0, and the next record opens a fresh window.
    expect(await readAppleCallCount(t0 + APPLE_CALL_WINDOW_MS)).toBe(0);
    await recordAppleCall(t0 + APPLE_CALL_WINDOW_MS);
    expect(await readAppleCallCount(t0 + APPLE_CALL_WINDOW_MS)).toBe(1);
  });

  it("reports the budget spent at the window max", async () => {
    const { isAppleCallBudgetAvailable, recordAppleCall, APPLE_CALL_WINDOW_MAX } =
      await import("./apple-breaker");
    const now = 100_000;

    for (let i = 0; i < APPLE_CALL_WINDOW_MAX; i += 1) {
      expect(await isAppleCallBudgetAvailable(now), `budget available at ${i}`).toBe(true);
      await recordAppleCall(now);
    }

    expect(await isAppleCallBudgetAvailable(now), "spent at the max").toBe(false);
  });
});
