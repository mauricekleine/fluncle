import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIntegrationDb } from "./integration-db";

const store = new Map<string, string>();
let throwOnGet = false;
let throwOnDb = false;
let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return {
    ...actual,
    getDb: async () => {
      if (throwOnDb) {
        throw new Error("counter unavailable");
      }
      return db;
    },
  };
});

vi.mock("./settings", () => ({
  getSetting: async (key: string) => {
    if (throwOnGet) {
      throw new Error("settings KV unavailable");
    }

    if (key === "spotify_quota_hold_until") {
      const result = await db.execute({
        args: [key],
        sql: "select value from settings where key = ?",
      });
      return result.rows[0]?.value as string | undefined;
    }

    return store.get(key);
  },
  setSetting: async (key: string, value: string) => {
    if (key === "spotify_quota_hold_until") {
      await db.execute({
        args: [key, value, value],
        sql: "insert into settings (key, value) values (?, ?) on conflict(key) do update set value = ?",
      });
      return;
    }
    store.set(key, value);
  },
}));

beforeEach(async () => {
  vi.clearAllMocks();
  store.clear();
  throwOnGet = false;
  throwOnDb = false;
  db = await createIntegrationDb();
});

afterEach(() => db.close());

describe("the call meter", () => {
  it("counts calls in a window and rolls over when it elapses", async () => {
    const { readSpotifyCallCount, recordSpotifyCall, SPOTIFY_CALL_WINDOW_MS } =
      await import("./spotify-budget");
    const t0 = 100_000;

    await recordSpotifyCall(t0);
    await recordSpotifyCall(t0 + 1);
    expect(await readSpotifyCallCount(t0 + 2)).toBe(2);

    expect(await readSpotifyCallCount(t0 + SPOTIFY_CALL_WINDOW_MS)).toBe(0);
    await recordSpotifyCall(t0 + SPOTIFY_CALL_WINDOW_MS);
    expect(await readSpotifyCallCount(t0 + SPOTIFY_CALL_WINDOW_MS)).toBe(1);
  });

  it("is allowed at max-1 and denied at the window max", async () => {
    const { isSpotifyCallBudgetAvailable, recordSpotifyCall, SPOTIFY_CALL_WINDOW_MAX } =
      await import("./spotify-budget");
    const now = 100_000;

    for (let i = 0; i < SPOTIFY_CALL_WINDOW_MAX; i += 1) {
      expect(await isSpotifyCallBudgetAvailable(now), `allowed at ${i} (below max)`).toBe(true);
      await recordSpotifyCall(now);
    }

    expect(await isSpotifyCallBudgetAvailable(now), "denied at the max").toBe(false);
  });

  it("frees the budget when the window rolls over", async () => {
    const {
      isSpotifyCallBudgetAvailable,
      recordSpotifyCall,
      SPOTIFY_CALL_WINDOW_MS,
      SPOTIFY_CALL_WINDOW_MAX,
    } = await import("./spotify-budget");
    const t0 = 100_000;

    for (let i = 0; i < SPOTIFY_CALL_WINDOW_MAX; i += 1) {
      await recordSpotifyCall(t0);
    }
    expect(await isSpotifyCallBudgetAvailable(t0)).toBe(false);

    expect(await isSpotifyCallBudgetAvailable(t0 + SPOTIFY_CALL_WINDOW_MS)).toBe(true);
  });
});

describe("fail-closed on a counter fault", () => {
  it("isSpotifyCallBudgetAvailable returns false when the counter read throws", async () => {
    const { isSpotifyCallBudgetAvailable } = await import("./spotify-budget");

    throwOnDb = true;

    expect(await isSpotifyCallBudgetAvailable(100_000)).toBe(false);
  });
});

describe("quota hold", () => {
  it("uses Retry-After, extends rather than shortens, falls back to a day, and caps at 26 hours", async () => {
    const { recordSpotifyQuotaHold, readSpotifyQuotaHoldUntil } = await import("./spotify-budget");
    const now = Date.UTC(2026, 9, 1);
    expect(await recordSpotifyQuotaHold(37, now)).toBe(new Date(now + 37_000).toISOString());
    expect(await readSpotifyQuotaHoldUntil(now)).toBe(new Date(now + 37_000).toISOString());
    expect(await recordSpotifyQuotaHold(null, now)).toBe(new Date(now + 86_400_000).toISOString());
    expect(await recordSpotifyQuotaHold(10, now)).toBe(new Date(now + 86_400_000).toISOString());
    expect(await recordSpotifyQuotaHold(200_000, now)).toBe(
      new Date(now + 26 * 3_600_000).toISOString(),
    );
    expect(await readSpotifyQuotaHoldUntil(now + 26 * 3_600_000)).toBeNull();
  });

  it("rejects unreadable hold state", async () => {
    const { readSpotifyQuotaHoldUntil, SPOTIFY_QUOTA_HOLD_UNTIL_KEY } =
      await import("./spotify-budget");
    await db.execute({
      args: [SPOTIFY_QUOTA_HOLD_UNTIL_KEY, "invalid"],
      sql: "insert into settings (key, value) values (?, ?)",
    });
    await expect(readSpotifyQuotaHoldUntil()).rejects.toThrow(/unreadable/);
  });

  it("does not shorten a stored hold when a later response requests less time", async () => {
    const { recordSpotifyQuotaHold, readSpotifyQuotaHoldUntil } = await import("./spotify-budget");
    const now = Date.UTC(2026, 9, 1);
    const later = await recordSpotifyQuotaHold(120, now);
    const shorter = await recordSpotifyQuotaHold(10, now);
    expect(later).toBe(new Date(now + 120_000).toISOString());
    expect(shorter).toBe(new Date(now + 120_000).toISOString());
    expect(await readSpotifyQuotaHoldUntil(now)).toBe(later);
  });
});

describe("consumer daily budgets", () => {
  it("enforces concurrent charges atomically and resets at UTC midnight", async () => {
    const {
      chargeSpotifyConsumerDailyCall,
      readSpotifyConsumerDailyCallsSpent,
      setSpotifyConsumerDailyBudget,
    } = await import("./spotify-budget");
    const now = Date.UTC(2026, 9, 1, 12);
    await setSpotifyConsumerDailyBudget("anchor", 2);
    const charged = await Promise.all(
      Array.from({ length: 5 }, () => chargeSpotifyConsumerDailyCall("anchor", now)),
    );
    expect(charged.filter(Boolean)).toHaveLength(2);
    expect(await readSpotifyConsumerDailyCallsSpent("anchor", now)).toBe(2);
    expect(await readSpotifyConsumerDailyCallsSpent("anchor", Date.UTC(2026, 9, 2))).toBe(0);
  });

  it("records essential calls separately without consuming optional budgets", async () => {
    const {
      recordSpotifyDailyCall,
      readSpotifyDailyCallCount,
      readSpotifyEssentialDailyCalls,
      readSpotifyConsumerDailyCallsSpent,
    } = await import("./spotify-budget");
    const now = Date.UTC(2026, 9, 1, 12);
    await recordSpotifyDailyCall(now, "essential");
    await recordSpotifyDailyCall(now, "anchor");
    expect(await readSpotifyDailyCallCount(now)).toBe(2);
    expect(await readSpotifyEssentialDailyCalls(now)).toBe(1);
    expect(await readSpotifyConsumerDailyCallsSpent("anchor", now)).toBe(0);
  });
});
