// Our own YouTube OAuth + token machinery for mixtape video distribution. Mirrors
// the Spotify token path (spotify.ts): the durable refresh token lives in
// youtube_auth (server-side), and we mint a short-lived access token on demand —
// for the CLI's resumable upload PUT (the YouTube data PUT is NOT self-authorizing)
// and for the server-side unlisted→public flip (videos.update). Identity login is
// Spotify-only; YouTube is purely a distribution sink, so there's no login path.

import { getDb, typedRow } from "./db";
import { type FetchImpl, readEnvs, readOptionalEnv } from "./env";
import { logEvent } from "./log";
import { ApiError } from "./spotify";

const googleAuthBaseUrl = "https://accounts.google.com/o/oauth2/v2/auth";
const googleTokenUrl = "https://oauth2.googleapis.com/token";
const youtubeDataVideosUrl = "https://www.googleapis.com/youtube/v3/videos";
const youtubeAnalyticsReportsUrl = "https://youtubeanalytics.googleapis.com/v2/reports";

// youtube.upload covers videos.insert (incl. privacyStatus=unlisted at insert) +
// thumbnails.set; youtube.force-ssl is added only for the unlisted→public flip
// (videos.update). access_type=offline + prompt=consent guarantee a refresh token.
const youtubeScopes = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.force-ssl",
  // The metrics ledger's read side (Wave 2 of the reach loops): youtube.readonly for
  // videos.list statistics, yt-analytics.readonly for per-video retention/watch-time
  // (averageViewPercentage — the real short-form signal). Added ahead of the ingestion
  // slice so ONE operator re-consent covers it; harmless until the reader exists.
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
    // Force the consent screen so Google re-issues a refresh token even when the
    // operator has authorized before (it otherwise omits it on re-auth).
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

/**
 * A valid YouTube access token, refreshing via the stored refresh token when the
 * current one is within ~60s of expiry. Mirrors getSpotifyAccessToken.
 */
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

  // Google omits refresh_token on refresh; keep the stored one.
  const refreshToken = data.refresh_token ?? auth.refresh_token;
  await upsertYouTubeAuth(data.access_token, refreshToken, data.expires_in, data.scope);

  return data.access_token;
}

/**
 * Extract a stable YouTube channel id (`UC…`) from a stored social URL. ONLY the
 * `…/channel/UC…` shape yields a channel id directly from the URL; a `/user/<name>` or
 * `/@handle` URL needs an API lookup to resolve, so those return `null` here — as does
 * any URL with no `/channel/UC…` segment (a `/watch` link, junk). Used by the capture
 * queue's artist-own-channel trust signal, where an API round-trip per finding is off
 * the table.
 */
export function extractYoutubeChannelId(url: string): string | null {
  const match = url.match(/\/channel\/(UC[A-Za-z0-9_-]+)/);

  return match?.[1] ?? null;
}

// ── THE PER-VIDEO METRICS READER (Wave 2 of the reach loops) ─────────────────────────────────────
//
// The YouTube sibling of the TikTok Display-API half: for @fluncle's own YouTube posts it reads
// each video's OWN numbers and the social-metrics snapshot appends them under the `youtube_analytics`
// source. Two Google APIs, both on the consented read scopes:
//
//   - DATA API `videos.list?part=statistics` — the public counters (views/likes/comments). BATCHABLE:
//     up to 50 ids per call, and the call costs 1 quota unit REGARDLESS of how many ids ride it, so
//     the whole run's stats are a couple of cheap calls. This is the required base — if it throws the
//     caller skips the YouTube half.
//   - ANALYTICS API `reports?ids=channel==MINE` — the retention signal this slice exists for:
//     `averageViewPercentage` + `averageViewDuration` (and `estimatedMinutesWatched` for total watch
//     time), grouped per video via `dimensions=video` + `filters=video==<id,id,…>` (the docs allow up
//     to 500 ids in ONE grouped request — so this is ONE call for the run, not one per video). It is
//     BEST-EFFORT inside the reader: YouTube Analytics data lags ~2–3 days, so a just-posted video
//     has no retention row yet — an empty/failed Analytics read leaves those metrics null and the
//     Data-API stats still land. The cumulative averages we store are "as of today, best available";
//     a later day's snapshot carries the retention once YouTube backfills it (append-only, so the
//     series self-heals). A missing Analytics row is NOT an error.
//
// startDate is the channel epoch (`YOUTUBE_ANALYTICS_START`) so the cumulative averages cover the
// whole life of each video; endDate is today (UTC). Query shape verified against
// developers.google.com/youtube/analytics (July 2026).

/** Up to 50 ids per `videos.list` call (the Data API's documented batch limit). */
const YOUTUBE_DATA_BATCH = 50;

/** The channel epoch — a broad floor so each video's cumulative retention averages cover its whole
 *  life. @fluncle's YouTube channel predates nothing before 2026, so 2026-01-01 is a safe floor. */
const YOUTUBE_ANALYTICS_START = "2026-01-01";

/** One of @fluncle's own YouTube videos, reduced to the metrics the ledger stores. A metric the API
 *  did not report stays `null` (never 0 — a real zero and "unreported" must stay distinguishable).
 *  The retention trio (the `averageView*` + `watchTimeSeconds`) is null until YouTube Analytics
 *  catches up (~2–3 day lag). */
export type YouTubeVideoMetrics = {
  /** `averageViewDuration` — average playback length in whole seconds (retention: how long). */
  averageViewDurationSeconds: null | number;
  /** `averageViewPercentage` — 0–100, the fraction of the video watched (retention: what %). */
  averageViewPercentage: null | number;
  comments: null | number;
  /** The native YouTube video id — matched to a `social_posts.url` `/shorts/<id>` or `watch?v=<id>`. */
  id: string;
  likes: null | number;
  views: null | number;
  /** `estimatedMinutesWatched` × 60 — TOTAL watch time in whole seconds (a cumulative). */
  watchTimeSeconds: null | number;
};

/**
 * Extract the native YouTube video id from a stored `social_posts.url`. Fluncle's own posts land as
 * the canonical Shorts form (`…/shorts/<id>`, built by postiz.ts's `resolveSocialUrl`), but a
 * `watch?v=<id>` or `youtu.be/<id>` link resolves too. Returns `null` for any URL without a video id
 * (a channel link, junk). A YouTube id is 11 URL-safe base64 chars.
 */
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

/** Whether a YouTube auth row exists — the gate the metrics reader checks before attempting a fetch
 *  (the sibling of `hasTikTokAuth`). */
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

  // The Data API returns statistics as STRINGS ("1234"); the Analytics API returns numbers.
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

/** `GET videos.list?part=statistics` for one ≤50-id batch. Throws a clean `ApiError` on a non-2xx —
 *  the public counters are the reader's required base, so the caller skips the YouTube half if this
 *  fails. */
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

/**
 * `GET reports?ids=channel==MINE&dimensions=video&filters=video==<ids>` — the per-video retention
 * report, ONE grouped call for the whole batch. The response is column-oriented (`columnHeaders` +
 * `rows`), so we index by header name rather than positionally. Returns a per-video map; a video
 * with no row yet (the ~2–3 day Analytics lag) is simply absent (→ null retention downstream).
 */
async function fetchYouTubeRetention(
  ids: string[],
  accessToken: string,
  fetchImpl: FetchImpl,
  endDate: string,
): Promise<Map<string, YouTubeRetention>> {
  const params = new URLSearchParams({
    dimensions: "video",
    endDate,
    // Up to 500 ids in one grouped request (docs); we cap the run well under that.
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

/**
 * Read @fluncle's own YouTube videos' metrics for the given native video ids: the Data API's public
 * counters (required) merged with the Analytics API's retention (best-effort). Returns `null` — a
 * clean no-op, never a throw — when the leg is unconfigured (no creds) or not connected (no
 * `youtube_auth` row), so the social-metrics snapshot degrades exactly like the TikTok half. An empty
 * `videoIds` yields `[]`. A Data-API transport error PROPAGATES (the caller logs + skips the YouTube
 * half); an Analytics error is swallowed here (retention stays null), so a lagging report never costs
 * us the public stats.
 */
export async function collectYouTubeVideoMetrics(
  videoIds: string[],
  options: { fetchImpl?: FetchImpl; now?: Date } = {},
): Promise<null | YouTubeVideoMetrics[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const clientId = await readOptionalEnv("YOUTUBE_CLIENT_ID");
  const clientSecret = await readOptionalEnv("YOUTUBE_CLIENT_SECRET");

  // Unconfigured OR not yet connected → a clean no-op, never a throw.
  if (!clientId || !clientSecret || !(await hasYouTubeAuth())) {
    return null;
  }

  if (videoIds.length === 0) {
    return [];
  }

  const accessToken = await getYouTubeAccessToken();

  // The Data-API stats — the required base (chunked ≤50/call).
  const stats = new Map<string, YouTubeStatistics>();

  for (const ids of chunk(videoIds, YOUTUBE_DATA_BATCH)) {
    const batch = await fetchYouTubeStatisticsBatch(ids, accessToken, fetchImpl);

    for (const [id, value] of batch) {
      stats.set(id, value);
    }
  }

  // The Analytics retention — best-effort (the ~2–3 day lag + any transient failure leaves it null).
  let retention = new Map<string, YouTubeRetention>();

  try {
    const endDate = (options.now ?? new Date()).toISOString().slice(0, 10);
    retention = await fetchYouTubeRetention(videoIds, accessToken, fetchImpl, endDate);
  } catch (error) {
    logEvent("warn", "youtube-metrics.analytics-failed", { error });
  }

  // One row per video the Data API returned (a deleted/unavailable video is simply absent).
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
