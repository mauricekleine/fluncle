import { type TrackSearchResult } from "@fluncle/contracts";

export type { TrackSearchResult };

import { parseSpotifyTrackId } from "../spotify-track-id";
import { getDb, typedRow } from "./db";
import { readEnvs } from "./env";
import { logEvent } from "./log";

const spotifyAccountsBaseUrl = "https://accounts.spotify.com";
const spotifyApiBaseUrl = "https://api.spotify.com/v1";
// The publish grant: it manages the Fluncle playlist (add a featured track).
const spotifyScopes = ["playlist-modify-public", "playlist-modify-private"];
// Admin web login asks for identity only — never the playlist-write scopes the
// publish flow uses. The login exchange reads /v1/me and discards the tokens.
const spotifyLoginScopes = ["user-read-email"];

type SpotifyTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
};

type SpotifyImage = {
  height?: number;
  url: string;
  width?: number;
};

type SpotifyTrackResponse = {
  id: string;
  name: string;
  uri: string;
  duration_ms: number;
  popularity?: number;
  album?: {
    images?: SpotifyImage[];
    name?: string;
    release_date?: string;
  };
  artists: Array<{
    id: string;
    name: string;
  }>;
  external_ids?: {
    isrc?: string;
  };
  external_urls?: {
    spotify?: string;
  };
};

type SpotifySearchResponse = {
  tracks?: {
    items?: SpotifyTrackResponse[];
  };
};

type SpotifyAuthRow = {
  access_token: string;
  refresh_token: string;
  expires_at: string;
};

// The ApiError code for "the stored Spotify authorization is gone — an operator
// must reconnect". Callers (the search route, publish) branch on this to show the
// reconnect affordance instead of a generic failure.
export const SPOTIFY_REAUTH_REQUIRED = "spotify_reauth_required";

// Spotify ages user refresh tokens out six months after issue (announced for
// 2026-07-20). We flag a token as stale well before that so the operator can
// reconnect on their own schedule rather than mid-publish. The clock is the
// stored row's last write — every successful refresh rewrites it, so this tracks
// the freshest token Spotify has handed us, not necessarily its true issue date.
const spotifyTokenStaleDays = 150;

export type SpotifyAuthStatus = {
  /** A row exists in spotify_auth (cleared the moment a refresh hits invalid_grant). */
  connected: boolean;
  /** Days since the stored token was last written; undefined when disconnected. */
  ageDays?: number;
  /** Connected but old enough to warrant a proactive reconnect. */
  stale: boolean;
};

// A typed token-endpoint failure carrying Spotify's machine-readable error code
// (e.g. "invalid_grant" when a refresh token has expired or been revoked), so the
// refresh path can tell "reconnect needed" apart from a transient outage.
class SpotifyTokenError extends Error {
  spotifyError?: string;

  constructor(message: string, spotifyError?: string) {
    super(message);
    this.name = "SpotifyTokenError";
    this.spotifyError = spotifyError;
  }
}

export type TrackMetadata = {
  trackId: string;
  spotifyUrl: string;
  spotifyUri: string;
  title: string;
  artists: string[];
  // Parallel to `artists`: the Spotify artist IDs in the same order. Populated
  // at ingest from the Spotify `/tracks/{id}` response so the artist entity
  // (artists + track_artists tables) can be upserted without an extra API call.
  spotifyArtistIds: string[];
  album?: string;
  albumImageUrl?: string;
  durationMs: number;
  isrc?: string;
  popularity?: number;
  releaseDate?: string;
};

export async function buildSpotifyAuthUrl(state: string): Promise<string> {
  return buildAuthorizeUrl(state, spotifyScopes);
}

// The admin-login authorize URL: identity scopes, the SAME registered redirect
// URI as the publish flow (the shared callback branches on state.purpose).
export async function buildSpotifyLoginUrl(state: string): Promise<string> {
  return buildAuthorizeUrl(state, spotifyLoginScopes);
}

async function buildAuthorizeUrl(state: string, scopes: string[]): Promise<string> {
  const env = await readEnvs(["SPOTIFY_CLIENT_ID", "SPOTIFY_REDIRECT_URI"]);
  const params = new URLSearchParams({
    client_id: env.SPOTIFY_CLIENT_ID,
    redirect_uri: env.SPOTIFY_REDIRECT_URI,
    response_type: "code",
    scope: scopes.join(" "),
    state,
  });

  return `${spotifyAccountsBaseUrl}/authorize?${params.toString()}`;
}

export type SpotifyProfile = {
  displayName?: string;
  email?: string;
  id: string;
};

type SpotifyProfileResponse = {
  display_name?: string;
  email?: string;
  id: string;
};

/**
 * Exchange an admin-login auth code for the caller's Spotify identity and throw
 * the tokens away. This is the LOGIN path — it must never touch spotify_auth (the
 * publish refresh token lives there); it only proves who is at the browser.
 */
export async function fetchSpotifyProfile(code: string): Promise<SpotifyProfile> {
  const env = await readEnvs(["SPOTIFY_REDIRECT_URI"]);
  const token = await requestToken({
    code,
    grant_type: "authorization_code",
    redirect_uri: env.SPOTIFY_REDIRECT_URI,
  });
  const response = await spotifyFetch("/me", token.access_token);
  const data = (await response.json()) as SpotifyProfileResponse;

  return {
    displayName: data.display_name,
    email: data.email,
    id: data.id,
  };
}

// The grammar itself lives in the shared client-safe module (../spotify-track-id)
// so the admin Add-finding dialog validates pastes with the SAME rules; this
// wrapper maps each failure reason onto the exact legacy `invalid_spotify_url`
// message the CLI and API consumers pin.
export function parseSpotifyTrackUrl(input: string): string {
  const parsed = parseSpotifyTrackId(input);

  if (parsed.ok) {
    return parsed.trackId;
  }

  switch (parsed.reason) {
    case "not_a_url":
      throw new ApiError("invalid_spotify_url", "Invalid Spotify URL", 400);
    case "wrong_host":
      throw new ApiError(
        "invalid_spotify_url",
        "Invalid Spotify URL: expected open.spotify.com",
        400,
      );
    case "not_a_track":
      throw new ApiError("invalid_spotify_url", "Invalid Spotify track URL", 400);
  }
}

function tryParseSpotifyTrackUrl(input: string): string | undefined {
  try {
    return parseSpotifyTrackUrl(input);
  } catch {
    return undefined;
  }
}

export async function exchangeCodeForToken(code: string): Promise<void> {
  const env = await readEnvs(["SPOTIFY_REDIRECT_URI"]);
  const data = await requestToken({
    code,
    grant_type: "authorization_code",
    redirect_uri: env.SPOTIFY_REDIRECT_URI,
  });

  if (!data.refresh_token) {
    throw new Error("Spotify did not return a refresh token");
  }

  await upsertSpotifyAuth(data.access_token, data.refresh_token, data.expires_in, data.scope);
}

export async function fetchTrackMetadata(trackId: string): Promise<TrackMetadata> {
  const accessToken = await getSpotifyAccessToken();
  const response = await spotifyFetch(`/tracks/${trackId}`, accessToken);
  const data = (await response.json()) as SpotifyTrackResponse;

  return {
    album: data.album?.name,
    albumImageUrl: selectAlbumImageUrl(data.album?.images),
    artists: data.artists.map((artist) => artist.name),
    durationMs: data.duration_ms,
    isrc: data.external_ids?.isrc,
    popularity: data.popularity,
    releaseDate: data.album?.release_date,
    spotifyArtistIds: data.artists.map((artist) => artist.id),
    spotifyUri: data.uri,
    spotifyUrl: data.external_urls?.spotify ?? `https://open.spotify.com/track/${data.id}`,
    title: data.name,
    trackId: data.id,
  };
}

type SpotifyArtistResponse = {
  id: string;
  images?: SpotifyImage[];
};

/**
 * Fetch each artist's largest Spotify profile image, keyed by Spotify artist id.
 * One `/v1/artists/{id}` call per artist: the batch endpoint (`/v1/artists?ids=`)
 * returns a bare 403 for this app's tier (verified 2026-07-10 — same token, batch
 * 403s, single 200s), so per-id is the only allowed path. A failing id (unknown to
 * Spotify, or a transient error) is skipped, never fatal — absent ids simply don't
 * appear in the map. The image is an `i.scdn.co` URL — the same host/precedent as
 * `tracks.album_image_url`, served attribution-by-link.
 */
export async function fetchArtistImages(spotifyArtistIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(spotifyArtistIds.filter((id): id is string => Boolean(id)))];
  const map = new Map<string, string>();

  if (ids.length === 0) {
    return map;
  }

  const accessToken = await getSpotifyAccessToken();

  for (const id of ids) {
    try {
      const response = await spotifyFetch(`/artists/${encodeURIComponent(id)}`, accessToken);
      const artist = (await response.json()) as SpotifyArtistResponse | null;

      if (!artist?.id) {
        continue;
      }

      const url = selectLargestImageUrl(artist.images);

      if (url) {
        map.set(artist.id, url);
      }
    } catch (error) {
      logEvent("warn", "spotify.artist-image-skipped", { artistId: id, error });
    }
  }

  return map;
}

export async function searchTrackCandidates(query: string): Promise<TrackSearchResult[]> {
  const trackId = tryParseSpotifyTrackUrl(query);

  if (trackId) {
    return [toSearchResult(await fetchTrackMetadata(trackId))];
  }

  const accessToken = await getSpotifyAccessToken();
  const params = new URLSearchParams({
    limit: "8",
    q: query,
    type: "track",
  });
  const response = await spotifyFetch(`/search?${params.toString()}`, accessToken);
  const data = (await response.json()) as SpotifySearchResponse;

  return (data.tracks?.items ?? []).map((track) => ({
    album: track.album?.name,
    artists: track.artists.map((artist) => artist.name),
    artworkUrl: selectAlbumImageUrl(track.album?.images),
    durationMs: track.duration_ms,
    id: track.id,
    spotifyUrl: track.external_urls?.spotify ?? `https://open.spotify.com/track/${track.id}`,
    title: track.name,
  }));
}

/** What the catalogue crawler wants from Spotify, and all it wants: the anchor. */
export type SpotifyIsrcMatch = {
  albumImageUrl?: string;
  spotifyUri: string;
  spotifyUrl: string;
  trackId: string;
};

/**
 * One ISRC lookup's outcome. `rateLimited` is the load-bearing half: without it, "Spotify
 * is throttling us" and "this track is not on Spotify" are the same answer, and a caller
 * would keep hammering a 429 wall for every remaining track. Measured live during the
 * pilot crawl — a sustained by-ISRC sweep DOES earn a 429 — which is exactly why the
 * signal exists and why `fillSpotifyAnchors` trips a breaker on it.
 */
export type SpotifyIsrcLookup = {
  match?: SpotifyIsrcMatch;
  rateLimited: boolean;
  /**
   * True when the lookup could not run because the stored Spotify grant is gone
   * (`spotify_not_authenticated` / `spotify_reauth_required`). Distinct from `rateLimited`
   * (a throttle) and from a clean no-match (`match` undefined, both flags false): the crawler's
   * anchor breaker pauses on this so a dead grant is not re-poked every tick, and surfaces it so
   * the operator knows to reconnect rather than wait out a throttle that will never lift.
   */
  unauthorized?: boolean;
};

/**
 * Find a track's Spotify presence BY ISRC — the one job Spotify still does well, and now
 * the only one the catalogue asks of it.
 *
 * Spotify's February-2026 lockdown removed the batch track-fetch endpoint, capped
 * `/search` at 10 results, and stripped `genres`/`popularity`/`label` from the payloads.
 * So it cannot be the catalogue's identity spine or its traversal — MusicBrainz is both
 * (docs/catalogue-crawler.md). What survives is the `isrc:` search filter, which is an
 * exact key lookup: given the ISRC MusicBrainz already holds, it returns the Spotify id
 * for that exact recording, or nothing.
 *
 * `tracks.spotify_uri` / `spotify_url` are NULLABLE precisely so "nothing" is a valid,
 * unremarkable answer — a crawled track with no Spotify presence is still a real track.
 * Best-effort by construction: it never throws, so a Spotify outage (or an un-authorized
 * environment) degrades the caller to "no anchor written", never to a failure.
 */
export async function findSpotifyTrackByIsrc(isrc: string): Promise<SpotifyIsrcLookup> {
  const clean = isrc.trim();

  if (!clean) {
    return { rateLimited: false };
  }

  try {
    const accessToken = await getSpotifyAccessToken();
    const params = new URLSearchParams({ limit: "1", q: `isrc:${clean}`, type: "track" });
    const response = await spotifyFetch(`/search?${params.toString()}`, accessToken);
    const data = (await response.json()) as SpotifySearchResponse;
    const track = data.tracks?.items?.[0];

    if (!track?.id) {
      return { rateLimited: false };
    }

    return {
      match: {
        albumImageUrl: selectAlbumImageUrl(track.album?.images),
        spotifyUri: `spotify:track:${track.id}`,
        spotifyUrl: track.external_urls?.spotify ?? `https://open.spotify.com/track/${track.id}`,
        trackId: track.id,
      },
      rateLimited: false,
    };
  } catch (error) {
    logEvent("warn", "spotify.isrc-lookup-failed", { error, isrc: clean });

    // The grant is gone (`getSpotifyAccessToken` throws an ApiError with these codes): every
    // subsequent call will fail the same way until the operator reconnects, so this is NOT a
    // "not on Spotify" answer and NOT a throttle — the caller must pause and surface it.
    if (
      error instanceof ApiError &&
      (error.code === "spotify_not_authenticated" || error.code === SPOTIFY_REAUTH_REQUIRED)
    ) {
      return { rateLimited: false, unauthorized: true };
    }

    // `spotifyFetch` throws a plain Error whose message carries the upstream status. A 429
    // means the vendor is throttling, not that the track is absent — the caller must stop.
    const rateLimited = error instanceof Error && error.message.includes("429");

    return { rateLimited };
  }
}

/**
 * The Fluncle playlist's saved/follower count — the one Spotify number that survived
 * the February-2026 API gutting (`GET /playlists/{id}?fields=followers.total`), and
 * the /reach collector's `spotify_playlist` metric. Reuses the same durable OAuth the
 * publish path holds (`getSpotifyAccessToken`) and the same `SPOTIFY_PLAYLIST_ID`
 * `addTrackToPlaylist` writes to, so it needs no new credential.
 *
 * NOT best-effort here — it throws on a missing playlist id, an unconnected
 * `spotify_auth` row, or a malformed response — because the collector wraps every
 * platform in its own try/catch and turns a throw into an honest per-platform skip.
 */
export async function fetchPlaylistFollowerCount(): Promise<number> {
  const [env, accessToken] = await Promise.all([
    readEnvs(["SPOTIFY_PLAYLIST_ID"]),
    getSpotifyAccessToken(),
  ]);
  const response = await spotifyFetch(
    `/playlists/${env.SPOTIFY_PLAYLIST_ID}?fields=followers.total`,
    accessToken,
  );
  const data = (await response.json()) as { followers?: { total?: number } };
  const total = data.followers?.total;

  if (typeof total !== "number" || !Number.isFinite(total)) {
    throw new Error("Spotify playlist response missing followers.total");
  }

  return total;
}

export async function addTrackToPlaylist(track: TrackMetadata): Promise<void> {
  const [env, accessToken] = await Promise.all([
    readEnvs(["SPOTIFY_PLAYLIST_ID"]),
    getSpotifyAccessToken(),
  ]);

  await spotifyFetch(`/playlists/${env.SPOTIFY_PLAYLIST_ID}/items`, accessToken, {
    body: JSON.stringify({
      uris: [track.spotifyUri],
    }),
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
  });
}

export class ApiError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 500) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

function selectAlbumImageUrl(images: SpotifyImage[] | undefined): string | undefined {
  if (!images?.length) {
    return undefined;
  }

  return (
    [...images]
      .sort((left, right) => (left.width ?? 0) - (right.width ?? 0))
      .find((image) => (image.width ?? 0) >= 300)?.url ?? images[0]?.url
  );
}

// The widest image Spotify carries — the artist-avatar counterpart to
// selectAlbumImageUrl (which targets the 300²+ album rendition). Artist images
// use a different id prefix than album art, so we pick the largest by width
// rather than a fixed rendition and render it at the source size.
function selectLargestImageUrl(images: SpotifyImage[] | undefined): string | undefined {
  if (!images?.length) {
    return undefined;
  }

  return (
    [...images].sort((left, right) => (right.width ?? 0) - (left.width ?? 0))[0]?.url ??
    images[0]?.url
  );
}

function toSearchResult(track: TrackMetadata): TrackSearchResult {
  return {
    album: track.album,
    artists: track.artists,
    artworkUrl: track.albumImageUrl,
    durationMs: track.durationMs,
    id: track.trackId,
    spotifyUrl: track.spotifyUrl,
    title: track.title,
  };
}

// Read the single spotify_auth row. Shared by the token acquire path and the
// invalid_grant re-read guard so both see the row through the same query.
async function readSpotifyAuthRow(): Promise<SpotifyAuthRow | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: ["spotify"],
    sql: `select access_token, refresh_token, expires_at
      from spotify_auth
      where service = ?
      limit 1`,
  });

  return typedRow<SpotifyAuthRow>(result.rows);
}

export async function getSpotifyAccessToken(): Promise<string> {
  const auth = await readSpotifyAuthRow();

  if (!auth) {
    throw new ApiError("spotify_not_authenticated", "Spotify is not authenticated", 400);
  }

  const expiresAt = new Date(auth.expires_at).getTime();
  const refreshWindowMs = 60_000;

  if (expiresAt - refreshWindowMs > Date.now()) {
    return auth.access_token;
  }

  let data: SpotifyTokenResponse;

  try {
    data = await requestToken({
      grant_type: "refresh_token",
      refresh_token: auth.refresh_token,
    });
  } catch (error) {
    // A six-month-old refresh token ages out (Spotify, from 2026-07-20) or is
    // revoked: the token endpoint answers 400 invalid_grant. Spotify's guidance
    // is to discard the dead token rather than retry it, then send the operator
    // back through sign-in.
    if (error instanceof SpotifyTokenError && error.spotifyError === "invalid_grant") {
      // Guard the shared row against a concurrent-refresh race. When Spotify
      // hands out single-use refresh tokens, two operator actions (search +
      // publish) that both find the token expired each fire a refresh with the
      // same token; the winner rotates it and the LOSER's now-consumed token
      // comes back invalid_grant — even though the connection is healthy. So
      // re-read the row before nuking it: if the stored refresh token no longer
      // matches the one we just failed with, a concurrent refresh already won,
      // so return its fresh access token instead of clearing. (When Spotify does
      // NOT rotate, a healthy refresh never yields invalid_grant, so the row is
      // unchanged and we fall through to the genuine-death path below.)
      const current = await readSpotifyAuthRow();

      if (current && current.refresh_token !== auth.refresh_token) {
        return current.access_token;
      }

      // The row still carries the token we failed with (or is already gone): the
      // grant is genuinely dead. Drop the row and surface a reconnect signal; the
      // next /admin focus reads "disconnected" and shows Reconnect Spotify.
      await clearSpotifyAuth();

      throw new ApiError(
        SPOTIFY_REAUTH_REQUIRED,
        "Spotify needs reconnecting — its saved authorization expired. Reconnect from the board.",
        401,
      );
    }

    throw error;
  }

  const refreshToken = data.refresh_token ?? auth.refresh_token;
  await upsertSpotifyAuth(data.access_token, refreshToken, data.expires_in, data.scope);

  return data.access_token;
}

// The board's connection light — read-only, no refresh side effect. A missing row
// means "reconnect" (we clear it on invalid_grant); a present row reports its age
// so the operator gets a heads-up before the six-month expiry, not a surprise.
export async function getSpotifyAuthStatus(): Promise<SpotifyAuthStatus> {
  const db = await getDb();
  const result = await db.execute({
    args: ["spotify"],
    sql: `select updated_at from spotify_auth where service = ? limit 1`,
  });
  const row = typedRow<{ updated_at: string }>(result.rows);

  if (!row) {
    return { connected: false, stale: false };
  }

  const ageDays = Math.floor((Date.now() - new Date(row.updated_at).getTime()) / 86_400_000);

  return {
    ageDays,
    connected: true,
    stale: ageDays >= spotifyTokenStaleDays,
  };
}

async function clearSpotifyAuth(): Promise<void> {
  const db = await getDb();

  await db.execute({
    args: ["spotify"],
    sql: `delete from spotify_auth where service = ?`,
  });
}

async function requestToken(params: Record<string, string>): Promise<SpotifyTokenResponse> {
  const env = await readEnvs(["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET"]);
  const response = await fetch(`${spotifyAccountsBaseUrl}/api/token`, {
    body: new URLSearchParams(params),
    headers: {
      Authorization: `Basic ${btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  });

  if (!response.ok) {
    const body = await response.text();
    const detail = body
      ? `${response.status} ${response.statusText} - ${body}`
      : `${response.status} ${response.statusText}`;

    throw new SpotifyTokenError(`Spotify token request failed: ${detail}`, parseTokenError(body));
  }

  return (await response.json()) as SpotifyTokenResponse;
}

// The token endpoint reports failures as { error: "invalid_grant", ... }. Pull
// that machine-readable code out so the refresh path can act on it.
function parseTokenError(body: string): string | undefined {
  if (!body) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(body) as { error?: unknown };

    return typeof parsed.error === "string" ? parsed.error : undefined;
  } catch {
    return undefined;
  }
}

async function upsertSpotifyAuth(
  accessToken: string,
  refreshToken: string,
  expiresIn: number,
  scope: string,
): Promise<void> {
  const db = await getDb();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresIn * 1000);

  await db.execute({
    args: ["spotify", accessToken, refreshToken, expiresAt.toISOString(), scope, now.toISOString()],
    sql: `insert into spotify_auth (
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

export async function spotifyFetch(
  path: string,
  accessToken: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);

  const response = await fetch(`${spotifyApiBaseUrl}${path}`, {
    ...init,
    headers,
  });

  if (!response.ok) {
    throw new Error(await readApiError(response, "Spotify API request failed"));
  }

  return response;
}

async function readApiError(response: Response, fallback: string): Promise<string> {
  const body = await response.text();

  if (!body) {
    return `${fallback}: ${response.status} ${response.statusText}`;
  }

  if (response.status === 404) {
    return `${fallback}: ${response.status} ${response.statusText} - ${body}. Spotify track IDs are case-sensitive; copy the full URL from Spotify again.`;
  }

  return `${fallback}: ${response.status} ${response.statusText} - ${body}`;
}
