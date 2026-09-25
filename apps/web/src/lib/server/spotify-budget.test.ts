import { beforeEach, describe, expect, it, vi } from "vitest";

// The shared Spotify per-app call meter (the Frontier-pacing keystone). The `settings` KV is mocked
// with an in-memory map so the durable window state is exercised without a database, and `now` is
// injected so the window rollover is deterministic. Mirrors ./apple-breaker.test.ts.

const store = new Map<string, string>();
let throwOnGet = false;

vi.mock("./settings", () => ({
  getSetting: async (key: string) => {
    if (throwOnGet) {
      throw new Error("settings KV unavailable");
    }

    return store.get(key);
  },
  setSetting: async (key: string, value: string) => {
    store.set(key, value);
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  throwOnGet = false;
});

describe("spotifyCallWindow (pure)", () => {
  it("reports the live count and reset hint inside the window", async () => {
    const { spotifyCallWindow, SPOTIFY_CALL_WINDOW_MS } = await import("./spotify-budget");

    expect(spotifyCallWindow({ count: 3, now: 1_000, startMs: 0 })).toEqual({
      count: 3,
      live: true,
      msUntilReset: SPOTIFY_CALL_WINDOW_MS - 1_000,
    });
  });

  it("rolls over to an empty window once it has elapsed", async () => {
    const { spotifyCallWindow, SPOTIFY_CALL_WINDOW_MS } = await import("./spotify-budget");

    expect(spotifyCallWindow({ count: 9, now: SPOTIFY_CALL_WINDOW_MS, startMs: 0 })).toEqual({
      count: 0,
      live: false,
      msUntilReset: 0,
    });
  });

  it("treats an unparseable/absent start as no live window", async () => {
    const { spotifyCallWindow } = await import("./spotify-budget");

    expect(spotifyCallWindow({ count: 5, now: 1_000, startMs: Number.NaN })).toEqual({
      count: 0,
      live: false,
      msUntilReset: 0,
    });
  });
});

describe("the call meter", () => {
  it("counts calls in a window and rolls over when it elapses", async () => {
    const { readSpotifyCallCount, recordSpotifyCall, SPOTIFY_CALL_WINDOW_MS } =
      await import("./spotify-budget");
    const t0 = 100_000;

    await recordSpotifyCall(t0);
    await recordSpotifyCall(t0 + 1);
    expect(await readSpotifyCallCount(t0 + 2)).toBe(2);

    // A read past the window elapse reads 0, and the next record opens a fresh window.
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

    // The next window is fresh.
    expect(await isSpotifyCallBudgetAvailable(t0 + SPOTIFY_CALL_WINDOW_MS)).toBe(true);
  });
});

describe("fail-open on a KV fault", () => {
  it("isSpotifyCallBudgetAvailable returns true when the settings read throws", async () => {
    const { isSpotifyCallBudgetAvailable } = await import("./spotify-budget");

    throwOnGet = true;

    expect(await isSpotifyCallBudgetAvailable(100_000)).toBe(true);
  });
});
