import { getDb, typedRow } from "./db";
import { type FetchImpl, readOptionalEnv } from "./env";
import { ApiError } from "./spotify";

const tiktokAuthorizeUrl = "https://www.tiktok.com/v2/auth/authorize/";
const tiktokTokenUrl = "https://open.tiktokapis.com/v2/oauth/token/";
const tiktokVideoListUrl = "https://open.tiktokapis.com/v2/video/list/";

const tiktokScopes = ["user.info.basic", "video.list"];

const tiktokVideoFields = [
  "id",
  "create_time",
  "share_url",
  "view_count",
  "like_count",
  "comment_count",
  "share_count",
];

const TIKTOK_MAX_COUNT = 20;
export const TIKTOK_PAGE_BUDGET = 10;

type TikTokTokenResponse = {
  access_token: string;
  expires_in: number;
  open_id?: string;
  refresh_token?: string;

  scope?: string;
  token_type?: string;
};

type TikTokAuthRow = {
  access_token: string;
  expires_at: string;
  refresh_token: string;
};

type TikTokVideoRaw = {
  comment_count?: unknown;
  id?: unknown;
  like_count?: unknown;
  share_count?: unknown;
  view_count?: unknown;
};

type TikTokVideoListResponse = {
  data?: {
    cursor?: number;
    has_more?: boolean;
    videos?: TikTokVideoRaw[];
  };
  error?: {
    code?: string;
    log_id?: string;
    message?: string;
  };
};

export type TikTokVideoMetrics = {
  comments: null | number;

  id: string;
  likes: null | number;
  shares: null | number;
  views: null | number;
};

async function readTikTokCreds(): Promise<{ clientKey: string; clientSecret: string }> {
  const clientKey = await readOptionalEnv("TIKTOK_CLIENT_KEY");
  const clientSecret = await readOptionalEnv("TIKTOK_CLIENT_SECRET");

  if (!clientKey || !clientSecret) {
    throw new ApiError(
      "tiktok_not_configured",
      "TikTok OAuth is not configured (TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET unset)",
      400,
    );
  }

  return { clientKey, clientSecret };
}

async function readTikTokRedirectUri(): Promise<string> {
  const redirectUri = await readOptionalEnv("TIKTOK_REDIRECT_URI");

  if (!redirectUri) {
    throw new ApiError(
      "tiktok_not_configured",
      "TikTok OAuth is not configured (TIKTOK_REDIRECT_URI unset)",
      400,
    );
  }

  return redirectUri;
}

export async function buildTikTokAuthUrl(state: string): Promise<string> {
  const { clientKey } = await readTikTokCreds();
  const redirectUri = await readTikTokRedirectUri();
  const params = new URLSearchParams({
    client_key: clientKey,
    redirect_uri: redirectUri,
    response_type: "code",

    scope: tiktokScopes.join(","),
    state,
  });

  return `${tiktokAuthorizeUrl}?${params.toString()}`;
}

export async function requestTikTokToken(
  params: Record<string, string>,
  fetchImpl: FetchImpl = fetch,
): Promise<TikTokTokenResponse> {
  const { clientKey, clientSecret } = await readTikTokCreds();
  const response = await fetchImpl(tiktokTokenUrl, {
    body: new URLSearchParams({
      client_key: clientKey,
      client_secret: clientSecret,
      ...params,
    }),
    headers: {
      "Cache-Control": "no-cache",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  });

  if (!response.ok) {
    const body = await response.text();

    throw new ApiError(
      "tiktok_token_failed",
      `TikTok token request failed: ${response.status} ${response.statusText}${body ? ` - ${body}` : ""}`,
      400,
    );
  }

  return (await response.json()) as TikTokTokenResponse;
}

export async function exchangeCodeForTikTokToken(code: string): Promise<void> {
  const redirectUri = await readTikTokRedirectUri();
  const data = await requestTikTokToken({
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });

  if (!data.refresh_token) {
    throw new ApiError("tiktok_token_failed", "TikTok did not return a refresh token", 400);
  }

  await upsertTikTokAuth(data.access_token, data.refresh_token, data.expires_in, data.scope ?? "");
}

export async function getTikTokAccessToken(): Promise<string> {
  const db = await getDb();
  const result = await db.execute({
    args: ["tiktok"],
    sql: `select access_token, refresh_token, expires_at from tiktok_auth where service = ? limit 1`,
  });
  const auth = typedRow<TikTokAuthRow>(result.rows);

  if (!auth) {
    throw new ApiError("tiktok_not_authenticated", "TikTok is not authenticated", 400);
  }

  const expiresAt = new Date(auth.expires_at).getTime();
  const refreshWindowMs = 60_000;

  if (expiresAt - refreshWindowMs > Date.now()) {
    return auth.access_token;
  }

  const data = await requestTikTokToken({
    grant_type: "refresh_token",
    refresh_token: auth.refresh_token,
  });

  const refreshToken = data.refresh_token ?? auth.refresh_token;
  await upsertTikTokAuth(data.access_token, refreshToken, data.expires_in, data.scope ?? "");

  return data.access_token;
}

export async function hasTikTokAuth(): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute({
    args: ["tiktok"],
    sql: `select service from tiktok_auth where service = ? limit 1`,
  });

  return result.rows.length > 0;
}

export function extractTiktokVideoId(url: string): null | string {
  const match = url.match(/\/video\/(\d+)/);

  return match?.[1] ?? null;
}

function numberOrNull(value: unknown): null | number {
  return typeof value === "number" ? value : null;
}

function toVideoMetrics(video: TikTokVideoRaw): null | TikTokVideoMetrics {
  if (typeof video.id !== "string" || !video.id) {
    return null;
  }

  return {
    comments: numberOrNull(video.comment_count),
    id: video.id,
    likes: numberOrNull(video.like_count),
    shares: numberOrNull(video.share_count),
    views: numberOrNull(video.view_count),
  };
}

async function fetchTikTokVideoPage(
  accessToken: string,
  cursor: number | undefined,
  fetchImpl: FetchImpl,
): Promise<{ cursor: null | number; hasMore: boolean; videos: TikTokVideoMetrics[] }> {
  const url = `${tiktokVideoListUrl}?fields=${tiktokVideoFields.join(",")}`;
  const body: Record<string, number> = { max_count: TIKTOK_MAX_COUNT };

  if (typeof cursor === "number") {
    body.cursor = cursor;
  }

  const response = await fetchImpl(url, {
    body: JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  if (!response.ok) {
    const text = await response.text();

    throw new ApiError(
      "tiktok_video_list_failed",
      `TikTok video/list failed: ${response.status} ${response.statusText}${text ? ` - ${text}` : ""}`,
      400,
    );
  }

  const json = (await response.json()) as TikTokVideoListResponse;

  if (json.error?.code && json.error.code !== "ok") {
    throw new ApiError(
      "tiktok_video_list_failed",
      `TikTok video/list error: ${json.error.code}${json.error.message ? ` - ${json.error.message}` : ""}`,
      400,
    );
  }

  const videos = (json.data?.videos ?? [])
    .map(toVideoMetrics)
    .filter((video): video is TikTokVideoMetrics => video !== null);

  return {
    cursor: typeof json.data?.cursor === "number" ? json.data.cursor : null,
    hasMore: json.data?.has_more === true,
    videos,
  };
}

export async function collectOwnTikTokVideos(
  options: { fetchImpl?: FetchImpl } = {},
): Promise<null | TikTokVideoMetrics[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const clientKey = await readOptionalEnv("TIKTOK_CLIENT_KEY");
  const clientSecret = await readOptionalEnv("TIKTOK_CLIENT_SECRET");

  if (!clientKey || !clientSecret || !(await hasTikTokAuth())) {
    return null;
  }

  const accessToken = await getTikTokAccessToken();
  const collected: TikTokVideoMetrics[] = [];
  let cursor: number | undefined;

  for (let page = 0; page < TIKTOK_PAGE_BUDGET; page += 1) {
    const {
      cursor: nextCursor,
      hasMore,
      videos,
    } = await fetchTikTokVideoPage(accessToken, cursor, fetchImpl);

    collected.push(...videos);

    if (!hasMore || nextCursor === null) {
      break;
    }

    cursor = nextCursor;
  }

  return collected;
}

async function upsertTikTokAuth(
  accessToken: string,
  refreshToken: string,
  expiresIn: number,
  scope: string,
): Promise<void> {
  const db = await getDb();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresIn * 1000);

  await db.execute({
    args: ["tiktok", accessToken, refreshToken, expiresAt.toISOString(), scope, now.toISOString()],
    sql: `insert into tiktok_auth (service, access_token, refresh_token, expires_at, scope, updated_at)
      values (?, ?, ?, ?, ?, ?)
      on conflict(service) do update set
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        expires_at = excluded.expires_at,
        scope = excluded.scope,
        updated_at = excluded.updated_at`,
  });
}
