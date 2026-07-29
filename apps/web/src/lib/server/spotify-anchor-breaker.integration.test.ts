import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb } from "./integration-db";

// THE SPOTIFY ANCHOR BREAKER, END TO END, ON THE REAL PATH.
//
// The unit suite (`spotify-anchor-breaker.test.ts`) pins the state machine against a mocked KV. This
// one exists because a safety mechanism that only passes its own self-test is not proven: it wires
// the REAL `spotifyFetch` to the REAL `settings` table and drives the breaker with REAL 429
// responses, so a regression that disconnects the recorder from the 429 path — or the gate from the
// breaker — fails HERE even though every unit test still passes.
//
// The database, the `settings` reads/writes, the breaker, `spotifyFetch`'s 429 handling and
// `anchorSpotifySearchAllowed`'s three-clause gate are all the real thing. Only the network (global
// `fetch`) and the env reads are doubled.
//
// It proves four things:
//   1. TRIPS — N real 429 responses through `spotifyFetch` close the anchor-search gate.
//   2. DOES NOT PAUSE THE USER-FACING PATHS — while tripped, the mint's by-id read and the publish
//      playlist write both still reach Spotify. This is the load-bearing safety property.
//   3. RELEASES — the gate re-opens by itself once the cooldown elapses.
//   4. The gate is an AND — the breaker can only ever subtract permission from the dark flag.
//
// Every 429 stub carries `Retry-After: 20`, which blows `spotifyFetch`'s ~10s wait budget on the
// first retry: exactly one request, one recorded throttle, and no timer to drive (the shape the
// existing `spotifyFetch 429 backoff` suite pins in `spotify.test.ts`).

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

vi.mock("./env", () => ({
  readEnv: async () => "test-value",
  readEnvs: async (keys: readonly string[]) =>
    Object.fromEntries(keys.map((key) => [key, `test-${key}`])),
  readOptionalEnv: async () => undefined,
}));

/** A Wednesday noon — well outside the Friday-morning Frontier-refresh window. */
const NON_FRIDAY = new Date("2026-07-22T12:00:00Z");

const TRACK_PREFIX = "https://api.spotify.com/v1/tracks/";
const SEARCH_PREFIX = "https://api.spotify.com/v1/search";
const PLAYLIST_PREFIX = "https://api.spotify.com/v1/playlists/";

/** A connected Spotify account whose access token is fresh, so no token refresh is ever attempted. */
async function seedSpotifyAuth(): Promise<void> {
  await db.execute({
    args: [
      "spotify",
      "at-live",
      "rt-live",
      new Date(Date.now() + 3_600_000).toISOString(),
      "playlist-modify-public",
      new Date().toISOString(),
    ],
    sql: `insert into spotify_auth (service, access_token, refresh_token, expires_at, scope, updated_at)
          values (?, ?, ?, ?, ?, ?)`,
  });
}

/** One Spotify track payload, enough for `fetchTrackMetadata` to parse. */
const TRACK_BODY = JSON.stringify({
  artists: [{ id: "sp-etherwood", name: "Etherwood" }],
  duration_ms: 261_901,
  external_urls: { spotify: "https://open.spotify.com/track/spLive" },
  id: "spLive",
  name: "Weightless",
  uri: "spotify:track:spLive",
});

/**
 * Stub the network. `throttle` decides whether Spotify pushes back; every call is recorded so a test
 * can assert a request was actually ISSUED (the only honest proof that a path was not gated).
 */
function stubSpotify(options: { throttle: boolean }): { calls: string[] } {
  const calls: string[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);

      if (options.throttle) {
        // `Retry-After: 20` exceeds the ~10s retry budget, so the call issues exactly one request.
        return new Response("rate limited", { headers: { "Retry-After": "20" }, status: 429 });
      }

      if (url.startsWith(TRACK_PREFIX)) {
        return new Response(TRACK_BODY, { status: 200 });
      }

      if (url.startsWith(SEARCH_PREFIX)) {
        return new Response(JSON.stringify({ tracks: { items: [] } }), { status: 200 });
      }

      if (url.startsWith(PLAYLIST_PREFIX)) {
        return new Response(JSON.stringify({ snapshot_id: "snap" }), { status: 200 });
      }

      throw new Error(`unexpected fetch: ${url}`);
    }),
  );

  return { calls };
}

/**
 * Drive `count` REAL throttled Spotify calls through `spotifyFetch`. Uses `searchTrackCandidates` —
 * a plain GET — so each call is one request that ends in the 429 error shape callers already sniff.
 */
async function driveThrottledCalls(count: number): Promise<void> {
  const { searchTrackCandidates } = await import("./spotify");

  for (let i = 0; i < count; i += 1) {
    await expect(searchTrackCandidates(`amen break ${i}`)).rejects.toThrow(/429/);
  }
}

beforeEach(async () => {
  db = await createIntegrationDb();
  vi.unstubAllGlobals();
  await seedSpotifyAuth();
});

describe("the breaker TRIPS from real 429s on the real fetch path", () => {
  it("N throttled Spotify calls close the anchor-search gate", async () => {
    const { anchorSpotifySearchAllowed, setAnchorSpotifySearchEnabled } =
      await import("./anchor-spotify-search");
    const { SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES } = await import("./spotify-anchor-breaker");

    await setAnchorSpotifySearchEnabled(true);
    stubSpotify({ throttle: true });

    // Armed and healthy: the rungs may run.
    expect(await anchorSpotifySearchAllowed(NON_FRIDAY)).toBe(true);

    // One short of the threshold is still normal backpressure — the gate stays open.
    await driveThrottledCalls(SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES - 1);
    expect(await anchorSpotifySearchAllowed(NON_FRIDAY)).toBe(true);

    // The N-th throttle is a regime, not a blip.
    await driveThrottledCalls(1);
    expect(await anchorSpotifySearchAllowed(NON_FRIDAY)).toBe(false);
  });

  it("writes the trip through to the real `settings` rows an operator reads", async () => {
    const {
      getSpotifyAnchorBreakerState,
      SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES,
      SPOTIFY_ANCHOR_BREAKER_REASON_THROTTLED,
      SPOTIFY_ANCHOR_BREAKER_TRIPPED_AT_KEY,
    } = await import("./spotify-anchor-breaker");

    stubSpotify({ throttle: true });
    await driveThrottledCalls(SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES);

    const state = await getSpotifyAnchorBreakerState();

    expect(state.tripped).toBe(true);
    expect(state.reason).toBe(SPOTIFY_ANCHOR_BREAKER_REASON_THROTTLED);

    // The durable row, in the same table the operator can inspect and clear.
    const row = await db.execute({
      args: [SPOTIFY_ANCHOR_BREAKER_TRIPPED_AT_KEY],
      sql: "select value from settings where key = ?",
    });

    const stored = row.rows[0]?.value;

    expect(typeof stored === "string" ? stored : null).toBe(state.trippedAt);
  });

  it("a throttled anchor sweep trips the breaker that pauses it — the self-limiting loop", async () => {
    // The regression this whole slice exists to prevent: a sustained anchor sweep starving the
    // shared app. `searchTrackCandidates` IS the fuzzy anchor rung, so these are the sweep's own
    // calls — and the fifth one closes the gate on the sweep itself.
    const { anchorSpotifySearchAllowed, setAnchorSpotifySearchEnabled } =
      await import("./anchor-spotify-search");
    const { SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES } = await import("./spotify-anchor-breaker");

    await setAnchorSpotifySearchEnabled(true);
    stubSpotify({ throttle: true });
    await driveThrottledCalls(SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES);

    expect(await anchorSpotifySearchAllowed(NON_FRIDAY)).toBe(false);
  });
});

describe("THE LOAD-BEARING PROPERTY: a tripped breaker pauses ONLY the anchor search", () => {
  /** Trip the breaker for real, then hand back a healthy (200) network. */
  async function tripThenRecover(): Promise<{ calls: string[] }> {
    const { SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES } = await import("./spotify-anchor-breaker");
    const { spotifyAnchorSearchBreakerTripped } = await import("./spotify-anchor-breaker");

    stubSpotify({ throttle: true });
    await driveThrottledCalls(SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES);
    expect(await spotifyAnchorSearchBreakerTripped(), "breaker must be tripped").toBe(true);

    vi.unstubAllGlobals();

    return stubSpotify({ throttle: false });
  }

  it("the MINT's by-id read still reaches Spotify while tripped", async () => {
    const { fetchTrackMetadata } = await import("./spotify");
    const { calls } = await tripThenRecover();

    const metadata = await fetchTrackMetadata("spLive");

    expect(metadata.spotifyUri).toBe("spotify:track:spLive");
    // Not "it did not throw" — the request was ISSUED. A gated path would never reach the network.
    expect(calls.filter((url) => url.startsWith(TRACK_PREFIX))).toHaveLength(1);
  });

  it("PUBLISH's playlist write still reaches Spotify while tripped", async () => {
    const { addTrackToPlaylist, fetchTrackMetadata } = await import("./spotify");
    const { calls } = await tripThenRecover();

    const track = await fetchTrackMetadata("spLive");

    await expect(addTrackToPlaylist(track)).resolves.toBeUndefined();
    expect(calls.filter((url) => url.startsWith(PLAYLIST_PREFIX))).toHaveLength(1);
  });

  it("the operator's track SEARCH still reaches Spotify while tripped", async () => {
    const { searchTrackCandidates } = await import("./spotify");
    const { calls } = await tripThenRecover();

    await expect(searchTrackCandidates("etherwood weightless")).resolves.toEqual([]);
    expect(calls.filter((url) => url.startsWith(SEARCH_PREFIX))).toHaveLength(1);
  });

  it("the FRONTIER refresh's playlist read still reaches Spotify while tripped", async () => {
    const { fetchPlaylistFollowerCount } = await import("./spotify");

    await tripThenRecover();
    vi.unstubAllGlobals();
    const calls: string[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);

        return new Response(JSON.stringify({ followers: { total: 42 } }), { status: 200 });
      }),
    );

    await expect(fetchPlaylistFollowerCount()).resolves.toBe(42);
    expect(calls).toHaveLength(1);
  });
});

describe("the breaker RELEASES", () => {
  it("re-opens the anchor-search gate once the cooldown elapses, with no operator", async () => {
    const { anchorSpotifySearchAllowed, setAnchorSpotifySearchEnabled } =
      await import("./anchor-spotify-search");
    const { SPOTIFY_ANCHOR_BREAKER_COOLDOWN_MS, SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES } =
      await import("./spotify-anchor-breaker");

    await setAnchorSpotifySearchEnabled(true);
    stubSpotify({ throttle: true });

    const trippedAtMs = Date.now();

    await driveThrottledCalls(SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES);
    expect(await anchorSpotifySearchAllowed(NON_FRIDAY)).toBe(false);

    // `anchorSpotifySearchAllowed` takes `now`, so the cooldown is driven without touching timers.
    const stillCooling = new Date(trippedAtMs + SPOTIFY_ANCHOR_BREAKER_COOLDOWN_MS - 60_000);
    const released = new Date(trippedAtMs + SPOTIFY_ANCHOR_BREAKER_COOLDOWN_MS + 60_000);

    expect(await anchorSpotifySearchAllowed(stillCooling), "still paused mid-cooldown").toBe(false);
    expect(await anchorSpotifySearchAllowed(released), "self-heals at the cooldown").toBe(true);
  });

  it("the operator's reset re-opens the gate immediately", async () => {
    const { anchorSpotifySearchAllowed, setAnchorSpotifySearchEnabled } =
      await import("./anchor-spotify-search");
    const { resetSpotifyAnchorBreaker, SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES } =
      await import("./spotify-anchor-breaker");

    await setAnchorSpotifySearchEnabled(true);
    stubSpotify({ throttle: true });
    await driveThrottledCalls(SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES);
    expect(await anchorSpotifySearchAllowed(NON_FRIDAY)).toBe(false);

    const state = await resetSpotifyAnchorBreaker();

    expect(state.tripped).toBe(false);
    expect(await anchorSpotifySearchAllowed(NON_FRIDAY)).toBe(true);
  });
});

describe("the gate is an AND — the breaker only ever subtracts", () => {
  it("a clear breaker does not open the gate when the dark flag is OFF", async () => {
    const { anchorSpotifySearchAllowed } = await import("./anchor-spotify-search");

    // No flag row ⇒ default OFF, breaker clear. The dark flag still rules.
    expect(await anchorSpotifySearchAllowed(NON_FRIDAY)).toBe(false);
  });

  it("a tripped breaker closes the gate the dark flag had opened", async () => {
    const { anchorSpotifySearchAllowed, setAnchorSpotifySearchEnabled } =
      await import("./anchor-spotify-search");
    const { SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES } = await import("./spotify-anchor-breaker");

    await setAnchorSpotifySearchEnabled(true);
    expect(await anchorSpotifySearchAllowed(NON_FRIDAY)).toBe(true);

    stubSpotify({ throttle: true });
    await driveThrottledCalls(SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES);

    expect(await anchorSpotifySearchAllowed(NON_FRIDAY)).toBe(false);
  });
});
