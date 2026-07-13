import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb, rowCount } from "./integration-db";
import { type FetchImpl, listPlatformStats, recordPlatformStats } from "./platform-stats";

// THE /reach STORE, against the real schema. The collector + the two ops run against
// the real in-memory libSQL `platform_stats` table (the generated migration), so the
// three properties that matter are proven as SQL properties a mock could not:
//   - the daily-snapshot IDEMPOTENCE (a same-`at` re-collect re-inserts the same ids
//     and lands 0 — the ON CONFLICT(id) DO NOTHING discipline),
//   - the GROUPED read shape (per (platform, metric): latest + a bounded series), and
//   - per-platform SKIP ISOLATION (one platform's fetch faulting never drops another's
//     snapshot — the record_health per-probe discipline).
//
// The keyless + env-gated platforms are driven by an injected `fetchImpl`; the two
// module-backed platforms (spotify_playlist / newsletter) are mocked to return a
// number, so no real network is ever touched.

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

// A fake `fetch` covering every network platform. `failing` forces a platform's
// endpoint to a 500 so its best-effort skip can be asserted in isolation.
function collectorFetch(failing: Set<string> = new Set()): FetchImpl {
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
      return { body: { resultCount: 1, results: [{ userRatingCount: 7 }] }, match: "appstore" };
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
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_CHANNEL_ID: "@fluncle",
      YOUTUBE_API_KEY: "yt-key",
    };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("collects every Tier-1 platform and writes one row per (platform, metric)", async () => {
    const at = new Date().toISOString();
    const result = await recordPlatformStats({ at, fetchImpl: collectorFetch() });

    // 10 Tier-1 platforms, 15 metrics total (mixcloud 3, bluesky 2, youtube 2, lastfm 2,
    // the other six 1 each). The 3 Tier-2 platforms (twitch/tiktok/instagram) are DORMANT
    // — no stored token in this fresh db — so they skip cleanly and write nothing.
    expect(result.collected).toHaveLength(10);
    expect(result.inserted).toBe(15);
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

    // The Tier-2 legs skip (dormant), never faulting the snapshot — every skip carries a
    // reason and none contributed a row.
    const skippedPlatforms = result.skipped.map((entry) => entry.platform).sort();
    expect(skippedPlatforms).toEqual(["instagram", "tiktok", "twitch"]);
    for (const skip of result.skipped) {
      expect(skip.reason.length).toBeGreaterThan(0);
    }
  });

  it("isolates a single platform's fetch fault as a skip, never dropping the rest", async () => {
    const at = new Date().toISOString();
    const result = await recordPlatformStats({
      at,
      fetchImpl: collectorFetch(new Set(["github"])),
    });

    const githubSkip = result.skipped.find((entry) => entry.platform === "github");
    expect(githubSkip).toBeDefined();
    expect(githubSkip?.reason).toMatch(/GitHub responded 500/);

    // The other nine Tier-1 platforms still landed: 15 total metrics minus github's
    // single `stars`. (The 3 dormant Tier-2 legs skip too, but that is not this test's
    // subject — github's fault is isolated from the rest of the Tier-1 snapshot.)
    expect(result.collected).toHaveLength(9);
    expect(result.inserted).toBe(14);
    expect(result.collected.some((entry) => entry.platform === "github")).toBe(false);
  });

  it("is idempotent for a same-day re-collect (ON CONFLICT DO NOTHING)", async () => {
    const at = new Date().toISOString();

    const first = await recordPlatformStats({ at, fetchImpl: collectorFetch() });
    expect(first.inserted).toBe(15);

    // Same `at` → same yyyy-mm-dd → same ids → the retry writes zero.
    const second = await recordPlatformStats({ at, fetchImpl: collectorFetch() });
    expect(second.inserted).toBe(0);
    expect(await rowCount(db, "platform_stats")).toBe(15);
  });

  it("groups the read per (platform, metric) with the latest value + a bounded series", async () => {
    const dayOne = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const dayTwo = new Date().toISOString();

    // Two different days: different ids, so both land — a two-point series per metric.
    await recordPlatformStats({ at: dayOne, fetchImpl: collectorFetch() });
    await recordPlatformStats({ at: dayTwo, fetchImpl: collectorFetch() });

    const view = await listPlatformStats();
    expect(view.windowDays).toBe(90);

    const mixcloudFollowers = view.series.find(
      (series) => series.platform === "mixcloud" && series.metric === "followers",
    );

    expect(mixcloudFollowers).toBeDefined();
    expect(mixcloudFollowers?.points).toHaveLength(2);
    // Points arrive oldest-first; latest is the max captured_at.
    expect(mixcloudFollowers?.points[0]?.capturedAt).toBe(dayOne);
    expect(mixcloudFollowers?.points[1]?.capturedAt).toBe(dayTwo);
    expect(mixcloudFollowers?.latest).toBe(87);
    expect(mixcloudFollowers?.latestAt).toBe(dayTwo);

    // The spotify playlist's saves + the newsletter audience came through the mocked
    // module helpers, proving the module-backed platforms join the same read.
    const playlistSaves = view.series.find((series) => series.platform === "spotify_playlist");
    expect(playlistSaves?.latest).toBe(2);
  });

  it("bounds the series read to the requested window", async () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date().toISOString();

    await recordPlatformStats({ at: old, fetchImpl: collectorFetch() });
    await recordPlatformStats({ at: recent, fetchImpl: collectorFetch() });

    // A 7-day window excludes the 40-day-old snapshot entirely.
    const view = await listPlatformStats(7);
    expect(view.windowDays).toBe(7);

    const mixcloudFollowers = view.series.find(
      (series) => series.platform === "mixcloud" && series.metric === "followers",
    );
    expect(mixcloudFollowers?.points).toHaveLength(1);
    expect(mixcloudFollowers?.points[0]?.capturedAt).toBe(recent);
  });
});
