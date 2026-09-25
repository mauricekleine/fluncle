import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb, rowCount } from "./integration-db";
import { type FetchImpl, listPlatformStats, recordPlatformStats } from "./platform-stats";

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

vi.mock("./spotify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./spotify")>();

  return { ...actual, fetchPlaylistFollowerCount: () => Promise.resolve(2) };
});

vi.mock("./resend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./resend")>();

  return { ...actual, countSegmentRecipients: () => Promise.resolve(31) };
});

const ORIGINAL_ENV = { ...process.env };

function collectorFetch(
  failing: Set<string> = new Set(),
  empty: Set<string> = new Set(),
): FetchImpl {
  const bodyFor = (url: string): { body: unknown; match: string } | undefined => {
    if (url.includes("api.mixcloud.com")) {
      return {
        body: { cloudcast_count: 12, follower_count: 87, listen_count: 4210 },
        match: "mixcloud",
      };
    }
    if (url.includes("bsky.app")) {
      return { body: { followersCount: 3, postsCount: 40 }, match: "bluesky" };
    }
    if (url.includes("api.github.com")) {
      return { body: { stargazers_count: 256 }, match: "github" };
    }
    if (url.includes("api.npmjs.org")) {
      return { body: { downloads: 91 }, match: "npm" };
    }
    if (url.includes("itunes.apple.com")) {
      return empty.has("appstore")
        ? { body: { resultCount: 0, results: [] }, match: "appstore" }
        : { body: { resultCount: 1, results: [{ userRatingCount: 7 }] }, match: "appstore" };
    }
    if (url.includes("user.getinfo")) {
      return { body: { user: { playcount: "15342" } }, match: "lastfm" };
    }
    if (url.includes("user.getlovedtracks")) {
      return { body: { lovedtracks: { "@attr": { total: "88" } } }, match: "lastfm" };
    }
    if (url.includes("api.telegram.org")) {
      return { body: { ok: true, result: 4 }, match: "telegram" };
    }
    if (url.includes("googleapis.com/youtube")) {
      return {
        body: { items: [{ statistics: { subscriberCount: "4", viewCount: "1200" } }] },
        match: "youtube",
      };
    }

    return undefined;
  };

  return ((input: URL | string) => {
    const url = typeof input === "string" ? input : input.href;
    const route = bodyFor(url);

    if (!route) {
      throw new Error(`unexpected fetch: ${url}`);
    }

    const status = failing.has(route.match) ? 500 : 200;

    return Promise.resolve(new Response(JSON.stringify(route.body), { status }));
  }) as FetchImpl;
}

describe("the /reach store", () => {
  beforeEach(async () => {
    db = await createIntegrationDb();
    process.env = {
      ...ORIGINAL_ENV,
      LASTFM_API_KEY: "test-key",
      RESEND_API_KEY: "resend-key",
      RESEND_SEGMENT_ID: "segment-id",
      SPOTIFY_PLAYLIST_ID: "playlist-id",
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_CHANNEL_ID: "@fluncle",
      YOUTUBE_API_KEY: "yt-key",
    };
    delete process.env.POSTIZ_API_KEY;
    delete process.env.TWITCH_CLIENT_ID;
    delete process.env.TWITCH_CLIENT_SECRET;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("collects every Tier-1 platform and writes one row per (platform, metric)", async () => {
    const at = new Date().toISOString();
    const result = await recordPlatformStats({ at, fetchImpl: collectorFetch() });

    expect(result.collected).toHaveLength(10);
    expect(result.inserted).toBe(15);
    expect(result.failed).toEqual([]);
    expect(await rowCount(db, "platform_stats")).toBe(15);

    const collectedPlatforms = result.collected.map((entry) => entry.platform).sort();
    expect(collectedPlatforms).toEqual(
      [
        "appstore",
        "bluesky",
        "github",
        "lastfm",
        "mixcloud",
        "newsletter",
        "npm",
        "spotify_playlist",
        "telegram",
        "youtube",
      ].sort(),
    );

    const skippedPlatforms = result.skipped.map((entry) => entry.platform).sort();
    expect(skippedPlatforms).toEqual(["instagram", "tiktok", "twitch"]);
    for (const skip of result.skipped) {
      expect(skip.kind).toBe("unconfigured");
      expect(skip.reason.length).toBeGreaterThan(0);
    }
  });

  it("isolates a single platform's fetch fault as failed, never dropping the rest", async () => {
    const at = new Date().toISOString();
    const result = await recordPlatformStats({
      at,
      fetchImpl: collectorFetch(new Set(["github"])),
    });

    const githubFailure = result.failed.find((entry) => entry.platform === "github");
    expect(githubFailure).toBeDefined();
    expect(githubFailure?.reason).toMatch(/GitHub responded 500/);
    expect(result.skipped.some((entry) => entry.platform === "github")).toBe(false);

    expect(result.collected).toHaveLength(9);
    expect(result.inserted).toBe(14);
    expect(result.collected.some((entry) => entry.platform === "github")).toBe(false);
  });

  it("distinguishes unconfigured, measured-empty, and faulted platform outcomes", async () => {
    const result = await recordPlatformStats({
      at: new Date().toISOString(),
      fetchImpl: collectorFetch(new Set(["github"]), new Set(["appstore"])),
    });

    expect(result.skipped).toContainEqual({
      kind: "unconfigured",
      platform: "tiktok",
      reason: "POSTIZ_API_KEY is not set",
    });
    expect(result.skipped).toContainEqual({
      kind: "empty",
      platform: "appstore",
      reason: "App Store app is not live yet (resultCount 0)",
    });
    expect(result.failed).toContainEqual({
      platform: "github",
      reason: "GitHub responded 500",
    });
  });

  it("is idempotent for a same-day re-collect (ON CONFLICT DO NOTHING)", async () => {
    const at = new Date().toISOString();

    const first = await recordPlatformStats({ at, fetchImpl: collectorFetch() });
    expect(first.inserted).toBe(15);

    const second = await recordPlatformStats({ at, fetchImpl: collectorFetch() });
    expect(second.inserted).toBe(0);
    expect(await rowCount(db, "platform_stats")).toBe(15);
  });

  it("groups the read per (platform, metric) with the latest value + a bounded series", async () => {
    const dayOne = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const dayTwo = new Date().toISOString();

    await recordPlatformStats({ at: dayOne, fetchImpl: collectorFetch() });
    await recordPlatformStats({ at: dayTwo, fetchImpl: collectorFetch() });

    const view = await listPlatformStats();
    expect(view.windowDays).toBe(90);

    const mixcloudFollowers = view.series.find(
      (series) => series.platform === "mixcloud" && series.metric === "followers",
    );

    expect(mixcloudFollowers).toBeDefined();
    expect(mixcloudFollowers?.points).toHaveLength(2);

    expect(mixcloudFollowers?.points[0]?.capturedAt).toBe(dayOne);
    expect(mixcloudFollowers?.points[1]?.capturedAt).toBe(dayTwo);
    expect(mixcloudFollowers?.latest).toBe(87);
    expect(mixcloudFollowers?.latestAt).toBe(dayTwo);

    const playlistSaves = view.series.find((series) => series.platform === "spotify_playlist");
    expect(playlistSaves?.latest).toBe(2);
  });

  it("bounds the series read to the requested window", async () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date().toISOString();

    await recordPlatformStats({ at: old, fetchImpl: collectorFetch() });
    await recordPlatformStats({ at: recent, fetchImpl: collectorFetch() });

    const view = await listPlatformStats(7);
    expect(view.windowDays).toBe(7);

    const mixcloudFollowers = view.series.find(
      (series) => series.platform === "mixcloud" && series.metric === "followers",
    );
    expect(mixcloudFollowers?.points).toHaveLength(1);
    expect(mixcloudFollowers?.points[0]?.capturedAt).toBe(recent);
  });
});
