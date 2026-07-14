import { afterEach, describe, expect, it } from "vitest";

import {
  collectAppStore,
  collectBluesky,
  collectGithub,
  collectInstagramFollowers,
  collectLastfm,
  collectMixcloud,
  collectNpm,
  collectTelegram,
  collectTiktokStats,
  collectTwitchFollowers,
  collectYoutube,
  type FetchImpl,
  requireCount,
} from "./platform-stats";

// PER-FETCHER PARSING, with fetch INJECTED — no real network. Each collector is a
// pure fetch+parse over the injected `fetchImpl`, so a canned response body exercises
// the exact shape each platform's public API returns (and the string→int coercion the
// counts need). The env-gated fetchers (lastfm/telegram/youtube) also read a key off
// process.env, set + cleared per test.

/** A fake `fetch` that answers by URL SUBSTRING with a JSON body + status. */
function fakeFetch(routes: { body: unknown; match: string; status?: number }[]): FetchImpl {
  return ((input: URL | string) => {
    const url = typeof input === "string" ? input : input.href;
    const route = routes.find((entry) => url.includes(entry.match));

    if (!route) {
      throw new Error(`unexpected fetch: ${url}`);
    }

    return Promise.resolve(
      new Response(JSON.stringify(route.body), { status: route.status ?? 200 }),
    );
  }) as FetchImpl;
}

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("requireCount", () => {
  it("coerces a numeric string, truncates, and rejects garbage", () => {
    expect(requireCount("1234", "x")).toBe(1234);
    expect(requireCount(42, "x")).toBe(42);
    expect(requireCount(3.9, "x")).toBe(3);
    expect(() => requireCount(undefined, "x")).toThrow(/missing or non-numeric/);
    expect(() => requireCount("not-a-number", "x")).toThrow();
    expect(() => requireCount(-1, "x")).toThrow();
  });
});

describe("collectMixcloud", () => {
  it("parses follower_count / listen_count / cloudcast_count", async () => {
    const metrics = await collectMixcloud(
      fakeFetch([
        {
          body: { cloudcast_count: 12, follower_count: 87, listen_count: 4210 },
          match: "api.mixcloud.com",
        },
      ]),
    );

    expect(metrics).toEqual([
      { metric: "followers", value: 87 },
      { metric: "listens", value: 4210 },
      { metric: "uploads", value: 12 },
    ]);
  });

  it("throws on a non-200 so the collector records a skip", async () => {
    await expect(
      collectMixcloud(fakeFetch([{ body: {}, match: "api.mixcloud.com", status: 503 }])),
    ).rejects.toThrow(/Mixcloud responded 503/);
  });
});

describe("collectBluesky", () => {
  it("parses followersCount / postsCount", async () => {
    const metrics = await collectBluesky(
      fakeFetch([{ body: { followersCount: 3, postsCount: 40 }, match: "bsky.app" }]),
    );

    expect(metrics).toEqual([
      { metric: "followers", value: 3 },
      { metric: "posts", value: 40 },
    ]);
  });
});

describe("collectGithub", () => {
  it("parses stargazers_count", async () => {
    const metrics = await collectGithub(
      fakeFetch([{ body: { stargazers_count: 256 }, match: "api.github.com" }]),
    );

    expect(metrics).toEqual([{ metric: "stars", value: 256 }]);
  });

  it("sends the Authorization header when GITHUB_TOKEN is set — the shared-egress quota fix", async () => {
    process.env.GITHUB_TOKEN = "gh-token";

    let sawAuth = "";
    const metrics = await collectGithub((async (_url: unknown, init?: RequestInit) => {
      sawAuth = String((init?.headers as Record<string, string>)?.Authorization ?? "");

      return new Response(JSON.stringify({ stargazers_count: 2 }), { status: 200 });
    }) as FetchImpl);

    delete process.env.GITHUB_TOKEN;
    expect(sawAuth).toBe("Bearer gh-token");
    expect(metrics).toEqual([{ metric: "stars", value: 2 }]);
  });
});

describe("collectNpm", () => {
  it("parses the last-week downloads point", async () => {
    const metrics = await collectNpm(
      fakeFetch([{ body: { downloads: 91 }, match: "api.npmjs.org" }]),
    );

    expect(metrics).toEqual([{ metric: "downloads_weekly", value: 91 }]);
  });
});

describe("collectAppStore", () => {
  it("parses userRatingCount when the app is live", async () => {
    const metrics = await collectAppStore(
      fakeFetch([
        { body: { resultCount: 1, results: [{ userRatingCount: 7 }] }, match: "itunes.apple.com" },
      ]),
    );

    expect(metrics).toEqual([{ metric: "rating_count", value: 7 }]);
  });

  it("treats resultCount 0 as an honest skip (app not live yet)", async () => {
    await expect(
      collectAppStore(
        fakeFetch([{ body: { resultCount: 0, results: [] }, match: "itunes.apple.com" }]),
      ),
    ).rejects.toThrow(/not live yet/);
  });
});

describe("collectLastfm", () => {
  it("parses playcount + loved @attr.total from two reads (env-gated)", async () => {
    process.env.LASTFM_API_KEY = "test-key";

    const metrics = await collectLastfm(
      fakeFetch([
        { body: { user: { playcount: "15342" } }, match: "user.getinfo" },
        { body: { lovedtracks: { "@attr": { total: "88" } } }, match: "user.getlovedtracks" },
      ]),
    );

    expect(metrics).toEqual([
      { metric: "scrobbles", value: 15342 },
      { metric: "loved_tracks", value: 88 },
    ]);
  });

  it("skips cleanly when the api key is unset", async () => {
    delete process.env.LASTFM_API_KEY;

    await expect(collectLastfm(fakeFetch([]))).rejects.toThrow(/LASTFM_API_KEY is not set/);
  });
});

describe("collectTelegram", () => {
  it("records the RAW member count (no −1 for the bot)", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_CHANNEL_ID = "@fluncle";

    const metrics = await collectTelegram(
      fakeFetch([{ body: { ok: true, result: 4 }, match: "api.telegram.org" }]),
    );

    expect(metrics).toEqual([{ metric: "audience", value: 4 }]);
  });

  it("skips cleanly when the bot token / channel id are unset", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHANNEL_ID;

    await expect(collectTelegram(fakeFetch([]))).rejects.toThrow(/not set/);
  });
});

describe("collectYoutube", () => {
  it("resolves the channel by handle and parses subscriberCount / viewCount", async () => {
    process.env.YOUTUBE_API_KEY = "yt-key";

    const metrics = await collectYoutube(
      fakeFetch([
        {
          body: { items: [{ statistics: { subscriberCount: "4", viewCount: "1200" } }] },
          match: "googleapis.com/youtube",
        },
      ]),
    );

    expect(metrics).toEqual([
      { metric: "subscribers", value: 4 },
      { metric: "views", value: 1200 },
    ]);
  });

  it("skips cleanly when the api key is unset", async () => {
    delete process.env.YOUTUBE_API_KEY;

    await expect(collectYoutube(fakeFetch([]))).rejects.toThrow(/YOUTUBE_API_KEY is not set/);
  });
});

// ── Tier-2 PARSE halves (token + fetch injected, no DB) ──────────────────────

describe("collectTwitchFollowers", () => {
  it("resolves the broadcaster id then parses the follower total", async () => {
    const metrics = await collectTwitchFollowers(
      fakeFetch([
        { body: { data: [{ id: "12345" }] }, match: "helix/users" },
        { body: { data: [], total: 4210 }, match: "helix/channels/followers" },
      ]),
      "twitch-access-token",
      "twitch-client-id",
    );

    expect(metrics).toEqual([{ metric: "followers", value: 4210 }]);
  });

  it("throws when the users read returns no broadcaster (→ a skip)", async () => {
    await expect(
      collectTwitchFollowers(
        fakeFetch([{ body: { data: [] }, match: "helix/users" }]),
        "tok",
        "cid",
      ),
    ).rejects.toThrow(/no broadcaster id/);
  });

  it("throws on a non-200 from the followers read (→ a skip)", async () => {
    await expect(
      collectTwitchFollowers(
        fakeFetch([
          { body: { data: [{ id: "1" }] }, match: "helix/users" },
          { body: {}, match: "helix/channels/followers", status: 401 },
        ]),
        "tok",
        "cid",
      ),
    ).rejects.toThrow(/channels\/followers responded 401/);
  });
});

describe("collectTiktokStats", () => {
  it("parses follower_count + likes_count from data.user", async () => {
    const metrics = await collectTiktokStats(
      fakeFetch([
        {
          body: { data: { user: { follower_count: 88, likes_count: 512 } } },
          match: "open.tiktokapis.com/v2/user/info",
        },
      ]),
      "tiktok-access-token",
    );

    expect(metrics).toEqual([
      { metric: "followers", value: 88 },
      { metric: "likes", value: 512 },
    ]);
  });

  it("throws when TikTok reports a non-ok error code in the body (→ a skip)", async () => {
    await expect(
      collectTiktokStats(
        fakeFetch([
          {
            body: { error: { code: "access_token_invalid", message: "bad token" } },
            match: "open.tiktokapis.com/v2/user/info",
          },
        ]),
        "tok",
      ),
    ).rejects.toThrow(/bad token/);
  });
});

describe("collectInstagramFollowers", () => {
  it("parses followers_count from the graph me read", async () => {
    const metrics = await collectInstagramFollowers(
      fakeFetch([
        { body: { followers_count: 143, id: "178..." }, match: "graph.instagram.com/me" },
      ]),
      "instagram-long-token",
    );

    expect(metrics).toEqual([{ metric: "followers", value: 143 }]);
  });

  it("throws on a non-200 (→ a skip)", async () => {
    await expect(
      collectInstagramFollowers(
        fakeFetch([{ body: {}, match: "graph.instagram.com/me", status: 400 }]),
        "tok",
      ),
    ).rejects.toThrow(/Instagram me responded 400/);
  });
});
