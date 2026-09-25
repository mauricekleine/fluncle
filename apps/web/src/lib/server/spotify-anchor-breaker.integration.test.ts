import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb } from "./integration-db";

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

const NON_FRIDAY = new Date("2026-07-22T12:00:00Z");

const TRACK_PREFIX = "https://api.spotify.com/v1/tracks/";
const SEARCH_PREFIX = "https://api.spotify.com/v1/search";
const PLAYLIST_PREFIX = "https://api.spotify.com/v1/playlists/";

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

const TRACK_BODY = JSON.stringify({
  artists: [{ id: "sp-etherwood", name: "Etherwood" }],
  duration_ms: 261_901,
  external_urls: { spotify: "https://open.spotify.com/track/spLive" },
  id: "spLive",
  name: "Weightless",
  uri: "spotify:track:spLive",
});

function stubSpotify(options: { throttle: boolean; throttleBody?: string }): { calls: string[] } {
  const calls: string[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);

      if (options.throttle) {
        return new Response(options.throttleBody ?? "rate limited", {
          headers: { "Retry-After": "20" },
          status: 429,
        });
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

    expect(await anchorSpotifySearchAllowed(NON_FRIDAY)).toBe(true);

    await driveThrottledCalls(SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES - 1);
    expect(await anchorSpotifySearchAllowed(NON_FRIDAY)).toBe(true);

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

    const row = await db.execute({
      args: [SPOTIFY_ANCHOR_BREAKER_TRIPPED_AT_KEY],
      sql: "select value from settings where key = ?",
    });

    const stored = row.rows[0]?.value;

    expect(typeof stored === "string" ? stored : null).toBe(state.trippedAt);
  });

  it("classifies a real QUOTA_EXCEEDED response through spotifyFetch", async () => {
    const { anchorSpotifySearchGate, setAnchorSpotifySearchEnabled } =
      await import("./anchor-spotify-search");
    const { getSpotifyAnchorBreakerState, SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES } =
      await import("./spotify-anchor-breaker");

    await setAnchorSpotifySearchEnabled(true);
    stubSpotify({ throttle: true, throttleBody: '{"error":{"reason":"QUOTA_EXCEEDED"}}' });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NON_FRIDAY);
    try {
      await driveThrottledCalls(SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES);
      expect((await getSpotifyAnchorBreakerState()).reason).toBe("quota_exceeded");
      expect((await anchorSpotifySearchGate(NON_FRIDAY)).reason).toBe("breaker_quota");
    } finally {
      vi.useRealTimers();
    }
  });

  it("admits a quota exception after one real 429 and reopens one hour later", async () => {
    const { anchorSpotifySearchGate, setAnchorSpotifySearchEnabled } =
      await import("./anchor-spotify-search");
    const { getSpotifyAnchorBreakerState } = await import("./spotify-anchor-breaker");
    const quotaAt = new Date("2026-07-22T00:30:00.000Z");
    await setAnchorSpotifySearchEnabled(true);
    stubSpotify({ throttle: true, throttleBody: '{"error":{"reason":"QUOTA_EXCEEDED"}}' });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(quotaAt);
    try {
      await driveThrottledCalls(1);
      expect((await getSpotifyAnchorBreakerState()).tripped).toBe(false);
      expect(await anchorSpotifySearchGate(quotaAt)).toMatchObject({
        nextEligibleAt: "2026-07-22T01:30:00.000Z",
        reason: "quota_hold",
      });
      expect((await anchorSpotifySearchGate(new Date("2026-07-22T01:30:00.000Z"))).reason).toBe(
        "open",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("a throttled anchor sweep trips the breaker that pauses it — the self-limiting loop", async () => {
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
    const {
      SPOTIFY_ANCHOR_BREAKER_COOLDOWN_MS,
      SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES,
      SPOTIFY_ANCHOR_BREAKER_TRIPPED_AT_KEY,
    } = await import("./spotify-anchor-breaker");
    const { setSetting } = await import("./settings");

    await setAnchorSpotifySearchEnabled(true);
    stubSpotify({ throttle: true });

    await driveThrottledCalls(SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES);
    expect(await anchorSpotifySearchAllowed(NON_FRIDAY)).toBe(false);

    await setSetting(SPOTIFY_ANCHOR_BREAKER_TRIPPED_AT_KEY, NON_FRIDAY.toISOString());

    const trippedAtMs = NON_FRIDAY.getTime();

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
