import { beforeEach, describe, expect, it, vi } from "vitest";

// The catalogue crawler's Spotify-anchor breaker (docs/catalogue-crawler.md § the anchor). The
// `settings` KV is mocked with an in-memory map so the durable trip/streak/reason state is
// exercised without a database, and `now` is injected so the cooldown is deterministic.

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

describe("spotifyAnchorBreakerVerdict (pure)", () => {
  it("is not tripped when never tripped", async () => {
    const { spotifyAnchorBreakerVerdict } = await import("./spotify-anchor-breaker");

    expect(spotifyAnchorBreakerVerdict({ now: 1000, trippedAt: null })).toEqual({
      cooldownRemainingMs: 0,
      tripped: false,
    });
  });

  it("is tripped inside the cooldown and clears after it", async () => {
    const { spotifyAnchorBreakerVerdict, SPOTIFY_ANCHOR_BREAKER_COOLDOWN_MS } =
      await import("./spotify-anchor-breaker");
    const trippedAt = new Date(0).toISOString();

    expect(spotifyAnchorBreakerVerdict({ now: 1000, trippedAt }).tripped).toBe(true);
    expect(
      spotifyAnchorBreakerVerdict({ now: SPOTIFY_ANCHOR_BREAKER_COOLDOWN_MS + 1, trippedAt })
        .tripped,
    ).toBe(false);
  });

  it("treats an unparseable stamp as not tripped (never wedge the anchor)", async () => {
    const { spotifyAnchorBreakerVerdict } = await import("./spotify-anchor-breaker");

    expect(spotifyAnchorBreakerVerdict({ now: 1000, trippedAt: "not-a-date" }).tripped).toBe(false);
  });
});

describe("recordSpotifyAnchorOutcome — the trip", () => {
  it("trips on the K-th consecutive failing pass and blocks calls, keeping the reason", async () => {
    const {
      areSpotifyAnchorCallsAllowed,
      getSpotifyAnchorBreakerState,
      recordSpotifyAnchorOutcome,
      SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES,
    } = await import("./spotify-anchor-breaker");
    const now = 10_000;

    for (let i = 0; i < SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES - 1; i += 1) {
      await recordSpotifyAnchorOutcome("throttled", now);
      expect(await areSpotifyAnchorCallsAllowed(now), "not tripped before the K-th").toBe(true);
    }

    await recordSpotifyAnchorOutcome("throttled", now);

    expect(await areSpotifyAnchorCallsAllowed(now), "tripped on the K-th").toBe(false);
    expect((await getSpotifyAnchorBreakerState(now)).reason).toBe("throttled");
  });

  it("a 429 and a lost grant both advance the same streak; the reason follows the last", async () => {
    const { getSpotifyAnchorBreakerState, recordSpotifyAnchorOutcome } =
      await import("./spotify-anchor-breaker");
    const now = 10_000;

    await recordSpotifyAnchorOutcome("throttled", now);
    await recordSpotifyAnchorOutcome("unauthorized", now);

    const state = await getSpotifyAnchorBreakerState(now);
    expect(state.consecutiveFailures).toBe(2);
    expect(state.reason).toBe("unauthorized");
  });

  it("a healthy pass clears the streak AND lifts a live trip", async () => {
    const {
      areSpotifyAnchorCallsAllowed,
      getSpotifyAnchorBreakerState,
      recordSpotifyAnchorOutcome,
      SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES,
    } = await import("./spotify-anchor-breaker");
    const now = 10_000;

    for (let i = 0; i < SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES; i += 1) {
      await recordSpotifyAnchorOutcome("unauthorized", now);
    }
    expect(await areSpotifyAnchorCallsAllowed(now)).toBe(false);

    await recordSpotifyAnchorOutcome("ok", now);

    expect(await areSpotifyAnchorCallsAllowed(now)).toBe(true);
    const state = await getSpotifyAnchorBreakerState(now);
    expect(state.consecutiveFailures).toBe(0);
    expect(state.reason).toBe(null);
  });

  it("resetSpotifyAnchorBreaker clears a trip and the streak", async () => {
    const {
      areSpotifyAnchorCallsAllowed,
      recordSpotifyAnchorOutcome,
      resetSpotifyAnchorBreaker,
      SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES,
    } = await import("./spotify-anchor-breaker");
    const now = 10_000;

    for (let i = 0; i < SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES; i += 1) {
      await recordSpotifyAnchorOutcome("throttled", now);
    }
    expect(await areSpotifyAnchorCallsAllowed(now)).toBe(false);

    const state = await resetSpotifyAnchorBreaker();

    expect(state.tripped).toBe(false);
    expect(state.consecutiveFailures).toBe(0);
    expect(await areSpotifyAnchorCallsAllowed(now)).toBe(true);
  });
});
