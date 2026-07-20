// Our own TikTok OAuth + Display API machinery for the per-video metrics ledger. Mirrors
// the YouTube / Twitch token path (youtube.ts / twitch.ts): the durable refresh token
// lives in tiktok_auth (server-side), and we mint a short-lived access token on demand.
// The one reader is the daily social-metrics snapshot, which reads `POST /v2/video/list/`
// and appends each of @fluncle's videos' own metrics into `social_metrics` under the
// `tiktok_display` source (TikTok's authoritative per-video numbers, ALONGSIDE the Postiz
// source that already snapshots the same posts). Identity login stays Spotify-only; TikTok
// is purely a stats source. CHANNEL-level TikTok stats are NOT read here — the /reach
// collector already gets those via Postiz (platform-stats.ts `collectTiktok`), so this leg
// is per-video only, no duplication.
//
// Docs (verified against developers.tiktok.com, July 2026):
//   - Login Kit for Web authorize: https://www.tiktok.com/v2/auth/authorize/ — query params
//     client_key, response_type=code, scope (COMMA-separated), redirect_uri, state (CSRF,
//     mandatory). PKCE (code_challenge/code_verifier) is required for mobile/desktop ONLY —
//     a web confidential client (with client_secret) does not send it, so we don't.
//   - Token exchange + refresh: https://open.tiktokapis.com/v2/oauth/token/ — the response
//     carries access_token (~24h), refresh_token (~365d, ROTATES on refresh), refresh_expires_in,
//     scope (comma-separated), open_id.
//   - Video List: POST https://open.tiktokapis.com/v2/video/list/?fields=… — body { max_count
//     (≤20), cursor }, response { data: { videos, cursor, has_more }, error: { code: "ok", … } }.
//
// Sandbox vs production is a pure SECRET SWAP (TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET /
// TIKTOK_REDIRECT_URI) — zero code difference.

import { getDb, typedRow } from "./db";
import { type FetchImpl, readOptionalEnv } from "./env";
import { ApiError } from "./spotify";

const tiktokAuthorizeUrl = "https://www.tiktok.com/v2/auth/authorize/";
const tiktokTokenUrl = "https://open.tiktokapis.com/v2/oauth/token/";
const tiktokVideoListUrl = "https://open.tiktokapis.com/v2/video/list/";

// The scopes requested at consent. `user.info.basic` is TikTok's baseline identity scope
// (required for any Login Kit flow); `video.list` is what the ledger reads. We deliberately
// do NOT request `user.info.stats` — channel-level follower/likes totals already come from
// Postiz (platform-stats.ts), so requesting it would be an unused scope at app review.
const tiktokScopes = ["user.info.basic", "video.list"];

// The per-video fields the ledger needs, as the comma-separated `?fields=` query param.
const tiktokVideoFields = [
  "id",
  "create_time",
  "share_url",
  "view_count",
  "like_count",
  "comment_count",
  "share_count",
];

// TikTok caps `max_count` at 20 per page. `video/list` is sorted newest-first by
// create_time, so a bounded page budget reads the freshest window each run — the same
// hot-window logic the Postiz half uses, applied at the fetch layer.
const TIKTOK_MAX_COUNT = 20;
export const TIKTOK_PAGE_BUDGET = 10; // ≤200 of the newest videos per run.

type TikTokTokenResponse = {
  access_token: string;
  expires_in: number;
  open_id?: string;
  refresh_token?: string;
  // TikTok returns the granted scopes as a COMMA-separated string.
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

/** One of @fluncle's own TikTok videos, reduced to the metrics the ledger stores. A metric
 *  the API did not report stays `null` (never 0 — a real zero and "unreported" must differ). */
export type TikTokVideoMetrics = {
  comments: null | number;
  /** The native TikTok video (aweme) id — matched to a `social_posts.url` `/video/<id>`. */
  id: string;
  likes: null | number;
  shares: null | number;
  views: null | number;
};

/**
 * Read the TikTok client key/secret, throwing a clean `ApiError` (→ a 400 JSON body via
 * apiErrorResponse, never a crash) when the leg is unconfigured. OPTIONAL env: the whole
 * TikTok leg is DORMANT until these are set. Note TikTok names it `client_key`, not
 * `client_id`.
 */
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

/** The exact registered callback URL. Needed only for the authorize URL + code exchange
 *  (the refresh + video/list paths never use it), so it is read separately. */
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
    // TikTok expects the scopes COMMA-separated (unlike Google's space string).
    scope: tiktokScopes.join(","),
    state,
  });

  return `${tiktokAuthorizeUrl}?${params.toString()}`;
}

/**
 * The raw TikTok token POST (code exchange OR refresh), fetch injected so the refresh path
 * is unit-testable. Reads the creds off env and throws a clean `ApiError` on a non-2xx (the
 * detail is safe to surface: it never contains a secret).
 */
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

/**
 * A valid TikTok access token, refreshing via the stored refresh token when the current one
 * is within ~60s of expiry. Mirrors getTwitchAccessToken. TikTok ROTATES the refresh token
 * on refresh, so a returned refresh_token always replaces the stored one; we keep the old
 * one only if none came back.
 */
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
  // TikTok rotates the refresh token; use the new one, falling back to the stored one only
  // if the response omitted it.
  const refreshToken = data.refresh_token ?? auth.refresh_token;
  await upsertTikTokAuth(data.access_token, refreshToken, data.expires_in, data.scope ?? "");

  return data.access_token;
}

/** Whether a TikTok auth row exists — the gate the social-metrics snapshot reads before
 *  attempting the TikTok half. */
export async function hasTikTokAuth(): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute({
    args: ["tiktok"],
    sql: `select service from tiktok_auth where service = ? limit 1`,
  });

  return result.rows.length > 0;
}

/**
 * Extract the native TikTok video (aweme) id from a stored `social_posts.url`. TikTok
 * permalinks are `https://www.tiktok.com/@<handle>/video/<numericId>` (built by
 * postiz.ts `permalinkFromMissingId`), so the id is the numeric segment after `/video/`.
 * Returns `null` for any URL without that shape (a `/missing` placeholder, junk).
 */
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

/** One page of `POST /v2/video/list/`. Throws a clean `ApiError` on a transport failure or
 *  a non-`ok` TikTok error envelope. */
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

/**
 * Read @fluncle's own TikTok videos + their metrics (paginated, capped at
 * `TIKTOK_PAGE_BUDGET` pages of the newest videos). Returns `null` — a clean no-op — when
 * the leg is unconfigured (no creds) or not connected (no tiktok_auth row), so the caller
 * (the social-metrics snapshot) degrades exactly like the Postiz half does with no key. A
 * transport/token error propagates so the caller can log it and skip the TikTok half.
 */
export async function collectOwnTikTokVideos(
  options: { fetchImpl?: FetchImpl } = {},
): Promise<null | TikTokVideoMetrics[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const clientKey = await readOptionalEnv("TIKTOK_CLIENT_KEY");
  const clientSecret = await readOptionalEnv("TIKTOK_CLIENT_SECRET");

  // Unconfigured OR not yet connected → a clean no-op, never a throw.
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
