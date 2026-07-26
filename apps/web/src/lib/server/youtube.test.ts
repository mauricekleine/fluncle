// Two things are proven here:
//
//   1. `extractYoutubeChannelId` / `extractYoutubeVideoId` — PURE, network-free lifts off a stored
//      URL. The channel lift pulls a `UC…` id from a `…/channel/UC…` URL; the video lift pulls the
//      native 11-char id from the shapes our own posts land as (`/shorts/<id>`, `watch?v=<id>`,
//      `youtu.be/<id>`, `/embed/<id>`). Both return `null` for anything else.
//   2. `collectYouTubeVideoMetrics` — the per-video metrics reader (Wave 2), proven against the REAL
//      migrated schema on an in-memory libSQL engine plus injected fetch. What is easy to get wrong:
//      the no-op GATE (a clean `null` when unconfigured OR unconnected), the Data-API + Analytics
//      MERGE (public counters from one host, retention from the other, keyed by video id), and the
//      BEST-EFFORT Analytics leg (a lagging/failed report leaves retention null but keeps the stats).

import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => holder.db };
});

import { createIntegrationDb } from "./integration-db";
import {
  collectYouTubeVideoMetrics,
  extractYoutubeChannelId,
  extractYoutubeVideoId,
  hasYouTubeAuth,
} from "./youtube";

describe("extractYoutubeChannelId", () => {
  it("extracts the UC… id from a /channel/UC… URL", () => {
    expect(
      extractYoutubeChannelId("https://www.youtube.com/channel/UCq-Fj5jknLsUf-MWSy4_brA"),
    ).toBe("UCq-Fj5jknLsUf-MWSy4_brA");
  });

  it("extracts from a /channel/UC… URL with a trailing path or query", () => {
    expect(
      extractYoutubeChannelId("https://youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw/videos?foo=1"),
    ).toBe("UC_x5XG1OV2P6uZZ5FSM9Ttw");
  });

  it("returns null for a /user/<name> URL (needs an API lookup, out of scope)", () => {
    expect(extractYoutubeChannelId("https://www.youtube.com/user/someartist")).toBeNull();
  });

  it("returns null for a /@handle URL (needs an API lookup, out of scope)", () => {
    expect(extractYoutubeChannelId("https://www.youtube.com/@someartist")).toBeNull();
  });

  it("returns null for a non-channel YouTube URL (a /watch link)", () => {
    expect(extractYoutubeChannelId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBeNull();
  });

  it("returns null for a channel path that is not a UC… id", () => {
    // Only the canonical `UC…` id form is a usable channel id for yt-dlp matching.
    expect(extractYoutubeChannelId("https://www.youtube.com/channel/HCabcdef")).toBeNull();
  });

  it("returns null for junk / an empty string", () => {
    expect(extractYoutubeChannelId("")).toBeNull();
    expect(extractYoutubeChannelId("not a url at all")).toBeNull();
    expect(extractYoutubeChannelId("https://open.spotify.com/artist/abc")).toBeNull();
  });
});

describe("extractYoutubeVideoId", () => {
  const cases: Array<{ expected: null | string; label: string; url: string }> = [
    {
      expected: "dQw4w9WgXcQ",
      label: "the canonical /shorts/<id> form our own posts land as",
      url: "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    },
    {
      expected: "dQw4w9WgXcQ",
      label: "a /shorts/<id> URL with a trailing query",
      url: "https://www.youtube.com/shorts/dQw4w9WgXcQ?feature=share",
    },
    {
      expected: "dQw4w9WgXcQ",
      label: "a classic watch?v=<id> URL",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    },
    {
      expected: "dQw4w9WgXcQ",
      label: "a watch URL with v= not first",
      url: "https://www.youtube.com/watch?feature=emb&v=dQw4w9WgXcQ&t=10",
    },
    {
      expected: "dQw4w9WgXcQ",
      label: "a youtu.be short link",
      url: "https://youtu.be/dQw4w9WgXcQ",
    },
    {
      expected: "dQw4w9WgXcQ",
      label: "an /embed/<id> URL",
      url: "https://www.youtube.com/embed/dQw4w9WgXcQ",
    },
    {
      expected: null,
      label: "a channel URL (no video id)",
      url: "https://www.youtube.com/channel/UCq-Fj5jknLsUf-MWSy4_brA",
    },
    { expected: null, label: "an empty string", url: "" },
    { expected: null, label: "junk", url: "not a url at all" },
  ];

  for (const { expected, label, url } of cases) {
    it(`${expected === null ? "returns null for" : "lifts the id from"} ${label}`, () => {
      expect(extractYoutubeVideoId(url)).toBe(expected);
    });
  }
});

// ── The reader (the gate + the Data/Analytics merge) ─────────────────────────────────────────────

let db: Client;

const NOW = new Date("2026-07-26T12:00:00.000Z");

// An injected token getter, so a test never touches the real refresh path (its expiry-vs-clock check
// made the pass environmental). The `seedAuth` row below still exists — it satisfies the DB-read
// connection gate (`hasYouTubeAuth`) — but this stub, not the network, supplies the access token.
const getAccessToken = () => Promise.resolve("test-token");

async function seedAuth(): Promise<void> {
  const iso = NOW.toISOString();
  await db.execute({
    args: [
      "youtube",
      "stored-access",
      "stored-refresh",
      new Date(NOW.getTime() + 10 * 60_000).toISOString(),
      "youtube.readonly yt-analytics.readonly",
      iso,
    ],
    sql: `insert into youtube_auth (service, access_token, refresh_token, expires_at, scope, updated_at)
          values (?, ?, ?, ?, ?, ?)`,
  });
}

/** A fetch stub routing by host: the Data API `videos` endpoint vs the Analytics `reports` endpoint. */
function fetchStub(handlers: {
  analytics?: (url: URL) => Response;
  data?: (url: URL) => Response;
}): typeof fetch {
  return vi.fn((input: Parameters<typeof fetch>[0]) => {
    // The reader always passes a string URL; narrow the full `RequestInfo | URL` type anyway.
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);

    if (url.hostname === "youtubeanalytics.googleapis.com") {
      if (!handlers.analytics) {
        throw new Error(`unexpected analytics call: ${url.toString()}`);
      }

      return Promise.resolve(handlers.analytics(url));
    }

    if (!handlers.data) {
      throw new Error(`unexpected data call: ${url.toString()}`);
    }

    return Promise.resolve(handlers.data(url));
  }) as unknown as typeof fetch;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}

beforeEach(async () => {
  db = await createIntegrationDb();
  holder.db = db;
  process.env.YOUTUBE_CLIENT_ID = "test-id";
  process.env.YOUTUBE_CLIENT_SECRET = "test-secret";
});

afterEach(() => {
  holder.db = undefined;
  delete process.env.YOUTUBE_CLIENT_ID;
  delete process.env.YOUTUBE_CLIENT_SECRET;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("collectYouTubeVideoMetrics (the gate + the merge)", () => {
  it("is a clean no-op (null) when the creds are unset", async () => {
    delete process.env.YOUTUBE_CLIENT_ID;
    const fetchImpl = vi.fn<typeof fetch>();

    expect(await collectYouTubeVideoMetrics(["v1"], { fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("is a clean no-op (null) when configured but NOT connected (no auth row)", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    expect(await hasYouTubeAuth()).toBe(false);
    expect(await collectYouTubeVideoMetrics(["v1"], { fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns [] for an empty id list without touching the network", async () => {
    await seedAuth();
    const fetchImpl = vi.fn<typeof fetch>();

    expect(await collectYouTubeVideoMetrics([], { fetchImpl })).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("merges Data-API counters with Analytics retention, keyed by video id", async () => {
    await seedAuth();

    const fetchImpl = fetchStub({
      analytics: () =>
        json({
          columnHeaders: [
            { name: "video" },
            { name: "views" },
            { name: "estimatedMinutesWatched" },
            { name: "averageViewDuration" },
            { name: "averageViewPercentage" },
          ],
          // v2 has no retention row yet (the ~2–3 day lag) — absent, so its retention stays null.
          rows: [["v1", 1500, 50, 30, 45.5]],
        }),
      data: () =>
        json({
          items: [
            { id: "v1", statistics: { commentCount: "3", likeCount: "20", viewCount: "1500" } },
            { id: "v2", statistics: { commentCount: "0", likeCount: "5", viewCount: "50" } },
          ],
        }),
    });

    const videos = await collectYouTubeVideoMetrics(["v1", "v2"], {
      fetchImpl,
      getAccessToken,
      now: NOW,
    });

    expect(videos).toEqual([
      {
        averageViewDurationSeconds: 30,
        averageViewPercentage: 45.5,
        comments: 3,
        id: "v1",
        likes: 20,
        views: 1500,
        // estimatedMinutesWatched (50) × 60.
        watchTimeSeconds: 3000,
      },
      {
        // No Analytics row for v2 yet → retention null, but the public counters still land.
        averageViewDurationSeconds: null,
        averageViewPercentage: null,
        comments: 0,
        id: "v2",
        likes: 5,
        views: 50,
        watchTimeSeconds: null,
      },
    ]);
  });

  it("sends the batch's ids to both endpoints and a broad channel-epoch window to Analytics", async () => {
    await seedAuth();

    let dataUrl: undefined | URL;
    let analyticsUrl: undefined | URL;
    const fetchImpl = fetchStub({
      analytics: (url) => {
        analyticsUrl = url;

        return json({ columnHeaders: [{ name: "video" }], rows: [] });
      },
      data: (url) => {
        dataUrl = url;

        return json({ items: [{ id: "v1", statistics: { viewCount: "1" } }] });
      },
    });

    await collectYouTubeVideoMetrics(["v1", "v2"], { fetchImpl, getAccessToken, now: NOW });

    expect(dataUrl?.searchParams.get("part")).toBe("statistics");
    expect(dataUrl?.searchParams.get("id")).toBe("v1,v2");
    expect(analyticsUrl?.searchParams.get("ids")).toBe("channel==MINE");
    expect(analyticsUrl?.searchParams.get("dimensions")).toBe("video");
    expect(analyticsUrl?.searchParams.get("filters")).toBe("video==v1,v2");
    expect(analyticsUrl?.searchParams.get("endDate")).toBe("2026-07-26");
    expect(analyticsUrl?.searchParams.get("metrics")).toContain("averageViewPercentage");
  });

  it("keeps the Data-API stats when the Analytics leg fails (best-effort retention)", async () => {
    await seedAuth();

    const fetchImpl = fetchStub({
      analytics: () => new Response("quota exceeded", { status: 403 }),
      data: () => json({ items: [{ id: "v1", statistics: { likeCount: "9", viewCount: "800" } }] }),
    });

    const videos = await collectYouTubeVideoMetrics(["v1"], {
      fetchImpl,
      getAccessToken,
      now: NOW,
    });

    expect(videos).toEqual([
      {
        averageViewDurationSeconds: null,
        averageViewPercentage: null,
        comments: null,
        id: "v1",
        likes: 9,
        views: 800,
        watchTimeSeconds: null,
      },
    ]);
  });

  it("omits an id the Data API did not return (a deleted/unavailable video)", async () => {
    await seedAuth();

    const fetchImpl = fetchStub({
      analytics: () => json({ columnHeaders: [{ name: "video" }], rows: [] }),
      data: () => json({ items: [{ id: "v1", statistics: { viewCount: "10" } }] }),
    });

    const videos = await collectYouTubeVideoMetrics(["v1", "gone"], {
      fetchImpl,
      getAccessToken,
      now: NOW,
    });

    expect(videos?.map((video) => video.id)).toEqual(["v1"]);
  });

  it("throws when the Data API itself fails (the caller catches + skips the YouTube half)", async () => {
    await seedAuth();

    const fetchImpl = fetchStub({
      data: () => new Response("boom", { status: 500 }),
    });

    await expect(
      collectYouTubeVideoMetrics(["v1"], { fetchImpl, getAccessToken, now: NOW }),
    ).rejects.toThrow(/videos\.list failed/);
  });
});
