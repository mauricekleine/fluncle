import { getDb, typedRows } from "./db";
import { type FetchImpl, readOptionalEnv } from "./env";
import { logEvent } from "./log";
import { getPostizPlatformAnalytics, type PostizMetric } from "./postiz";
import { countSegmentRecipients } from "./resend";
import { clampSnapshotWindow } from "./snapshot-window";
import { ApiError, fetchPlaylistFollowerCount } from "./spotify";
import { getTwitchAccessToken, readTwitchClientId } from "./twitch";

export type { FetchImpl };

export type PlatformMetric = { metric: string; value: number };

export type PlatformStatRow = {
  capturedAt: string;
  id: string;
  metric: string;
  platform: string;
  value: number;
};

export type CollectedPlatform = { metrics: string[]; platform: string };

export type SkippedPlatform = {
  kind: "empty" | "unconfigured";
  platform: string;
  reason: string;
};

export type FailedPlatform = { platform: string; reason: string };

export type PlatformStatsCollection = {
  collected: CollectedPlatform[];
  failed: FailedPlatform[];
  rows: PlatformStatRow[];
  skipped: SkippedPlatform[];
};

export type PlatformStatsRecordResult = {
  collected: CollectedPlatform[];
  failed: FailedPlatform[];
  inserted: number;
  skipped: SkippedPlatform[];
};

class PlatformSkipError extends Error {
  kind: SkippedPlatform["kind"];

  constructor(kind: SkippedPlatform["kind"], message: string) {
    super(message);
    this.name = "PlatformSkipError";
    this.kind = kind;
  }
}

function skipPlatform(kind: SkippedPlatform["kind"], reason: string): never {
  throw new PlatformSkipError(kind, reason);
}

const USER_AGENT = "Fluncle/1.0 (+https://www.fluncle.com)";

const MIXCLOUD_USER = "fluncle";
const BLUESKY_ACTOR = "fluncle.com";
const GITHUB_REPO = "mauricekleine/fluncle";
const NPM_PACKAGE = "fluncle";
const LASTFM_USER = "fluncle";
const APPSTORE_BUNDLE_ID = "com.fluncle.app";
const YOUTUBE_HANDLE = "@fluncle";

export function requireCount(value: unknown, label: string): number {
  const parsed = typeof value === "string" ? Number(value) : value;

  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} is missing or non-numeric`);
  }

  return Math.trunc(parsed);
}

export async function collectMixcloud(fetchImpl: FetchImpl): Promise<PlatformMetric[]> {
  const response = await fetchImpl(`https://api.mixcloud.com/${MIXCLOUD_USER}/`);

  if (!response.ok) {
    throw new Error(`Mixcloud responded ${response.status}`);
  }

  const data = (await response.json()) as {
    cloudcast_count?: unknown;
    follower_count?: unknown;
    listen_count?: unknown;
  };

  return [
    { metric: "followers", value: requireCount(data.follower_count, "Mixcloud follower_count") },
    { metric: "listens", value: requireCount(data.listen_count, "Mixcloud listen_count") },
    { metric: "uploads", value: requireCount(data.cloudcast_count, "Mixcloud cloudcast_count") },
  ];
}

export async function collectBluesky(fetchImpl: FetchImpl): Promise<PlatformMetric[]> {
  const response = await fetchImpl(
    `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(BLUESKY_ACTOR)}`,
  );

  if (!response.ok) {
    throw new Error(`Bluesky responded ${response.status}`);
  }

  const data = (await response.json()) as { followersCount?: unknown; postsCount?: unknown };

  return [
    { metric: "followers", value: requireCount(data.followersCount, "Bluesky followersCount") },
    { metric: "posts", value: requireCount(data.postsCount, "Bluesky postsCount") },
  ];
}

export async function collectGithub(fetchImpl: FetchImpl): Promise<PlatformMetric[]> {
  const token = await readOptionalEnv("GITHUB_TOKEN");
  const response = await fetchImpl(`https://api.github.com/repos/${GITHUB_REPO}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": USER_AGENT,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub responded ${response.status}`);
  }

  const data = (await response.json()) as { stargazers_count?: unknown };

  return [
    { metric: "stars", value: requireCount(data.stargazers_count, "GitHub stargazers_count") },
  ];
}

export async function collectNpm(fetchImpl: FetchImpl): Promise<PlatformMetric[]> {
  const response = await fetchImpl(
    `https://api.npmjs.org/downloads/point/last-week/${NPM_PACKAGE}`,
  );

  if (!response.ok) {
    throw new Error(`npm responded ${response.status}`);
  }

  const data = (await response.json()) as { downloads?: unknown };

  return [{ metric: "downloads_weekly", value: requireCount(data.downloads, "npm downloads") }];
}

export async function collectAppStore(fetchImpl: FetchImpl): Promise<PlatformMetric[]> {
  const response = await fetchImpl(
    `https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(APPSTORE_BUNDLE_ID)}`,
  );

  if (!response.ok) {
    throw new Error(`App Store responded ${response.status}`);
  }

  const data = (await response.json()) as {
    resultCount?: number;
    results?: { userRatingCount?: unknown }[];
  };

  if (!data.resultCount || data.resultCount === 0 || !data.results?.[0]) {
    skipPlatform("empty", "App Store app is not live yet (resultCount 0)");
  }

  return [
    {
      metric: "rating_count",
      value: requireCount(data.results[0].userRatingCount, "App Store userRatingCount"),
    },
  ];
}

export async function collectLastfm(fetchImpl: FetchImpl): Promise<PlatformMetric[]> {
  const apiKey = await readOptionalEnv("LASTFM_API_KEY");

  if (!apiKey) {
    skipPlatform("unconfigured", "LASTFM_API_KEY is not set");
  }

  const root = "https://ws.audioscrobbler.com/2.0/";
  const infoResponse = await fetchImpl(
    `${root}?method=user.getinfo&user=${LASTFM_USER}&api_key=${encodeURIComponent(apiKey)}&format=json`,
    { headers: { "User-Agent": USER_AGENT } },
  );

  if (!infoResponse.ok) {
    throw new Error(`Last.fm user.getInfo responded ${infoResponse.status}`);
  }

  const info = (await infoResponse.json()) as { user?: { playcount?: unknown } };

  const lovedResponse = await fetchImpl(
    `${root}?method=user.getlovedtracks&user=${LASTFM_USER}&api_key=${encodeURIComponent(apiKey)}&format=json&limit=1`,
    { headers: { "User-Agent": USER_AGENT } },
  );

  if (!lovedResponse.ok) {
    throw new Error(`Last.fm user.getLovedTracks responded ${lovedResponse.status}`);
  }

  const loved = (await lovedResponse.json()) as {
    lovedtracks?: { "@attr"?: { total?: unknown } };
  };

  return [
    { metric: "scrobbles", value: requireCount(info.user?.playcount, "Last.fm playcount") },
    {
      metric: "loved_tracks",
      value: requireCount(loved.lovedtracks?.["@attr"]?.total, "Last.fm loved @attr.total"),
    },
  ];
}

export async function collectTelegram(fetchImpl: FetchImpl): Promise<PlatformMetric[]> {
  const token = await readOptionalEnv("TELEGRAM_BOT_TOKEN");
  const channelId = await readOptionalEnv("TELEGRAM_CHANNEL_ID");

  if (!token || !channelId) {
    skipPlatform("unconfigured", "TELEGRAM_BOT_TOKEN / TELEGRAM_CHANNEL_ID are not set");
  }

  const response = await fetchImpl(
    `https://api.telegram.org/bot${token}/getChatMemberCount?chat_id=${encodeURIComponent(channelId)}`,
  );

  if (!response.ok) {
    throw new Error(`Telegram responded ${response.status}`);
  }

  const data = (await response.json()) as { ok?: boolean; result?: unknown };

  if (!data.ok) {
    throw new Error("Telegram getChatMemberCount returned ok:false");
  }

  return [{ metric: "audience", value: requireCount(data.result, "Telegram member count") }];
}

export async function collectNewsletter(): Promise<PlatformMetric[]> {
  const [apiKey, segmentId] = await Promise.all([
    readOptionalEnv("RESEND_API_KEY"),
    readOptionalEnv("RESEND_SEGMENT_ID"),
  ]);

  if (!apiKey || !segmentId) {
    skipPlatform("unconfigured", "RESEND_API_KEY / RESEND_SEGMENT_ID are not set");
  }

  const count = await countSegmentRecipients();

  if (count === null) {
    throw new Error("newsletter recipient count is unavailable");
  }

  return [{ metric: "audience", value: requireCount(count, "newsletter recipient count") }];
}

export async function collectSpotifyPlaylist(): Promise<PlatformMetric[]> {
  const playlistId = await readOptionalEnv("SPOTIFY_PLAYLIST_ID");

  if (!playlistId) {
    skipPlatform("unconfigured", "SPOTIFY_PLAYLIST_ID is not set");
  }

  let total: number;

  try {
    total = await fetchPlaylistFollowerCount();
  } catch (error) {
    if (error instanceof ApiError && error.code === "spotify_not_authenticated") {
      skipPlatform("unconfigured", error.message);
    }

    throw error;
  }

  return [{ metric: "playlist_saves", value: requireCount(total, "Spotify followers.total") }];
}

export async function collectYoutube(fetchImpl: FetchImpl): Promise<PlatformMetric[]> {
  const key = await readOptionalEnv("YOUTUBE_API_KEY");

  if (!key) {
    skipPlatform("unconfigured", "YOUTUBE_API_KEY is not set");
  }

  const response = await fetchImpl(
    `https://www.googleapis.com/youtube/v3/channels?part=statistics&forHandle=${encodeURIComponent(YOUTUBE_HANDLE)}&key=${encodeURIComponent(key)}`,
  );

  if (!response.ok) {
    throw new Error(`YouTube responded ${response.status}`);
  }

  const data = (await response.json()) as {
    items?: { statistics?: { subscriberCount?: unknown; viewCount?: unknown } }[];
  };
  const statistics = data.items?.[0]?.statistics;

  if (!statistics) {
    throw new Error("YouTube channels.list returned no channel for the handle");
  }

  return [
    {
      metric: "subscribers",
      value: requireCount(statistics.subscriberCount, "YouTube subscriberCount"),
    },
    { metric: "views", value: requireCount(statistics.viewCount, "YouTube viewCount") },
  ];
}

export async function collectTwitchFollowers(
  fetchImpl: FetchImpl,
  accessToken: string,
  clientId: string,
): Promise<PlatformMetric[]> {
  const headers = { Authorization: `Bearer ${accessToken}`, "Client-Id": clientId };
  const usersResponse = await fetchImpl("https://api.twitch.tv/helix/users", { headers });

  if (!usersResponse.ok) {
    throw new Error(`Twitch users responded ${usersResponse.status}`);
  }

  const users = (await usersResponse.json()) as { data?: { id?: unknown }[] };
  const broadcasterId = users.data?.[0]?.id;

  if (typeof broadcasterId !== "string" || broadcasterId.length === 0) {
    throw new Error("Twitch users returned no broadcaster id");
  }

  const followersResponse = await fetchImpl(
    `https://api.twitch.tv/helix/channels/followers?broadcaster_id=${encodeURIComponent(broadcasterId)}`,
    { headers },
  );

  if (!followersResponse.ok) {
    throw new Error(`Twitch channels/followers responded ${followersResponse.status}`);
  }

  const data = (await followersResponse.json()) as { total?: unknown };

  return [{ metric: "followers", value: requireCount(data.total, "Twitch followers total") }];
}

export async function collectTwitch(fetchImpl: FetchImpl): Promise<PlatformMetric[]> {
  let accessToken: string;
  let clientId: string;

  try {
    [accessToken, clientId] = await Promise.all([getTwitchAccessToken(), readTwitchClientId()]);
  } catch (error) {
    if (
      error instanceof ApiError &&
      (error.code === "twitch_not_authenticated" || error.code === "twitch_not_configured")
    ) {
      skipPlatform("unconfigured", error.message);
    }

    throw error;
  }

  return collectTwitchFollowers(fetchImpl, accessToken, clientId);
}

export function mapPostizMetrics(
  metrics: { label: string; latestTotal: number }[],
  labelMap: Record<string, string>,
  platform: string,
): PlatformMetric[] {
  const out: PlatformMetric[] = [];

  for (const entry of metrics) {
    const metric = labelMap[entry.label];

    if (metric && entry.latestTotal >= 0) {
      out.push({ metric, value: entry.latestTotal });
    }
  }

  if (out.length === 0) {
    if (metrics.length === 0) {
      skipPlatform("empty", `${platform}: Postiz returned no analytics metrics`);
    }

    throw new Error(`${platform}: no mapped metrics in the Postiz analytics payload`);
  }

  return out;
}

export async function collectTiktok(fetchImpl: FetchImpl): Promise<PlatformMetric[]> {
  const key = await readOptionalEnv("POSTIZ_API_KEY");

  if (!key) {
    skipPlatform("unconfigured", "POSTIZ_API_KEY is not set");
  }

  let metrics: PostizMetric[];

  try {
    metrics = await getPostizPlatformAnalytics(["tiktok"], 7, fetchImpl);
  } catch (error) {
    if (error instanceof ApiError && error.code === "no_integration") {
      skipPlatform("unconfigured", error.message);
    }

    throw error;
  }

  return mapPostizMetrics(
    metrics,
    { Followers: "followers", "Total Likes": "likes", Views: "views" },
    "tiktok",
  );
}

export async function collectInstagram(fetchImpl: FetchImpl): Promise<PlatformMetric[]> {
  const key = await readOptionalEnv("POSTIZ_API_KEY");

  if (!key) {
    skipPlatform("unconfigured", "POSTIZ_API_KEY is not set");
  }

  let metrics: PostizMetric[];

  try {
    metrics = await getPostizPlatformAnalytics(["instagram-standalone", "instagram"], 7, fetchImpl);
  } catch (error) {
    if (error instanceof ApiError && error.code === "no_integration") {
      skipPlatform("unconfigured", error.message);
    }

    throw error;
  }

  return mapPostizMetrics(metrics, { Views: "views" }, "instagram");
}

type PlatformFetcher = {
  collect: (fetchImpl: FetchImpl) => Promise<PlatformMetric[]>;
  platform: string;
};

const PLATFORM_FETCHERS: PlatformFetcher[] = [
  { collect: collectMixcloud, platform: "mixcloud" },
  { collect: collectBluesky, platform: "bluesky" },
  { collect: collectGithub, platform: "github" },
  { collect: collectNpm, platform: "npm" },
  { collect: collectLastfm, platform: "lastfm" },
  { collect: collectAppStore, platform: "appstore" },
  { collect: collectTelegram, platform: "telegram" },
  { collect: () => collectNewsletter(), platform: "newsletter" },
  { collect: () => collectSpotifyPlaylist(), platform: "spotify_playlist" },
  { collect: collectYoutube, platform: "youtube" },

  { collect: collectTiktok, platform: "tiktok" },
  { collect: collectInstagram, platform: "instagram" },

  { collect: collectTwitch, platform: "twitch" },
];

export async function collectPlatformStats(
  options: { at?: string; fetchImpl?: FetchImpl } = {},
): Promise<PlatformStatsCollection> {
  const at = options.at ?? new Date().toISOString();
  const day = at.slice(0, 10);
  const fetchImpl = options.fetchImpl ?? fetch;

  const rows: PlatformStatRow[] = [];
  const collected: CollectedPlatform[] = [];
  const failed: FailedPlatform[] = [];
  const skipped: SkippedPlatform[] = [];

  for (const { collect, platform } of PLATFORM_FETCHERS) {
    try {
      const metrics = await collect(fetchImpl);

      if (metrics.length === 0) {
        logEvent("warn", "platform-stats.collect-empty", { platform });
        skipped.push({ kind: "empty", platform, reason: "no metrics returned" });
        continue;
      }

      for (const metric of metrics) {
        rows.push({
          capturedAt: at,
          id: `${platform}:${metric.metric}:${day}`,
          metric: metric.metric,
          platform,
          value: metric.value,
        });
      }

      collected.push({ metrics: metrics.map((metric) => metric.metric), platform });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      if (error instanceof PlatformSkipError) {
        logEvent("warn", "platform-stats.collect-skipped", { error, platform });
        skipped.push({ kind: error.kind, platform, reason });
      } else {
        logEvent("warn", "platform-stats.collect-failed", { error, platform });
        failed.push({ platform, reason });
      }
    }
  }

  return { collected, failed, rows, skipped };
}

export async function insertPlatformStats(rows: PlatformStatRow[]): Promise<number> {
  if (rows.length === 0) {
    return 0;
  }

  const db = await getDb();
  const placeholders = rows.map(() => "(?, ?, ?, ?, ?)").join(", ");
  const args: (number | string)[] = [];

  for (const row of rows) {
    args.push(row.id, row.platform, row.metric, row.value, row.capturedAt);
  }

  const result = await db.execute({
    args,
    sql: `insert into platform_stats (id, platform, metric, value, captured_at)
            values ${placeholders}
            on conflict(id) do nothing`,
  });

  return result.rowsAffected;
}

export async function recordPlatformStats(
  options: { at?: string; fetchImpl?: FetchImpl } = {},
): Promise<PlatformStatsRecordResult> {
  const collection = await collectPlatformStats(options);
  const inserted = await insertPlatformStats(collection.rows);

  return {
    collected: collection.collected,
    failed: collection.failed,
    inserted,
    skipped: collection.skipped,
  };
}

export type PlatformStatPoint = { capturedAt: string; value: number };

export type PlatformStatSeries = {
  latest: number;
  latestAt: string;
  metric: string;
  platform: string;
  points: PlatformStatPoint[];
};

export type PlatformStatsView = {
  series: PlatformStatSeries[];
  windowDays: number;
};

type PlatformStatDbRow = {
  captured_at: string;
  metric: string;
  platform: string;
  value: number;
};

export async function listPlatformStats(windowDays?: number): Promise<PlatformStatsView> {
  const window = clampSnapshotWindow(windowDays);
  const since = new Date(Date.now() - window * 24 * 60 * 60 * 1000).toISOString();
  const db = await getDb();

  const result = await db.execute({
    args: [since],
    sql: `select platform, metric, value, captured_at
            from platform_stats
           where captured_at >= ?
           order by platform asc, metric asc, captured_at asc`,
  });

  const byKey = new Map<string, PlatformStatSeries>();

  for (const row of typedRows<PlatformStatDbRow>(result.rows)) {
    const key = `${row.platform}:${row.metric}`;
    const point: PlatformStatPoint = { capturedAt: row.captured_at, value: row.value };
    const existing = byKey.get(key);

    if (existing) {
      existing.points.push(point);

      existing.latest = row.value;
      existing.latestAt = row.captured_at;
    } else {
      byKey.set(key, {
        latest: row.value,
        latestAt: row.captured_at,
        metric: row.metric,
        platform: row.platform,
        points: [point],
      });
    }
  }

  return { series: [...byKey.values()], windowDays: window };
}
