// The TikTok Display-API leg, proven against the REAL migrated schema on an in-memory libSQL
// engine (the integration-db harness) plus injected fetch. What is easy to get wrong:
//
//   1. THE AUTHORIZE URL — the right host/params, and scope COMMA-separated (TikTok's format,
//      not Google's space string), with the CSRF state carried through.
//   2. TOKEN REFRESH ROTATION — TikTok rotates the refresh token; the NEW one must be persisted
//      (a stale stored refresh token would break the next refresh). The stored one is kept only
//      when the response omits a new one.
//   3. VIDEO-ID PARSING — the native aweme id lifted from a `…/video/<id>` permalink (pure).
//   4. THE COLLECTOR GATE + PAGINATION — a clean `null` no-op when unconfigured OR unconnected,
//      and a budget-capped cursor walk when connected.

import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => holder.db };
});

import { createIntegrationDb } from "./integration-db";
import {
  buildTikTokAuthUrl,
  collectOwnTikTokVideos,
  extractTiktokVideoId,
  getTikTokAccessToken,
  hasTikTokAuth,
} from "./tiktok";

let db: Client;

const NOW = Date.now();

/** Seed a single-row tiktok_auth. `expiresInMs` from now: negative = already expired. */
async function seedAuth(input: {
  accessToken?: string;
  expiresInMs: number;
  refreshToken?: string;
}): Promise<void> {
  const iso = new Date().toISOString();
  await db.execute({
    args: [
      "tiktok",
      input.accessToken ?? "stored-access",
      input.refreshToken ?? "stored-refresh",
      new Date(NOW + input.expiresInMs).toISOString(),
      "user.info.basic,video.list",
      iso,
    ],
    sql: `insert into tiktok_auth (service, access_token, refresh_token, expires_at, scope, updated_at)
          values (?, ?, ?, ?, ?, ?)`,
  });
}

async function readAuth(): Promise<Record<string, unknown> | undefined> {
  const result = await db.execute(`select * from tiktok_auth where service = 'tiktok'`);

  return result.rows[0] as Record<string, unknown> | undefined;
}

beforeEach(async () => {
  db = await createIntegrationDb();
  holder.db = db;
  process.env.TIKTOK_CLIENT_KEY = "test-key";
  process.env.TIKTOK_CLIENT_SECRET = "test-secret";
  process.env.TIKTOK_REDIRECT_URI = "https://www.fluncle.com/api/admin/tiktok/auth/callback";
});

afterEach(() => {
  holder.db = undefined;
  delete process.env.TIKTOK_CLIENT_KEY;
  delete process.env.TIKTOK_CLIENT_SECRET;
  delete process.env.TIKTOK_REDIRECT_URI;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("buildTikTokAuthUrl", () => {
  it("builds the v2 authorize URL with comma-separated scope + the CSRF state", async () => {
    const url = new URL(await buildTikTokAuthUrl("state-123"));

    expect(url.origin + url.pathname).toBe("https://www.tiktok.com/v2/auth/authorize/");
    expect(url.searchParams.get("client_key")).toBe("test-key");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://www.fluncle.com/api/admin/tiktok/auth/callback",
    );
    expect(url.searchParams.get("state")).toBe("state-123");
    // Comma-separated (URLSearchParams decodes %2C back to ",") — TikTok's format.
    expect(url.searchParams.get("scope")).toBe("user.info.basic,video.list");
  });

  it("throws a clean not-configured error when the creds are unset", async () => {
    delete process.env.TIKTOK_CLIENT_KEY;

    await expect(buildTikTokAuthUrl("state")).rejects.toThrow(/not configured/i);
  });
});

describe("extractTiktokVideoId", () => {
  it("lifts the native aweme id from a /video/<id> permalink", () => {
    expect(extractTiktokVideoId("https://www.tiktok.com/@fluncle/video/7361234567890123456")).toBe(
      "7361234567890123456",
    );
  });

  it("lifts it even with a trailing query", () => {
    expect(
      extractTiktokVideoId("https://www.tiktok.com/@fluncle/video/7361234567890123456?is_copy=1"),
    ).toBe("7361234567890123456");
  });

  it("returns null for a non-video TikTok URL and for junk", () => {
    expect(extractTiktokVideoId("https://www.tiktok.com/@fluncle")).toBeNull();
    expect(extractTiktokVideoId("")).toBeNull();
    expect(extractTiktokVideoId("not a url")).toBeNull();
  });
});

describe("getTikTokAccessToken", () => {
  it("returns the stored token without refreshing when it is still fresh", async () => {
    await seedAuth({ accessToken: "fresh-token", expiresInMs: 10 * 60_000 });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    expect(await getTikTokAccessToken()).toBe("fresh-token");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refreshes an expired token and PERSISTS the rotated refresh token", async () => {
    await seedAuth({
      accessToken: "old-access",
      expiresInMs: -60_000,
      refreshToken: "old-refresh",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: "new-access",
              expires_in: 86_400,
              refresh_token: "rotated-refresh",
              scope: "user.info.basic,video.list",
            }),
            { headers: { "Content-Type": "application/json" }, status: 200 },
          ),
        ),
      ),
    );

    expect(await getTikTokAccessToken()).toBe("new-access");

    const row = await readAuth();
    expect(row?.access_token).toBe("new-access");
    // The ROTATION: the new refresh token replaces the stored one.
    expect(row?.refresh_token).toBe("rotated-refresh");
  });

  it("keeps the stored refresh token when the refresh response omits a new one", async () => {
    await seedAuth({ expiresInMs: -60_000, refreshToken: "keep-me" });

    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ access_token: "new-access", expires_in: 86_400 }), {
            headers: { "Content-Type": "application/json" },
            status: 200,
          }),
        ),
      ),
    );

    await getTikTokAccessToken();

    const row = await readAuth();
    expect(row?.refresh_token).toBe("keep-me");
  });
});

describe("collectOwnTikTokVideos (the gate + pagination)", () => {
  it("is a clean no-op (null) when the creds are unset", async () => {
    delete process.env.TIKTOK_CLIENT_KEY;
    const fetchImpl = vi.fn<typeof fetch>();

    expect(await collectOwnTikTokVideos({ fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("is a clean no-op (null) when configured but NOT connected (no auth row)", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    expect(await hasTikTokAuth()).toBe(false);
    expect(await collectOwnTikTokVideos({ fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("walks the cursor across pages and maps each video's metrics", async () => {
    await seedAuth({ accessToken: "fresh", expiresInMs: 10 * 60_000 });

    const page = (videos: unknown[], hasMore: boolean, cursor: number) =>
      Promise.resolve(
        new Response(
          JSON.stringify({ data: { cursor, has_more: hasMore, videos }, error: { code: "ok" } }),
          {
            headers: { "Content-Type": "application/json" },
            status: 200,
          },
        ),
      );

    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() =>
        page(
          [{ comment_count: 3, id: "v1", like_count: 20, share_count: 1, view_count: 100 }],
          true,
          1111,
        ),
      )
      .mockImplementationOnce(() =>
        page([{ id: "v2", like_count: 5, view_count: 50 }], false, 2222),
      );

    const videos = await collectOwnTikTokVideos({ fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(videos).toEqual([
      { comments: 3, id: "v1", likes: 20, shares: 1, views: 100 },
      // Unreported metrics stay null (never coerced to 0).
      { comments: null, id: "v2", likes: 5, shares: null, views: 50 },
    ]);

    // The second request carried the first page's cursor.
    const secondCall = fetchImpl.mock.calls[1];
    expect(JSON.parse(secondCall?.[1]?.body as string)).toMatchObject({ cursor: 1111 });
  });

  it("throws on a non-ok TikTok error envelope (the caller catches + skips)", async () => {
    await seedAuth({ accessToken: "fresh", expiresInMs: 10 * 60_000 });
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: {}, error: { code: "access_token_invalid" } }), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }),
      ),
    );

    await expect(collectOwnTikTokVideos({ fetchImpl })).rejects.toThrow(/access_token_invalid/);
  });
});
