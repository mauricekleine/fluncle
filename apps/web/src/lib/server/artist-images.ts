import { DEEZER_DATA_EXCEPTION_CODE, DEEZER_QUOTA_ERROR_CODE, DEEZER_USER_AGENT } from "./deezer";
import { mbFetch } from "./musicbrainz";
import { fold } from "./track-match";

const MAX_BATCH = 20;
const REQUEST_TIMEOUT_MS = 8_000;
const OEMBED_INTERVAL_MS = 250;
const DEEZER_INTERVAL_MS = 500;
const CACHE_TTL_MS = 60 * 60_000;
const CACHE_LIMIT = 500;
const SPOTIFY_THUMBNAIL_RE = /^\/image\/ab67616100005174([0-9a-f]+)$/;
const DEEZER_PLACEHOLDER_HASH = "d41d8cd98f00b204e9800998ecf8427e";

export type ArtistImageRequest = {
  deezerTrackId?: string | null;
  mbid: string | null;
  name: string;
  spotifyArtistId: string;
};

export type ArtistImagesFetchResult = {
  budgetLimited: boolean;
  checkedCount: number;
  checkedIds: string[];
  deferredIds: Set<string>;
  failures: Map<string, string>;
  images: Map<string, string>;
  missingIds: Set<string>;
  rateLimited: boolean;
};

type OembedResponse = {
  iframe_url?: string;
  thumbnail_url?: string | null;
  title?: string;
};

type DeezerArtist = { id?: number; name?: string; picture_xl?: string };
type DeezerTrack = { contributors?: Array<{ id?: number; name?: string }> };
type Lookup =
  | { kind: "image"; url: string }
  | { kind: "miss" }
  | { error: string; kind: "failure" }
  | { kind: "quota" }
  | { kind: "transient"; rateLimited: boolean };

type MbDeezerRelation =
  | { id: number; kind: "relation" }
  | { kind: "none" }
  | { kind: "transient"; rateLimited: boolean };

const cache = new Map<string, { expiresAt: number; url: string | null }>();
let nextOembedAt = 0;
let nextDeezerAt = 0;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rememberImage(id: string, url: string | null): void {
  cache.set(id, { expiresAt: Date.now() + CACHE_TTL_MS, url });
  if (cache.size > CACHE_LIMIT) {
    cache.delete(cache.keys().next().value ?? "");
  }
}

function validImageUrl(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      return undefined;
    }
    if (url.hostname === "image-cdn-ak.spotifycdn.com") {
      const match = SPOTIFY_THUMBNAIL_RE.exec(url.pathname);
      return match ? `https://i.scdn.co/image/ab6761610000e5eb${match[1]}` : undefined;
    }
    if (url.hostname === "i.scdn.co" && url.pathname.startsWith("/image/")) {
      return url.href;
    }
    if (url.hostname === "cdn-images.dzcdn.net") {
      const hash = /^\/images\/artist\/([^/]+)\//.exec(url.pathname)?.[1];
      return hash && hash.toLowerCase() !== DEEZER_PLACEHOLDER_HASH ? url.href : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function pacedFetch(url: string, source: "oembed" | "deezer"): Promise<Response> {
  const now = Date.now();
  const next = source === "oembed" ? nextOembedAt : nextDeezerAt;
  const slot = Math.max(now, next);
  if (source === "oembed") {
    nextOembedAt = slot + OEMBED_INTERVAL_MS;
  } else {
    nextDeezerAt = slot + DEEZER_INTERVAL_MS;
  }
  if (slot > now) {
    await delay(slot - now);
  }
  return fetch(url, {
    ...(source === "deezer" ? { headers: { "User-Agent": DEEZER_USER_AGENT } } : {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function oembedImage(artist: ArtistImageRequest): Promise<Lookup & { title?: string }> {
  const artistUrl = `https://open.spotify.com/artist/${encodeURIComponent(artist.spotifyArtistId)}`;
  const response = await pacedFetch(
    `https://open.spotify.com/oembed?url=${encodeURIComponent(artistUrl)}`,
    "oembed",
  );
  if (response.status === 404) {
    return { kind: "miss" };
  }
  if (response.status === 429 || response.status >= 500) {
    return { kind: "quota" };
  }
  if (!response.ok) {
    return { error: `Spotify oEmbed ${response.status}`, kind: "failure" };
  }
  const data = (await response.json()) as OembedResponse;
  if (typeof data.iframe_url !== "string") {
    return { kind: "miss" };
  }
  let iframe: URL;
  try {
    iframe = new URL(data.iframe_url);
  } catch {
    return { kind: "miss" };
  }
  if (
    iframe.origin !== "https://open.spotify.com" ||
    iframe.pathname !== `/embed/artist/${artist.spotifyArtistId}`
  ) {
    return { kind: "miss" };
  }
  const title = typeof data.title === "string" ? data.title : undefined;
  const url = validImageUrl(data.thumbnail_url);
  return url ? { kind: "image", title, url } : { kind: "miss", title };
}

async function mbidDeezerId(mbid: string): Promise<MbDeezerRelation> {
  let result;
  try {
    result = await mbFetch<{ relations?: Array<{ url?: { resource?: string } }> }>(
      `/artist/${encodeURIComponent(mbid)}?inc=url-rels`,
    );
  } catch {
    return { kind: "transient", rateLimited: false };
  }
  if (result.data === null) {
    return result.status === 404
      ? { kind: "none" }
      : { kind: "transient", rateLimited: result.rateLimited };
  }
  const ids = new Set(
    (result.data.relations ?? [])
      .map(
        (relation) =>
          relation.url?.resource?.match(
            /^https?:\/\/(?:www\.)?deezer\.com\/artist\/(\d+)\/?$/,
          )?.[1],
      )
      .filter((id): id is string => id !== undefined),
  );
  return ids.size === 1 ? { id: Number([...ids][0]), kind: "relation" } : { kind: "none" };
}

async function deezerResponse(url: string): Promise<Lookup | { body: unknown; kind: "body" }> {
  const response = await pacedFetch(url, "deezer");
  if (response.status === 429) {
    return { kind: "quota" };
  }
  if (response.status === 404) {
    return { kind: "miss" };
  }
  if (response.status >= 500) {
    return { kind: "quota" };
  }
  if (!response.ok) {
    return { error: `Deezer ${response.status}`, kind: "failure" };
  }
  const body: unknown = await response.json();
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
  if (code === DEEZER_QUOTA_ERROR_CODE) {
    return { kind: "quota" };
  }
  if (code === DEEZER_DATA_EXCEPTION_CODE) {
    return { kind: "miss" };
  }
  if (code !== undefined) {
    return {
      error: `Deezer error code ${typeof code === "number" ? code : "unknown"}`,
      kind: "failure",
    };
  }
  return { body, kind: "body" };
}

async function deezerImage(artist: ArtistImageRequest, oembedTitle?: string): Promise<Lookup> {
  const relation = artist.mbid ? await mbidDeezerId(artist.mbid) : { kind: "none" as const };
  if (relation.kind === "transient") {
    return relation;
  }
  const linkedId = relation.kind === "relation" ? relation.id : undefined;
  let artistId = linkedId;
  if (!artistId) {
    if (!artist.deezerTrackId || !/^\d+$/.test(artist.deezerTrackId)) {
      return { kind: "miss" };
    }
    const track = await deezerResponse(`https://api.deezer.com/track/${artist.deezerTrackId}`);
    if (track.kind !== "body") {
      return track;
    }
    const contributors = (track.body as DeezerTrack | null)?.contributors;
    const matches = (Array.isArray(contributors) ? contributors : []).filter(
      (item) =>
        typeof item.id === "number" &&
        typeof item.name === "string" &&
        fold(item.name) === fold(artist.name) &&
        (!oembedTitle || fold(item.name) === fold(oembedTitle)),
    );
    if (matches.length !== 1) {
      return { kind: "miss" };
    }
    artistId = matches[0]?.id;
  }
  const detail = await deezerResponse(`https://api.deezer.com/artist/${artistId}`);
  if (detail.kind !== "body") {
    return detail;
  }
  const item = detail.body as DeezerArtist | null;
  if (!item || item.id !== artistId) {
    return { kind: "miss" };
  }
  if (
    !linkedId &&
    (fold(item.name ?? "") !== fold(artist.name) ||
      (oembedTitle && fold(item.name ?? "") !== fold(oembedTitle)))
  ) {
    return { kind: "miss" };
  }
  const url = validImageUrl(item.picture_xl);
  return url ? { kind: "image", url } : { kind: "miss" };
}

export async function fetchArtistImages(
  artists: ArtistImageRequest[],
): Promise<ArtistImagesFetchResult> {
  const result: ArtistImagesFetchResult = {
    budgetLimited: false,
    checkedCount: 0,
    checkedIds: [],
    deferredIds: new Set(),
    failures: new Map(),
    images: new Map(),
    missingIds: new Set(),
    rateLimited: false,
  };
  const unique = [...new Map(artists.map((artist) => [artist.spotifyArtistId, artist])).values()];
  let oembedHeld = false;
  let deezerHeld = false;
  for (const artist of unique.slice(0, MAX_BATCH)) {
    const id = artist.spotifyArtistId;
    if (!/^[A-Za-z0-9]{22}$/.test(id)) {
      result.failures.set(id, "Invalid Spotify artist ID");
      result.checkedIds.push(id);
      result.checkedCount += 1;
      continue;
    }
    result.checkedIds.push(id);
    result.checkedCount += 1;
    const cached = cache.get(id);
    if (cached && cached.expiresAt > Date.now()) {
      if (cached.url) {
        result.images.set(id, cached.url);
      } else {
        result.missingIds.add(id);
      }
      continue;
    }
    try {
      const oembed = oembedHeld ? { kind: "quota" as const } : await oembedImage(artist);
      if (oembed.kind === "image") {
        result.images.set(id, oembed.url);
        rememberImage(id, oembed.url);
        continue;
      }
      if (oembed.kind === "quota") {
        oembedHeld = true;
        result.rateLimited = true;
      }
      const deezer = deezerHeld
        ? { kind: "quota" as const }
        : await deezerImage(artist, "title" in oembed ? oembed.title : undefined);
      if (deezer.kind === "image") {
        result.images.set(id, deezer.url);
        rememberImage(id, deezer.url);
      } else if (
        deezer.kind === "quota" ||
        deezer.kind === "transient" ||
        oembed.kind === "quota"
      ) {
        result.deferredIds.add(id);
        if (deezer.kind === "quota") {
          deezerHeld = true;
          result.rateLimited = true;
        } else if (deezer.kind === "transient" && deezer.rateLimited) {
          result.rateLimited = true;
        }
      } else if (oembed.kind === "failure") {
        result.failures.set(id, oembed.error);
      } else if (deezer.kind === "failure") {
        result.failures.set(id, deezer.error);
      } else {
        result.missingIds.add(id);
        rememberImage(id, null);
      }
    } catch (error) {
      result.failures.set(id, error instanceof Error ? error.message : String(error));
    }
  }
  result.budgetLimited = unique.length > MAX_BATCH;
  return result;
}
