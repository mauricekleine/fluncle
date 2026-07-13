import { afterEach, describe, expect, it } from "vitest";

import {
  collectAppStore,
  collectBluesky,
  collectGithub,
  collectLastfm,
  collectMixcloud,
  collectNpm,
  collectTelegram,
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
