import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Spotify access-token acquire path (`getSpotifyAccessToken`, exercised here
// through the exported `searchTrackCandidates`, which reads the token then does one
// GET /search carrying it as a Bearer header). These pin the refresh lifecycle and
// the concurrent-refresh RACE GUARD: when Spotify rotates a single-use refresh token,
// the operator action that loses a two-way refresh race gets invalid_grant on a token
// the winner already consumed — the connection is healthy, so we must NOT nuke the
// row. The guard re-reads the row and, when a concurrent winner has rotated it,
// returns the winner's fresh access token instead of clearing.

vi.mock("./env", () => ({
  readEnv: async () => "test-value",
  readEnvs: async (keys: readonly string[]) =>
    Object.fromEntries(keys.map((key) => [key, `test-${key}`])),
  readOptionalEnv: async () => undefined,
}));

type AuthRow = {
  access_token: string;
  refresh_token: string;
  expires_at: string;
};

// A queue of rows handed out one-per-SELECT, so a test can make the re-read (the
// second SELECT on the invalid_grant path) observe a different row than the first.
let selectQueue: Array<AuthRow | undefined> = [];
let deleteCount = 0;
let upsertCount = 0;

const execute = vi.fn(async ({ sql }: { args?: unknown[]; sql: string }) => {
  if (sql.includes("select access_token")) {
    const row = selectQueue.shift();

    return { rows: row ? [row] : [] };
  }

  if (sql.includes("delete from spotify_auth")) {
    deleteCount += 1;

    return { rows: [] };
  }

  if (sql.includes("insert into spotify_auth")) {
    upsertCount += 1;

    return { rows: [] };
  }

  throw new Error(`unexpected sql: ${sql}`);
});

vi.mock("./db", () => ({
  getDb: async () => ({ execute }),
  typedRow: <T>(rows: T[]): T | undefined => rows[0],
  typedRows: <T>(rows: T[]): T[] => rows,
}));

import { searchTrackCandidates } from "./spotify";

const TOKEN_URL = "https://accounts.spotify.com/api/token";
const SEARCH_PREFIX = "https://api.spotify.com/v1/search";

const future = () => new Date(Date.now() + 3_600_000).toISOString();
const past = () => new Date(Date.now() - 1_000).toISOString();

// A fetch double: the token endpoint answers per the staged refresh outcome; the
// search endpoint records the Authorization header it was called with (revealing
// which access token the acquire path resolved) and returns an empty result set.
function stubFetch(
  refresh: { kind: "invalid_grant" } | { kind: "ok"; access_token: string; refresh_token?: string },
) {
  const searchAuth: string[] = [];

  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === TOKEN_URL) {
      if (refresh.kind === "invalid_grant") {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }

      return new Response(
        JSON.stringify({
          access_token: refresh.access_token,
          expires_in: 3600,
          refresh_token: refresh.refresh_token,
          scope: "playlist-modify-public",
        }),
        { status: 200 },
      );
    }

    if (url.startsWith(SEARCH_PREFIX)) {
      searchAuth.push(new Headers(init?.headers).get("Authorization") ?? "");

      return new Response(JSON.stringify({ tracks: { items: [] } }), { status: 200 });
    }

    throw new Error(`unexpected fetch: ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);

  return { searchAuth };
}

beforeEach(() => {
  selectQueue = [];
  deleteCount = 0;
  upsertCount = 0;
  execute.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getSpotifyAccessToken refresh lifecycle", () => {
  it("returns the stored token without refreshing when it is still valid", async () => {
    selectQueue = [{ access_token: "at-valid", expires_at: future(), refresh_token: "rt" }];
    const { searchAuth } = stubFetch({ access_token: "unused", kind: "ok" });

    await searchTrackCandidates("amen break");

    expect(searchAuth).toEqual(["Bearer at-valid"]);
    expect(upsertCount).toBe(0);
    expect(deleteCount).toBe(0);
  });

  it("refreshes an expired token and carries the fresh access token", async () => {
    selectQueue = [{ access_token: "at-old", expires_at: past(), refresh_token: "rt-old" }];
    // Spotify omits refresh_token on a non-rotating refresh; the stored one is kept.
    const { searchAuth } = stubFetch({ access_token: "at-fresh", kind: "ok" });

    await searchTrackCandidates("amen break");

    expect(searchAuth).toEqual(["Bearer at-fresh"]);
    expect(upsertCount).toBe(1);
    expect(deleteCount).toBe(0);
  });

  it("clears the row and demands reconnect when invalid_grant hits an UNCHANGED row", async () => {
    // Both the acquire read and the re-read return the same token: the grant is
    // genuinely dead, so today's behavior stands — clear the row and throw.
    const dead: AuthRow = { access_token: "at-dead", expires_at: past(), refresh_token: "rt-dead" };
    selectQueue = [dead, dead];
    stubFetch({ kind: "invalid_grant" });

    await expect(searchTrackCandidates("amen break")).rejects.toMatchObject({
      code: "spotify_reauth_required",
      status: 401,
    });
    expect(deleteCount).toBe(1);
  });

  it("does NOT clear and returns the winner's token when a concurrent refresh rotated the row", async () => {
    // The acquire read sees the stale row; our refresh loses the race and gets
    // invalid_grant; the re-read sees the row a concurrent winner already rotated.
    selectQueue = [
      { access_token: "at-old", expires_at: past(), refresh_token: "rt-old" },
      { access_token: "at-winner", expires_at: future(), refresh_token: "rt-winner" },
    ];
    const { searchAuth } = stubFetch({ kind: "invalid_grant" });

    await searchTrackCandidates("amen break");

    expect(searchAuth).toEqual(["Bearer at-winner"]);
    expect(deleteCount).toBe(0);
  });
});
