import { beforeEach, describe, expect, it, vi } from "vitest";

// The Spotify anchor breaker's DURABLE state machine (the apple-breaker.test.ts shape). The
// `settings` KV is mocked with an in-memory map so the trip / count / window state is exercised
// without a database, and `now` is injected so the cooldown and the failure window are deterministic.
//
// What is proven HERE: the pure verdict, the decaying-window count, the trip, the RELEASE, the
// default-deny rule, the corrupt-stamp self-heal, the reset, the total-recorder contract, and the
// production rows' behaviour on adoption. What is proven in `spotify-anchor-breaker.integration.test.ts`
// is the other half and the one that matters more: that the REAL `spotifyFetch` 429 path drives all
// of this, and that a tripped breaker leaves the user-facing Spotify paths completely alone.

const store = new Map<string, string>();
let getFails = false;
let setFails = false;

vi.mock("./settings", () => ({
  getSetting: async (key: string) => {
    if (getFails) {
      throw new Error("settings store unavailable");
    }

    return store.get(key);
  },
  setSetting: async (key: string, value: string) => {
    if (setFails) {
      throw new Error("settings store unavailable");
    }

    store.set(key, value);
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  getFails = false;
  setFails = false;
});

/** Drive N 429s through the recorder at one instant — enough to trip at the default threshold. */
async function throttle(times: number, now: number): Promise<void> {
  const { recordSpotifyThrottle } = await import("./spotify-anchor-breaker");

  for (let i = 0; i < times; i += 1) {
    await recordSpotifyThrottle(now);
  }
}

describe("spotifyAnchorBreakerVerdict (pure)", () => {
  it("is not tripped when never tripped", async () => {
    const { spotifyAnchorBreakerVerdict } = await import("./spotify-anchor-breaker");

    expect(spotifyAnchorBreakerVerdict({ now: 1000, trippedAt: null })).toEqual({
      cooldownRemainingMs: 0,
      corrupt: false,
      tripped: false,
    });
  });

  it("is tripped inside the cooldown and CLEARS after it", async () => {
    const { spotifyAnchorBreakerVerdict, SPOTIFY_ANCHOR_BREAKER_COOLDOWN_MS } =
      await import("./spotify-anchor-breaker");
    const trippedAt = new Date(0).toISOString();

    expect(spotifyAnchorBreakerVerdict({ now: 1000, trippedAt }).tripped).toBe(true);
    expect(
      spotifyAnchorBreakerVerdict({ now: SPOTIFY_ANCHOR_BREAKER_COOLDOWN_MS + 1, trippedAt })
        .tripped,
    ).toBe(false);
  });

  it("DEFAULT-DENY: an unparseable stamp reads as tripped-and-corrupt", async () => {
    const { spotifyAnchorBreakerVerdict, SPOTIFY_ANCHOR_BREAKER_COOLDOWN_MS } =
      await import("./spotify-anchor-breaker");

    // The OPPOSITE of apple-breaker's "never wedge Apple": this breaker's only consumer is optional
    // catalogue work, so ambiguity must fail toward "anchor search not allowed".
    expect(spotifyAnchorBreakerVerdict({ now: 1000, trippedAt: "not-a-date" })).toEqual({
      cooldownRemainingMs: SPOTIFY_ANCHOR_BREAKER_COOLDOWN_MS,
      corrupt: true,
      tripped: true,
    });
  });
});

describe("spotifyAnchorFailureStreak (pure) — the decaying window", () => {
  it("advances the count inside the window and RESTARTS it outside", async () => {
    const { spotifyAnchorFailureStreak, SPOTIFY_ANCHOR_BREAKER_FAILURE_WINDOW_MS } =
      await import("./spotify-anchor-breaker");
    const now = 10_000_000;
    const lastFailureAt = new Date(now - 1000).toISOString();

    expect(spotifyAnchorFailureStreak({ failures: 3, lastFailureAt, now })).toBe(4);

    const stale = new Date(now - SPOTIFY_ANCHOR_BREAKER_FAILURE_WINDOW_MS - 1).toISOString();

    expect(spotifyAnchorFailureStreak({ failures: 3, lastFailureAt: stale, now })).toBe(1);
  });

  it("treats an absent or unparseable last-failure stamp as no live window", async () => {
    const { spotifyAnchorFailureStreak } = await import("./spotify-anchor-breaker");

    expect(spotifyAnchorFailureStreak({ failures: 4, lastFailureAt: null, now: 10_000 })).toBe(1);
    expect(spotifyAnchorFailureStreak({ failures: 4, lastFailureAt: "junk", now: 10_000 })).toBe(1);
  });
});

describe("recordSpotifyThrottle — the trip and the release", () => {
  it("trips on the N-th 429 inside the window, and not before", async () => {
    const { spotifyAnchorSearchBreakerTripped, SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES } =
      await import("./spotify-anchor-breaker");
    const now = 10_000_000;

    await throttle(SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES - 1, now);
    expect(
      await spotifyAnchorSearchBreakerTripped(now),
      "not tripped before the N-th throttle",
    ).toBe(false);

    await throttle(1, now);

    expect(await spotifyAnchorSearchBreakerTripped(now), "tripped on the N-th").toBe(true);
  });

  it("RELEASES itself once the cooldown elapses", async () => {
    const {
      getSpotifyAnchorBreakerState,
      spotifyAnchorSearchBreakerTripped,
      SPOTIFY_ANCHOR_BREAKER_COOLDOWN_MS,
      SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES,
    } = await import("./spotify-anchor-breaker");
    const now = 10_000_000;

    await throttle(SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES, now);
    expect(await spotifyAnchorSearchBreakerTripped(now)).toBe(true);

    // One millisecond before the cooldown ends it is still tripped…
    expect(
      await spotifyAnchorSearchBreakerTripped(now + SPOTIFY_ANCHOR_BREAKER_COOLDOWN_MS - 1),
    ).toBe(true);

    // …and the moment it elapses the rungs are armed again, with no operator in the loop.
    const after = now + SPOTIFY_ANCHOR_BREAKER_COOLDOWN_MS + 1;

    expect(await spotifyAnchorSearchBreakerTripped(after)).toBe(false);
    expect(await getSpotifyAnchorBreakerState(after)).toEqual({
      cooldownRemainingMs: 0,
      reason: null,
      throttlesInWindow: 0,
      tripped: false,
      trippedAt: null,
    });
  });

  it("stamps the reason and zeroes the count on the trip", async () => {
    const {
      getSpotifyAnchorBreakerState,
      SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES,
      SPOTIFY_ANCHOR_BREAKER_REASON_THROTTLED,
    } = await import("./spotify-anchor-breaker");
    const now = 10_000_000;

    await throttle(SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES, now);

    const state = await getSpotifyAnchorBreakerState(now);

    expect(state.reason).toBe(SPOTIFY_ANCHOR_BREAKER_REASON_THROTTLED);
    expect(state.trippedAt).toBe(new Date(now).toISOString());
    // Zeroed so a long storm cannot run the counter away while the breaker is already doing its job.
    expect(state.throttlesInWindow).toBe(0);
  });

  it("does NOT trip on throttles spread beyond the failure window", async () => {
    const {
      spotifyAnchorSearchBreakerTripped,
      SPOTIFY_ANCHOR_BREAKER_FAILURE_WINDOW_MS,
      SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES,
    } = await import("./spotify-anchor-breaker");
    let now = 10_000_000;

    // Twice the threshold's worth of 429s, each a full window apart: normal backpressure the
    // per-call backoff already absorbed, never a regime.
    for (let i = 0; i < SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES * 2; i += 1) {
      await throttle(1, now);
      now += SPOTIFY_ANCHOR_BREAKER_FAILURE_WINDOW_MS + 1;
    }

    expect(await spotifyAnchorSearchBreakerTripped(now)).toBe(false);
  });

  it("is a no-op while already tripped (the cooldown cannot be pushed out forever)", async () => {
    const { getSpotifyAnchorBreakerState, SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES } =
      await import("./spotify-anchor-breaker");
    const now = 10_000_000;

    await throttle(SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES, now);
    const trippedAt = (await getSpotifyAnchorBreakerState(now)).trippedAt;

    // A storm continuing an hour's worth of throttles later must not move the stamp.
    await throttle(50, now + 60_000);

    expect((await getSpotifyAnchorBreakerState(now + 60_000)).trippedAt).toBe(trippedAt);
  });

  it("normalises a CORRUPT stamp into a definite, expiring trip (the default-deny self-heal)", async () => {
    const {
      spotifyAnchorSearchBreakerTripped,
      SPOTIFY_ANCHOR_BREAKER_COOLDOWN_MS,
      SPOTIFY_ANCHOR_BREAKER_TRIPPED_AT_KEY,
    } = await import("./spotify-anchor-breaker");
    const now = 10_000_000;

    store.set(SPOTIFY_ANCHOR_BREAKER_TRIPPED_AT_KEY, "¯\\_(ツ)_/¯");
    expect(await spotifyAnchorSearchBreakerTripped(now), "denied while unreadable").toBe(true);
    // Unhealed, it would deny forever — the cooldown has nothing to measure from.
    expect(
      await spotifyAnchorSearchBreakerTripped(now + SPOTIFY_ANCHOR_BREAKER_COOLDOWN_MS * 10),
    ).toBe(true);

    await throttle(1, now);

    expect(store.get(SPOTIFY_ANCHOR_BREAKER_TRIPPED_AT_KEY)).toBe(new Date(now).toISOString());
    expect(
      await spotifyAnchorSearchBreakerTripped(now + SPOTIFY_ANCHOR_BREAKER_COOLDOWN_MS + 1),
      "now expires like any other trip",
    ).toBe(false);
  });
});

describe("the total-recorder contract — a breaker never breaks the call it observes", () => {
  it("swallows a settings READ fault", async () => {
    const { recordSpotifyThrottle } = await import("./spotify-anchor-breaker");

    getFails = true;

    await expect(recordSpotifyThrottle(10_000)).resolves.toBeUndefined();
  });

  it("swallows a settings WRITE fault", async () => {
    const { recordSpotifyThrottle } = await import("./spotify-anchor-breaker");

    setFails = true;

    await expect(recordSpotifyThrottle(10_000)).resolves.toBeUndefined();
  });
});

describe("spotifyAnchorSearchBreakerTripped — DEFAULT-DENY on a store fault", () => {
  it("reads TRIPPED when the settings store throws", async () => {
    const { spotifyAnchorSearchBreakerTripped } = await import("./spotify-anchor-breaker");

    getFails = true;

    expect(await spotifyAnchorSearchBreakerTripped(10_000)).toBe(true);
  });

  it("but the honest state read still surfaces the error to an operator", async () => {
    const { getSpotifyAnchorBreakerState } = await import("./spotify-anchor-breaker");

    getFails = true;

    await expect(getSpotifyAnchorBreakerState(10_000)).rejects.toThrow(/settings store/);
  });
});

describe("resetSpotifyAnchorBreaker", () => {
  it("clears a live trip and the count", async () => {
    const {
      resetSpotifyAnchorBreaker,
      spotifyAnchorSearchBreakerTripped,
      SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES,
    } = await import("./spotify-anchor-breaker");
    const now = 10_000_000;

    await throttle(SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES, now);
    expect(await spotifyAnchorSearchBreakerTripped(now)).toBe(true);

    const state = await resetSpotifyAnchorBreaker();

    expect(state.tripped).toBe(false);
    expect(state.reason).toBeNull();
    expect(state.throttlesInWindow).toBe(0);
    expect(await spotifyAnchorSearchBreakerTripped(now)).toBe(false);
  });

  it("clears a CORRUPT trip too — the operator's instant escape from a default-deny wedge", async () => {
    const {
      resetSpotifyAnchorBreaker,
      spotifyAnchorSearchBreakerTripped,
      SPOTIFY_ANCHOR_BREAKER_TRIPPED_AT_KEY,
    } = await import("./spotify-anchor-breaker");

    store.set(SPOTIFY_ANCHOR_BREAKER_TRIPPED_AT_KEY, "not-a-date");
    expect(await spotifyAnchorSearchBreakerTripped(10_000)).toBe(true);

    expect((await resetSpotifyAnchorBreaker()).tripped).toBe(false);
    expect(await spotifyAnchorSearchBreakerTripped(10_000)).toBe(false);
  });
});

describe("adopting the orphaned production rows", () => {
  // The three keys already exist in the production `settings` table with these EXACT values, written
  // 2026-07-18 and frozen since because no code could change them. Adoption must be a no-op on the
  // first deploy: the long-past trip has to read as EXPIRED (via the cooldown), not as a live one.
  const PROD_TRIPPED_AT = "2026-07-18T09:25:37.713Z";
  const PROD_REASON = "throttled";
  const PROD_FAILURES = "1";

  async function seedProductionRows(): Promise<void> {
    const {
      SPOTIFY_ANCHOR_BREAKER_FAILURES_KEY,
      SPOTIFY_ANCHOR_BREAKER_REASON_KEY,
      SPOTIFY_ANCHOR_BREAKER_TRIPPED_AT_KEY,
    } = await import("./spotify-anchor-breaker");

    store.set(SPOTIFY_ANCHOR_BREAKER_TRIPPED_AT_KEY, PROD_TRIPPED_AT);
    store.set(SPOTIFY_ANCHOR_BREAKER_REASON_KEY, PROD_REASON);
    store.set(SPOTIFY_ANCHOR_BREAKER_FAILURES_KEY, PROD_FAILURES);
    // The one NEW key is absent, exactly as it is in production.
  }

  it("the stale 2026-07-18 trip reads as EXPIRED, not as permanently tripped", async () => {
    const { getSpotifyAnchorBreakerState, spotifyAnchorSearchBreakerTripped } =
      await import("./spotify-anchor-breaker");

    await seedProductionRows();

    const now = Date.parse("2026-07-29T12:00:00.000Z"); // eleven days later

    expect(await spotifyAnchorSearchBreakerTripped(now)).toBe(false);
    expect(await getSpotifyAnchorBreakerState(now)).toEqual({
      cooldownRemainingMs: 0,
      reason: null,
      throttlesInWindow: 0,
      tripped: false,
      trippedAt: null,
    });
  });

  it("the stale `failures: 1` does NOT count toward the next trip", async () => {
    const {
      getSpotifyAnchorBreakerState,
      spotifyAnchorSearchBreakerTripped,
      SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES,
    } = await import("./spotify-anchor-breaker");

    await seedProductionRows();

    const now = Date.parse("2026-07-29T12:00:00.000Z");

    // The missing failure-window stamp makes the orphaned count stale, so the first fresh 429
    // restarts at 1 — the full threshold is still required, not one fewer.
    await throttle(SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES - 1, now);

    expect(await spotifyAnchorSearchBreakerTripped(now)).toBe(false);
    expect((await getSpotifyAnchorBreakerState(now)).throttlesInWindow).toBe(
      SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES - 1,
    );

    await throttle(1, now);
    expect(await spotifyAnchorSearchBreakerTripped(now)).toBe(true);
  });
});
