import { getDb, typedRow } from "./db";
import { type FetchImpl, readEnvs, readOptionalEnv } from "./env";
import { logEvent } from "./log";
import { ApiError } from "./spotify";

const googleAuthBaseUrl = "https://accounts.google.com/o/oauth2/v2/auth";
const googleTokenUrl = "https://oauth2.googleapis.com/token";
const youtubeDataVideosUrl = "https://www.googleapis.com/youtube/v3/videos";
const youtubeAnalyticsReportsUrl = "https://youtubeanalytics.googleapis.com/v2/reports";

const youtubeScopes = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.force-ssl",

  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
];

type YouTubeTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
};

type YouTubeAuthRow = {
  access_token: string;
  refresh_token: string;
  expires_at: string;
};

export async function buildYouTubeAuthUrl(state: string): Promise<string> {
  const env = await readEnvs(["YOUTUBE_CLIENT_ID", "YOUTUBE_REDIRECT_URI"]);
  const params = new URLSearchParams({
    access_type: "offline",
    client_id: env.YOUTUBE_CLIENT_ID,

    prompt: "consent",
    redirect_uri: env.YOUTUBE_REDIRECT_URI,
    response_type: "code",
    scope: youtubeScopes.join(" "),
    state,
  });

  return `${googleAuthBaseUrl}?${params.toString()}`;
}

export async function exchangeCodeForYouTubeToken(code: string): Promise<void> {
  const env = await readEnvs(["YOUTUBE_REDIRECT_URI"]);
  const data = await requestToken({
    code,
    grant_type: "authorization_code",
    redirect_uri: env.YOUTUBE_REDIRECT_URI,
  });

  if (!data.refresh_token) {
    throw new Error("YouTube did not return a refresh token");
  }

  await upsertYouTubeAuth(data.access_token, data.refresh_token, data.expires_in, data.scope);
}

export async function getYouTubeAccessToken(): Promise<string> {
  const db = await getDb();
  const result = await db.execute({
    args: ["youtube"],
    sql: `select access_token, refresh_token, expires_at
      from youtube_auth
      where service = ?
      limit 1`,
  });
  const auth = typedRow<YouTubeAuthRow>(result.rows);

  if (!auth) {
    throw new ApiError("youtube_not_authenticated", "YouTube is not authenticated", 400);
  }

  const expiresAt = new Date(auth.expires_at).getTime();
  const refreshWindowMs = 60_000;

  if (expiresAt - refreshWindowMs > Date.now()) {
    return auth.access_token;
  }

  const data = await requestToken({
    client_id: (await readEnvs(["YOUTUBE_CLIENT_ID"])).YOUTUBE_CLIENT_ID,
    client_secret: (await readEnvs(["YOUTUBE_CLIENT_SECRET"])).YOUTUBE_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: auth.refresh_token,
  });

  const refreshToken = data.refresh_token ?? auth.refresh_token;
  await upsertYouTubeAuth(data.access_token, refreshToken, data.expires_in, data.scope);

  return data.access_token;
}

export function extractYoutubeChannelId(url: string): string | null {
  const match = url.match(/\/channel\/(UC[A-Za-z0-9_-]+)/);

  return match?.[1] ?? null;
}

const YOUTUBE_DATA_BATCH = 50;

const YOUTUBE_ANALYTICS_START = "2026-01-01";

export type YouTubeVideoMetrics = {
  averageViewDurationSeconds: null | number;

  averageViewPercentage: null | number;
  comments: null | number;

  id: string;
  likes: null | number;
  views: null | number;

  watchTimeSeconds: null | number;
};

export function extractYoutubeVideoId(url: string): null | string {
  const patterns = [
    /\/shorts\/([A-Za-z0-9_-]{11})/,
    /[?&]v=([A-Za-z0-9_-]{11})/,
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /\/embed\/([A-Za-z0-9_-]{11})/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);

    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

export async function hasYouTubeAuth(): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute({
    args: ["youtube"],
    sql: `select service from youtube_auth where service = ? limit 1`,
  });

  return result.rows.length > 0;
}

function numberOrNull(value: unknown): null | number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];

  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }

  return chunks;
}

type YouTubeStatistics = { comments: null | number; likes: null | number; views: null | number };

async function fetchYouTubeStatisticsBatch(
  ids: string[],
  accessToken: string,
  fetchImpl: FetchImpl,
): Promise<Map<string, YouTubeStatistics>> {
  const url = `${youtubeDataVideosUrl}?part=statistics&id=${ids.join(",")}&maxResults=${YOUTUBE_DATA_BATCH}`;
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    method: "GET",
  });

  if (!response.ok) {
    const body = await response.text();

    throw new ApiError(
      "youtube_videos_list_failed",
      `YouTube videos.list failed: ${response.status} ${response.statusText}${body ? ` - ${body.slice(0, 200)}` : ""}`,
      400,
    );
  }

  const json = (await response.json()) as {
    items?: Array<{ id?: unknown; statistics?: Record<string, unknown> }>;
  };
  const stats = new Map<string, YouTubeStatistics>();

  for (const item of json.items ?? []) {
    if (typeof item.id !== "string") {
      continue;
    }

    stats.set(item.id, {
      comments: numberOrNull(item.statistics?.commentCount),
      likes: numberOrNull(item.statistics?.likeCount),
      views: numberOrNull(item.statistics?.viewCount),
    });
  }

  return stats;
}

type YouTubeRetention = {
  averageViewDurationSeconds: null | number;
  averageViewPercentage: null | number;
  watchTimeSeconds: null | number;
};

async function fetchYouTubeRetention(
  ids: string[],
  accessToken: string,
  fetchImpl: FetchImpl,
  endDate: string,
): Promise<Map<string, YouTubeRetention>> {
  const params = new URLSearchParams({
    dimensions: "video",
    endDate,

    filters: `video==${ids.join(",")}`,
    ids: "channel==MINE",
    maxResults: String(ids.length),
    metrics: "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage",
    startDate: YOUTUBE_ANALYTICS_START,
  });
  const response = await fetchImpl(`${youtubeAnalyticsReportsUrl}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    method: "GET",
  });

  if (!response.ok) {
    const body = await response.text();

    throw new ApiError(
      "youtube_analytics_failed",
      `YouTube analytics reports failed: ${response.status} ${response.statusText}${body ? ` - ${body.slice(0, 200)}` : ""}`,
      400,
    );
  }

  const json = (await response.json()) as {
    columnHeaders?: Array<{ name?: string }>;
    rows?: unknown[][];
  };
  const headers = (json.columnHeaders ?? []).map((header) => header.name ?? "");
  const col = (name: string): number => headers.indexOf(name);
  const videoCol = col("video");
  const retention = new Map<string, YouTubeRetention>();

  if (videoCol < 0) {
    return retention;
  }

  const minutesCol = col("estimatedMinutesWatched");
  const durationCol = col("averageViewDuration");
  const percentCol = col("averageViewPercentage");

  for (const row of json.rows ?? []) {
    const videoId = row[videoCol];

    if (typeof videoId !== "string") {
      continue;
    }

    const minutes = minutesCol >= 0 ? numberOrNull(row[minutesCol]) : null;

    retention.set(videoId, {
      averageViewDurationSeconds: durationCol >= 0 ? numberOrNull(row[durationCol]) : null,
      averageViewPercentage: percentCol >= 0 ? numberOrNull(row[percentCol]) : null,
      watchTimeSeconds: minutes === null ? null : Math.round(minutes * 60),
    });
  }

  return retention;
}

export async function collectYouTubeVideoMetrics(
  videoIds: string[],
  options: { fetchImpl?: FetchImpl; getAccessToken?: () => Promise<string>; now?: Date } = {},
): Promise<null | YouTubeVideoMetrics[]> {
  const fetchImpl = options.fetchImpl ?? fetch;

  const getAccessToken = options.getAccessToken ?? getYouTubeAccessToken;
  const clientId = await readOptionalEnv("YOUTUBE_CLIENT_ID");
  const clientSecret = await readOptionalEnv("YOUTUBE_CLIENT_SECRET");

  if (!clientId || !clientSecret || !(await hasYouTubeAuth())) {
    return null;
  }

  if (videoIds.length === 0) {
    return [];
  }

  const accessToken = await getAccessToken();

  const stats = new Map<string, YouTubeStatistics>();

  for (const ids of chunk(videoIds, YOUTUBE_DATA_BATCH)) {
    const batch = await fetchYouTubeStatisticsBatch(ids, accessToken, fetchImpl);

    for (const [id, value] of batch) {
      stats.set(id, value);
    }
  }

  let retention = new Map<string, YouTubeRetention>();

  try {
    const endDate = (options.now ?? new Date()).toISOString().slice(0, 10);
    retention = await fetchYouTubeRetention(videoIds, accessToken, fetchImpl, endDate);
  } catch (error) {
    logEvent("warn", "youtube-metrics.analytics-failed", { error });
  }

  return videoIds
    .filter((id) => stats.has(id))
    .map((id) => {
      const stat = stats.get(id);
      const ret = retention.get(id);

      return {
        averageViewDurationSeconds: ret?.averageViewDurationSeconds ?? null,
        averageViewPercentage: ret?.averageViewPercentage ?? null,
        comments: stat?.comments ?? null,
        id,
        likes: stat?.likes ?? null,
        views: stat?.views ?? null,
        watchTimeSeconds: ret?.watchTimeSeconds ?? null,
      };
    });
}

async function requestToken(params: Record<string, string>): Promise<YouTubeTokenResponse> {
  const env = await readEnvs(["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET"]);
  const response = await fetch(googleTokenUrl, {
    body: new URLSearchParams({
      client_id: env.YOUTUBE_CLIENT_ID,
      client_secret: env.YOUTUBE_CLIENT_SECRET,
      ...params,
    }),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  });

  if (!response.ok) {
    const body = await response.text();
    const detail = body
      ? `${response.status} ${response.statusText} - ${body}`
      : `${response.status} ${response.statusText}`;

    throw new ApiError("youtube_token_failed", `YouTube token request failed: ${detail}`, 400);
  }

  return (await response.json()) as YouTubeTokenResponse;
}

async function upsertYouTubeAuth(
  accessToken: string,
  refreshToken: string,
  expiresIn: number,
  scope: string,
): Promise<void> {
  const db = await getDb();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresIn * 1000);

  await db.execute({
    args: ["youtube", accessToken, refreshToken, expiresAt.toISOString(), scope, now.toISOString()],
    sql: `insert into youtube_auth (
        service,
        access_token,
        refresh_token,
        expires_at,
        scope,
        updated_at
      ) values (?, ?, ?, ?, ?, ?)
      on conflict(service) do update set
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        expires_at = excluded.expires_at,
        scope = excluded.scope,
        updated_at = excluded.updated_at`,
  });
}
