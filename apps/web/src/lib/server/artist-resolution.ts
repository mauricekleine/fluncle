// Artist social resolution pipeline (Unit 2.1 of the artist-relationship RFC).
//
// Resolves an artist's cross-platform social identity into `artist_socials` rows:
//
//   1. MusicBrainz (primary): ISRC → MB recording → artist-credit MBID →
//      /ws/2/artist/<mbid>?inc=url-rels → classify by host. MB url-rels are
//      human-curated → status="auto" (trusted). Also stamps `artists.mbid` +
//      `artists.wikidata_qid`.
//
//   2. Firecrawl /v2/extract (gap-fill): TikTok + missing YouTube only.
//      Uses the Worker-held FIRECRAWL_API_KEY. Gap-fill rows → status="candidate".
//
//   3. URL normalization: deep-link → profile root (TikTok/IG @handle), YouTube
//      @handle → channelId (best-effort via YouTube OAuth), UTM/query stripped.
//
//   4. Trust gate: `candidate` rows are excluded from the public artist page and
//      sameAs JSON-LD until the operator confirms them in the /admin/artists queue.
//      `auto`/`confirmed` rows are public.
//
// All vendor calls are best-effort: a failure for one platform never blocks the
// others. MB is throttled at 1 req/s (the shared Worker-isolate ceiling).

import { randomUUID } from "node:crypto";
import { getDb, typedRow, typedRows } from "./db";
import { readOptionalEnv } from "./env";
import { getYouTubeAccessToken } from "./youtube";

// ── Constants ────────────────────────────────────────────────────────────────

const MUSICBRAINZ_API_ROOT = "https://musicbrainz.org/ws/2";
const FIRECRAWL_EXTRACT_URL = "https://api.firecrawl.dev/v2/extract";
const USER_AGENT = "Fluncle/1.0 (+https://www.fluncle.com)";

const YOUTUBE_CHANNELS_API = "https://www.googleapis.com/youtube/v3/channels?part=id&maxResults=1";

// ── Rate limiter ─────────────────────────────────────────────────────────────
// Same pattern as discogs.ts — serialize MB calls at 1 req/s per Worker isolate.
// Module-level so concurrent calls within one request share the gate.

let rateLimitIntervalMs = 1100;

/** Test seam: set the pacing floor to run without real timers. */
export function __setRateLimitForTests(ms: number): void {
  rateLimitIntervalMs = ms;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeRateLimiter() {
  let tail: Promise<unknown> = Promise.resolve();

  return <T>(call: () => Promise<T>): Promise<T> => {
    const result = tail.then(call, call);
    tail = result.then(
      () => delay(rateLimitIntervalMs),
      () => delay(rateLimitIntervalMs),
    );

    return result;
  };
}

const throttleMb = makeRateLimiter();

// ── Platform type ─────────────────────────────────────────────────────────────

export type ArtistSocialPlatform =
  | "spotify"
  | "youtube"
  | "mixcloud"
  | "soundcloud"
  | "instagram"
  | "tiktok"
  | "bandcamp"
  | "twitter"
  | "facebook"
  | "homepage";

// ── MB types ─────────────────────────────────────────────────────────────────

type MbArtistCredit = {
  artist?: { id?: string; name?: string };
  name?: string;
};

type MbRecordingForIsrc = {
  id?: string;
  title?: string;
  "artist-credit"?: MbArtistCredit[];
};

type MbIsrcResponse = {
  recordings?: MbRecordingForIsrc[];
  error?: unknown;
};

type MbUrlRel = {
  type?: string;
  url?: { resource?: string };
  "target-type"?: string;
};

type MbArtistResponse = {
  id?: string;
  name?: string;
  relations?: MbUrlRel[];
  error?: unknown;
};

type MbArtistSearchCandidate = {
  id?: string;
  name?: string;
  score?: number;
};

type MbArtistSearchResponse = {
  artists?: MbArtistSearchCandidate[];
  error?: unknown;
};

// ── Firecrawl types ───────────────────────────────────────────────────────────

type FirecrawlExtractData = {
  tiktok?: string;
  youtube?: string;
};

type FirecrawlExtractResponse = {
  success?: boolean;
  data?: FirecrawlExtractData;
};

// ── Result types ──────────────────────────────────────────────────────────────

export type ResolvedSocial = {
  platform: ArtistSocialPlatform;
  url: string;
  source: "musicbrainz" | "firecrawl";
};

export type ArtistResolutionResult = {
  artistId: string;
  mbid: string | null;
  wikidataQid: string | null;
  socials: ResolvedSocial[];
  rateLimited: boolean;
};

// ── URL classification ────────────────────────────────────────────────────────

/**
 * Classify an MB url-relation resource URL to a social platform (or null if unhandled).
 *
 * `relType` is the MB relation `type` field. Only an `"official homepage"` rel type
 * maps to the `"homepage"` social; everything else that isn't a recognized
 * social/aggregator returns null (skipped, not stored).
 */
export function classifyMbUrl(
  resource: string,
  relType?: string | null,
): ArtistSocialPlatform | "wikidata" | null {
  let host: string;

  try {
    // Strip www. AND music. subdomains so music.youtube.com → youtube.com.
    host = new URL(resource).hostname.replace(/^(www\.|music\.)/, "");
  } catch {
    return null;
  }

  if (host === "open.spotify.com") {
    return "spotify";
  }
  if (host === "youtube.com" || host === "youtu.be") {
    return "youtube";
  }
  if (host === "mixcloud.com") {
    return "mixcloud";
  }
  if (host === "soundcloud.com") {
    return "soundcloud";
  }
  if (host === "instagram.com") {
    return "instagram";
  }
  if (host === "tiktok.com") {
    return "tiktok";
  }
  if (host === "bandcamp.com" || resource.includes(".bandcamp.com")) {
    return "bandcamp";
  }
  if (host === "twitter.com" || host === "x.com") {
    return "twitter";
  }
  if (host === "facebook.com" || host === "fb.com") {
    return "facebook";
  }
  if (host === "wikidata.org") {
    return "wikidata";
  }

  // Treat any other URL from a non-social, non-aggregator domain as a homepage.
  const AGGREGATORS = new Set([
    "linktr.ee",
    "linkfire.com",
    "lnk.to",
    "link.tl",
    "allmylinks.com",
    "musicbrainz.org",
    "discogs.com",
    "last.fm",
    "allmusic.com",
    "rateyourmusic.com",
    "genius.com",
    "songkick.com",
    "setlist.fm",
    "beatport.com",
  ]);

  if (AGGREGATORS.has(host)) {
    return null;
  }

  // Only store a homepage when MB explicitly tagged it as one.
  if (relType === "official homepage") {
    return "homepage";
  }

  // Everything else (Wikipedia, streaming, VIAF, ISNI, IMDb, …) is unhandled → skip.
  return null;
}

// ── URL normalization ─────────────────────────────────────────────────────────

/** Strip query parameters from a URL (keep just origin + pathname). */
function stripQuery(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return `${u.origin}${u.pathname}`.replace(/\/$/, "");
  } catch {
    return rawUrl;
  }
}

/** Extract the @handle (without `@`) from a TikTok URL. */
function extractTikTokHandle(rawUrl: string): string | null {
  try {
    const pathname = new URL(rawUrl).pathname;
    const match = pathname.match(/^\/@?([^/]+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Extract the username from an Instagram URL. */
function extractInstagramHandle(rawUrl: string): string | null {
  try {
    const pathname = new URL(rawUrl).pathname;
    const match = pathname.match(/^\/([^/]+)\/?$/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve a YouTube /@handle URL to a stable channel/UC... URL using the YouTube
 * Data API (via the stored OAuth access token). Best-effort: if the token isn't
 * provisioned or the call fails, the @handle URL is returned as-is.
 */
async function resolveYouTubeHandleToChannelUrl(rawUrl: string): Promise<string> {
  try {
    const u = new URL(rawUrl);
    const handleMatch = u.pathname.match(/^\/@([^/]+)/);

    if (!handleMatch || !handleMatch[1]) {
      return stripQuery(rawUrl);
    }

    const handle = handleMatch[1];

    const accessToken = await getYouTubeAccessToken().catch(() => null);

    if (!accessToken) {
      return `https://www.youtube.com/@${handle}`;
    }

    const apiUrl = `${YOUTUBE_CHANNELS_API}&forHandle=@${encodeURIComponent(handle)}`;
    const response = await fetch(apiUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      return `https://www.youtube.com/@${handle}`;
    }

    type ChannelListResponse = {
      items?: Array<{ id?: string }>;
    };

    const data = (await response.json()) as ChannelListResponse;
    const channelId = data.items?.[0]?.id;

    if (channelId) {
      return `https://www.youtube.com/channel/${channelId}`;
    }

    return `https://www.youtube.com/@${handle}`;
  } catch {
    return stripQuery(rawUrl);
  }
}

/** Strip a YouTube URL to the channel root (no videos/playlists). */
async function normalizeYouTubeUrl(rawUrl: string): Promise<string | null> {
  try {
    const u = new URL(rawUrl);
    const pathname = u.pathname;

    // Already a channel/UC URL — clean.
    if (pathname.startsWith("/channel/")) {
      const channelId = pathname.split("/")[2];

      return channelId ? `https://www.youtube.com/channel/${channelId}` : null;
    }

    // @handle — try to resolve to stable channelId.
    if (pathname.startsWith("/@")) {
      return await resolveYouTubeHandleToChannelUrl(rawUrl);
    }

    // User/* or c/* legacy — keep as-is stripped.
    if (pathname.startsWith("/user/") || pathname.startsWith("/c/")) {
      return stripQuery(rawUrl);
    }

    // A video or playlist URL — not a channel profile root; skip.
    if (pathname.startsWith("/watch") || pathname.startsWith("/playlist")) {
      return null;
    }

    return stripQuery(rawUrl);
  } catch {
    return null;
  }
}

/**
 * Normalize a social URL to the canonical profile root. Returns null when the
 * URL can't be reduced to a profile page (e.g. a TikTok video URL with no handle).
 */
// Reject any non-http(s) URL — a scraped `javascript:`/`data:` value must never become a
// social row (stored-XSS defense at ingestion; the championing unit's operator confirm +
// render guards are the second layer).
function isHttpScheme(raw: string): boolean {
  try {
    const { protocol } = new URL(raw.trim());
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export async function normalizeProfileUrl(
  platform: ArtistSocialPlatform,
  rawUrl: string,
): Promise<string | null> {
  if (!isHttpScheme(rawUrl)) {
    return null;
  }

  switch (platform) {
    case "tiktok": {
      const handle = extractTikTokHandle(rawUrl);
      return handle ? `https://www.tiktok.com/@${handle}` : null;
    }

    case "instagram": {
      const handle = extractInstagramHandle(rawUrl);
      return handle ? `https://www.instagram.com/${handle}` : null;
    }

    case "youtube":
      return normalizeYouTubeUrl(rawUrl);

    case "spotify": {
      // Keep the artist URL, strip query params.
      const stripped = stripQuery(rawUrl);
      return stripped.includes("/artist/") ? stripped : null;
    }

    default:
      return stripQuery(rawUrl) || null;
  }
}

// ── MB fetch helper ────────────────────────────────────────────────────────────

async function mbFetch<T>(path: string): Promise<{ data: T | null; rateLimited: boolean }> {
  const separator = path.includes("?") ? "&" : "?";
  const url = `${MUSICBRAINZ_API_ROOT}${path}${separator}fmt=json`;

  return throttleMb(async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let response: Response;

      try {
        response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
      } catch {
        return { data: null, rateLimited: false };
      }

      if (response.status === 503 && attempt < 2) {
        const retryAfter = Number(response.headers.get("Retry-After")) || 2;
        console.warn(`[mb-artist] 503 for ${path} — retry ${attempt + 1}/2 after ${retryAfter}s`);
        await delay(rateLimitIntervalMs === 0 ? 0 : retryAfter * 1000);
        continue;
      }

      if (response.status === 503) {
        return { data: null, rateLimited: true };
      }

      if (!response.ok) {
        console.warn(`[mb-artist] ${response.status} ${response.statusText} for ${path}`);
        return { data: null, rateLimited: false };
      }

      return { data: (await response.json()) as T, rateLimited: false };
    }

    return { data: null, rateLimited: false };
  });
}

// ── MB name similarity (lightweight match, not casefold-full) ─────────────────

function mbNameMatch(mbName: string, artistName: string): boolean {
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .replace(/[^a-z0-9]/g, "");

  return normalize(mbName) === normalize(artistName);
}

// ── Lucene / Spotify-id helpers (for the name-search fallback) ─────────────────

/**
 * Escape the two characters (`\` and `"`) that are special INSIDE a Lucene quoted
 * phrase, so an artist name can be sent as `artist:"<escaped>"` without breaking the
 * query or splitting on spaces. The whole phrase is quoted, so term-level specials
 * (`+ - && || ! ( ) …`) are inert and need no escaping.
 */
export function luceneEscapePhrase(value: string): string {
  return value.replace(/[\\"]/g, "\\$&");
}

/**
 * Extract the Spotify artist id from an `open.spotify.com/artist/<id>` URL, or null
 * if the URL isn't a Spotify artist URL. Used to cross-check an MB name-search
 * candidate's identity against the Fluncle artist's stored `spotify_artist_id`.
 */
export function parseSpotifyArtistId(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);

    if (u.hostname.replace(/^www\./, "") !== "open.spotify.com") {
      return null;
    }

    const match = u.pathname.match(/\/artist\/([A-Za-z0-9]+)/);

    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Find the Spotify artist id among an MB artist's url-rels (null if none present). */
function spotifyArtistIdFromRelations(relations?: MbUrlRel[]): string | null {
  for (const relation of relations ?? []) {
    const resource = relation.url?.resource;

    if (!resource) {
      continue;
    }

    const id = parseSpotifyArtistId(resource);

    if (id) {
      return id;
    }
  }

  return null;
}

// The MB search `score` (0–100) a name-only candidate must clear to be accepted when
// there's no Spotify url-rel to cross-check against. Paired with an exact name match,
// this biases hard toward correctness — a wrong social link on a public artist page is
// worse than a missing one.
const NAME_SEARCH_SCORE_THRESHOLD = 90;

// Cap how many top candidates we deep-fetch url-rels for (1 req/s each under MB's limit).
const NAME_SEARCH_MAX_DEEP_FETCH = 3;

// ── MB artist resolution ──────────────────────────────────────────────────────

type MbResolution = {
  mbid: string | null;
  wikidataQid: string | null;
  socials: ResolvedSocial[];
  rateLimited: boolean;
};

/** Walk an ISRC list → MB recording → artist-credit → the artist's MBID (name-matched). */
async function resolveMbidViaIsrcs(
  artistName: string,
  isrcs: string[],
): Promise<{ mbid: string | null; rateLimited: boolean }> {
  let mbid: string | null = null;

  for (const isrc of isrcs) {
    if (mbid) {
      break;
    }

    const isrcResult = await mbFetch<MbIsrcResponse>(
      `/isrc/${encodeURIComponent(isrc)}?inc=artist-credits`,
    );

    if (isrcResult.rateLimited) {
      return { mbid: null, rateLimited: true };
    }

    const isrcData = isrcResult.data;

    if (!isrcData || isrcData.error || !Array.isArray(isrcData.recordings)) {
      continue;
    }

    // Find the artist in the recording's artist-credits by name match.
    for (const recording of isrcData.recordings) {
      if (mbid) {
        break;
      }

      for (const credit of recording["artist-credit"] ?? []) {
        const artistId = credit.artist?.id;
        const mbArtistName = credit.artist?.name ?? credit.name ?? "";

        if (artistId && mbNameMatch(mbArtistName, artistName)) {
          mbid = artistId;
          break;
        }
      }
    }
  }

  return { mbid, rateLimited: false };
}

/**
 * Fallback path when the ISRC walk found nothing (DnB ISRCs are frequently missing
 * from MB's index): search MB by artist NAME, then DISAMBIGUATE.
 *
 *   - Primary (exact identity): deep-fetch each top candidate's `inc=url-rels` and
 *     accept the one whose Spotify url-rel's artist id equals the Fluncle artist's
 *     stored `spotify_artist_id`. That's a hard identity match — accept immediately.
 *   - A candidate whose Spotify rel is present but DOESN'T match is a namesake → reject.
 *   - Fallback (no Spotify rel to cross-check): accept only on a strong signal —
 *     MB `score >= NAME_SEARCH_SCORE_THRESHOLD` AND an exact normalized name match —
 *     and only if no candidate delivered a primary Spotify-id match.
 *
 * Returns the already-fetched `artistData` so the caller can reuse it (no extra fetch).
 */
async function resolveMbidViaNameSearch(
  artistName: string,
  spotifyArtistId: string | null,
): Promise<{ mbid: string | null; artistData: MbArtistResponse | null; rateLimited: boolean }> {
  if (!artistName.trim()) {
    return { artistData: null, mbid: null, rateLimited: false };
  }

  const query = `artist:"${luceneEscapePhrase(artistName)}"`;
  const searchResult = await mbFetch<MbArtistSearchResponse>(
    `/artist?query=${encodeURIComponent(query)}&limit=5`,
  );

  if (searchResult.rateLimited) {
    return { artistData: null, mbid: null, rateLimited: true };
  }

  const candidates = searchResult.data?.artists;

  if (searchResult.data?.error || !Array.isArray(candidates) || candidates.length === 0) {
    return { artistData: null, mbid: null, rateLimited: false };
  }

  // A weaker name+score match we accept only if no primary Spotify-id match appears.
  let fallbackMbid: string | null = null;
  let fallbackData: MbArtistResponse | null = null;

  const deepFetchCount = Math.min(candidates.length, NAME_SEARCH_MAX_DEEP_FETCH);

  for (let i = 0; i < deepFetchCount; i += 1) {
    const candidate = candidates[i];
    const candidateId = candidate?.id;

    if (!candidateId) {
      continue;
    }

    // Deep-fetch url-rels so we can cross-check the Spotify identity (and reuse them).
    const artistResult = await mbFetch<MbArtistResponse>(
      `/artist/${encodeURIComponent(candidateId)}?inc=url-rels`,
    );

    if (artistResult.rateLimited) {
      return { artistData: null, mbid: null, rateLimited: true };
    }

    const artistData = artistResult.data;

    if (!artistData || artistData.error) {
      continue;
    }

    const candidateSpotifyId = spotifyArtistIdFromRelations(artistData.relations);

    // Primary: exact Spotify artist-id identity match — accept immediately.
    if (spotifyArtistId && candidateSpotifyId && candidateSpotifyId === spotifyArtistId) {
      return { artistData, mbid: candidateId, rateLimited: false };
    }

    // Namesake guard: the candidate carries a Spotify id we could check, and it didn't
    // match (or we have one to check against but it differs) → this is a different
    // artist. Skip it; never let it become the name+score fallback.
    if (spotifyArtistId && candidateSpotifyId) {
      continue;
    }

    // Name+score fallback — only when there's no Spotify rel to cross-check on this
    // candidate. First strong match wins; keep looping for a possible primary match.
    if (
      fallbackMbid === null &&
      candidateSpotifyId === null &&
      (candidate?.score ?? 0) >= NAME_SEARCH_SCORE_THRESHOLD &&
      mbNameMatch(candidate?.name ?? "", artistName)
    ) {
      fallbackMbid = candidateId;
      fallbackData = artistData;
    }
  }

  return { artistData: fallbackData, mbid: fallbackMbid, rateLimited: false };
}

/** Classify an MB artist's url-rels into resolved socials + the Wikidata QID. */
async function extractSocialsFromArtistData(
  artistData: MbArtistResponse,
): Promise<{ socials: ResolvedSocial[]; wikidataQid: string | null }> {
  const socials: ResolvedSocial[] = [];
  let wikidataQid: string | null = null;

  for (const relation of artistData.relations ?? []) {
    const resource = relation.url?.resource;

    if (!resource) {
      continue;
    }

    const classification = classifyMbUrl(resource, relation.type);

    if (!classification) {
      continue;
    }

    if (classification === "wikidata") {
      // Extract QID (e.g. Q12345) from the Wikidata URL.
      const match = resource.match(/\/wiki\/(Q\d+)/);

      if (match?.[1]) {
        wikidataQid = match[1];
      }

      continue;
    }

    const normalizedUrl = await normalizeProfileUrl(classification, resource);

    if (!normalizedUrl) {
      continue;
    }

    // Deduplicate by platform (first wins).
    if (!socials.some((s) => s.platform === classification)) {
      socials.push({ platform: classification, source: "musicbrainz", url: normalizedUrl });
    }
  }

  return { socials, wikidataQid };
}

/**
 * Resolve an artist's socials + KG anchors via MusicBrainz. Two paths, in order:
 *
 *   1. ISRC walk: ISRC → MB recording → artist-credit → MBID (name-matched).
 *   2. Name-search fallback (when 1 finds no MBID): search MB by artist NAME and
 *      disambiguate against the stored `spotify_artist_id` (see resolveMbidViaNameSearch).
 *      DnB ISRCs are often absent from MB's index, so without this an artist resolves
 *      to zero socials and — because `resolved_at` gets stamped anyway — never retries.
 *
 * Once an MBID is found, its `inc=url-rels` are classified into socials. The whole
 * walk is throttled at 1 req/s (per-isolate serial gate).
 */
export async function resolveArtistViaMb(
  artistName: string,
  isrcs: string[],
  spotifyArtistId: string | null = null,
): Promise<MbResolution> {
  // ── 1. ISRC walk ───────────────────────────────────────────────────────────
  const isrcWalk = await resolveMbidViaIsrcs(artistName, isrcs);

  if (isrcWalk.rateLimited) {
    return { mbid: null, rateLimited: true, socials: [], wikidataQid: null };
  }

  let mbid = isrcWalk.mbid;
  // The name-search path deep-fetches url-rels to cross-check identity; reuse them.
  let artistData: MbArtistResponse | null = null;

  // ── 2. Name-search fallback ─────────────────────────────────────────────────
  if (!mbid) {
    const nameSearch = await resolveMbidViaNameSearch(artistName, spotifyArtistId);

    if (nameSearch.rateLimited) {
      return { mbid: null, rateLimited: true, socials: [], wikidataQid: null };
    }

    mbid = nameSearch.mbid;
    artistData = nameSearch.artistData;
  }

  if (!mbid) {
    return { mbid: null, rateLimited: false, socials: [], wikidataQid: null };
  }

  // Fetch the artist's url-rels unless the name-search already did (identity check).
  if (!artistData) {
    const artistResult = await mbFetch<MbArtistResponse>(
      `/artist/${encodeURIComponent(mbid)}?inc=url-rels`,
    );

    if (artistResult.rateLimited) {
      return { mbid, rateLimited: true, socials: [], wikidataQid: null };
    }

    if (!artistResult.data || artistResult.data.error) {
      return { mbid, rateLimited: false, socials: [], wikidataQid: null };
    }

    artistData = artistResult.data;
  }

  const { socials, wikidataQid } = await extractSocialsFromArtistData(artistData);

  return { mbid, rateLimited: false, socials, wikidataQid };
}

// ── Firecrawl gap-fill ────────────────────────────────────────────────────────

/**
 * Use Firecrawl /v2/extract to fill in TikTok and/or YouTube socials that MB
 * didn't resolve. Only called when those platforms are genuinely missing.
 *
 * Returns candidate rows (status will be set to "candidate" at persist time).
 * Best-effort: a Firecrawl failure returns an empty array, never throws.
 */
export async function resolveGapViaFirecrawl(
  artistName: string,
  spotifyUrl: string | null,
  mbid: string | null,
  missingPlatforms: Set<ArtistSocialPlatform>,
): Promise<ResolvedSocial[]> {
  // Only worth calling if TikTok or YouTube are actually missing.
  const wantTikTok = missingPlatforms.has("tiktok");
  const wantYoutube = missingPlatforms.has("youtube");

  if (!wantTikTok && !wantYoutube) {
    return [];
  }

  // Without a Spotify URL or an MB-resolved identity to anchor, the only seed is
  // a name-based Spotify search URL — a JS-rendered page Firecrawl can't scrape
  // that risks matching a namesake artist. Skip rather than guess.
  if (!spotifyUrl && !mbid) {
    return [];
  }

  const apiKey = await readOptionalEnv("FIRECRAWL_API_KEY");

  if (!apiKey) {
    return [];
  }

  // The source URL: the artist's Spotify profile is the most reliable seed.
  const sourceUrl =
    spotifyUrl ?? `https://musicbrainz.org/artist/${encodeURIComponent(mbid ?? "")}`;

  const platforms: string[] = [];
  if (wantTikTok) {
    platforms.push("tiktok");
  }
  if (wantYoutube) {
    platforms.push("youtube");
  }

  const schema = {
    properties: Object.fromEntries(
      platforms.map((p) => [p, { description: `Official ${p} profile URL`, type: "string" }]),
    ),
    type: "object",
  };

  const prompt = `Extract the official ${platforms.join(" and ")} profile URL(s) for the music artist "${artistName}". Return only verified official accounts.`;

  let payload: FirecrawlExtractResponse;

  try {
    const response = await fetch(FIRECRAWL_EXTRACT_URL, {
      body: JSON.stringify({
        enableWebSearch: true,
        prompt,
        schema,
        urls: [sourceUrl],
      }),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    if (!response.ok) {
      console.warn(
        `[artist-resolution] Firecrawl /v2/extract ${response.status} for ${artistName}`,
      );
      return [];
    }

    payload = (await response.json()) as FirecrawlExtractResponse;
  } catch (err) {
    console.warn(
      `[artist-resolution] Firecrawl error for ${artistName}:`,
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }

  if (!payload.success || !payload.data) {
    return [];
  }

  const socials: ResolvedSocial[] = [];

  if (wantTikTok && payload.data.tiktok) {
    const normalized = await normalizeProfileUrl("tiktok", payload.data.tiktok);

    if (normalized) {
      socials.push({ platform: "tiktok", source: "firecrawl", url: normalized });
    }
  }

  if (wantYoutube && payload.data.youtube) {
    const normalized = await normalizeProfileUrl("youtube", payload.data.youtube);

    if (normalized) {
      socials.push({ platform: "youtube", source: "firecrawl", url: normalized });
    }
  }

  return socials;
}

// ── DB helpers ────────────────────────────────────────────────────────────────

type ArtistRow = {
  id: string;
  name: string;
  spotify_artist_id: string | null;
  spotify_url: string | null;
  mbid: string | null;
  resolved_at: string | null;
};

type IsrcRow = {
  isrc: string;
};

type ExistingSocialRow = {
  platform: string;
};

/** Fetch an artist + their track ISRCs for the MB walk. */
async function fetchArtistAndIsrcs(
  artistId: string,
): Promise<{ artist: ArtistRow; isrcs: string[] } | null> {
  const db = await getDb();

  const artistResult = await db.execute({
    args: [artistId],
    sql: `select id, name, spotify_artist_id, spotify_url, mbid, resolved_at
          from artists where id = ? limit 1`,
  });

  const artist = typedRow<ArtistRow>(artistResult.rows);

  if (!artist) {
    return null;
  }

  const isrcResult = await db.execute({
    args: [artistId],
    sql: `select distinct t.isrc, t.added_at
          from track_artists ta
          join tracks t on t.track_id = ta.track_id
          where ta.artist_id = ? and t.isrc is not null
          order by t.added_at asc
          limit 20`,
  });

  const isrcs = typedRows<IsrcRow>(isrcResult.rows)
    .map((r) => r.isrc)
    .filter((isrc): isrc is string => Boolean(isrc));

  return { artist, isrcs };
}

/** Fetch the platforms already resolved for an artist (to skip in Firecrawl gap-fill). */
async function fetchExistingPlatforms(artistId: string): Promise<Set<ArtistSocialPlatform>> {
  const db = await getDb();
  const result = await db.execute({
    args: [artistId],
    sql: `select platform from artist_socials where artist_id = ?`,
  });

  const platforms = new Set<ArtistSocialPlatform>();

  for (const row of typedRows<ExistingSocialRow>(result.rows)) {
    platforms.add(row.platform as ArtistSocialPlatform);
  }

  return platforms;
}

/**
 * Upsert artist_socials rows and stamp artists.mbid / .wikidata_qid / .resolved_at.
 * The upsert strategy: a new source always wins on url (MB is more reliable than
 * Firecrawl; if MB and Firecrawl both have a platform, MB's row already exists and
 * the Firecrawl upsert skips it via the `do nothing` guard — MB already set status=auto).
 */
async function persistResolution(
  artistId: string,
  mbid: string | null,
  wikidataQid: string | null,
  mbSocials: ResolvedSocial[],
  firecrawlSocials: ResolvedSocial[],
): Promise<void> {
  const db = await getDb();
  const nowIso = new Date().toISOString();

  // Stamp the KG anchors + resolvedAt on the artist row.
  await db.execute({
    args: [mbid, wikidataQid, nowIso, nowIso, artistId],
    sql: `update artists
          set mbid = coalesce(?, mbid),
              wikidata_qid = coalesce(?, wikidata_qid),
              resolved_at = ?,
              updated_at = ?
          where id = ?`,
  });

  // Upsert MB socials (status=auto, trusted).
  for (const social of mbSocials) {
    const id = randomUUID();
    await db.execute({
      args: [id, artistId, social.platform, social.url, "musicbrainz", "auto", nowIso, nowIso],
      sql: `insert into artist_socials
              (id, artist_id, platform, url, source, status, created_at, updated_at)
            values (?, ?, ?, ?, ?, ?, ?, ?)
            on conflict(artist_id, platform) do update set
              url = excluded.url,
              source = excluded.source,
              status = case
                when artist_socials.status = 'confirmed' then 'confirmed'
                else excluded.status
              end,
              updated_at = excluded.updated_at`,
    });
  }

  // Upsert Firecrawl socials (status=candidate) — only if platform not already resolved.
  for (const social of firecrawlSocials) {
    const id = randomUUID();
    await db.execute({
      args: [id, artistId, social.platform, social.url, "firecrawl", "candidate", nowIso, nowIso],
      sql: `insert into artist_socials
              (id, artist_id, platform, url, source, status, created_at, updated_at)
            values (?, ?, ?, ?, ?, ?, ?, ?)
            on conflict(artist_id, platform) do nothing`,
    });
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Resolve an artist's cross-platform social identity by artistId. Runs the MB
 * walk then the Firecrawl gap-fill, persists results, and returns a summary.
 *
 * This is the Worker-side logic behind the `resolve_artist` oRPC op. The box's
 * `fluncle-artist-sweep` cron drives it per unresolved artist via the CLI.
 */
export async function resolveArtist(artistId: string): Promise<ArtistResolutionResult> {
  const record = await fetchArtistAndIsrcs(artistId);

  if (!record) {
    throw new Error(`Artist not found: ${artistId}`);
  }

  const { artist, isrcs } = record;

  // ── 1. MusicBrainz walk (ISRC, then name-search disambiguated by Spotify id) ─
  const mbResult = await resolveArtistViaMb(artist.name, isrcs, artist.spotify_artist_id);

  // ── 2. Firecrawl gap-fill (TikTok + missing YouTube only) ─────────────────
  const existingPlatforms = await fetchExistingPlatforms(artistId);

  // Add MB-resolved platforms to the "existing" set so Firecrawl only fills gaps.
  for (const s of mbResult.socials) {
    existingPlatforms.add(s.platform);
  }

  // Rate-limited: nothing to persist yet — stay in the unresolved queue (resolved_at NULL).
  if (mbResult.rateLimited) {
    return {
      artistId,
      mbid: null,
      rateLimited: true,
      socials: [],
      wikidataQid: null,
    };
  }

  const gapPlatforms = new Set<ArtistSocialPlatform>();
  if (!existingPlatforms.has("tiktok")) {
    gapPlatforms.add("tiktok");
  }
  if (!existingPlatforms.has("youtube")) {
    gapPlatforms.add("youtube");
  }

  const firecrawlSocials = await resolveGapViaFirecrawl(
    artist.name,
    artist.spotify_url,
    mbResult.mbid,
    gapPlatforms,
  );

  // ── 3. Persist ─────────────────────────────────────────────────────────────
  await persistResolution(
    artistId,
    mbResult.mbid,
    mbResult.wikidataQid,
    mbResult.socials,
    firecrawlSocials,
  );

  return {
    artistId,
    mbid: mbResult.mbid,
    rateLimited: false,
    socials: [...mbResult.socials, ...firecrawlSocials],
    wikidataQid: mbResult.wikidataQid,
  };
}

// ── Queue helpers (for the sweep) ─────────────────────────────────────────────

type UnresolvedArtistRow = {
  id: string;
  name: string;
};

// A finished-but-empty artist (resolved_at stamped, zero socials) is re-queued once
// its stamp is older than this — so a transient MB failure (a 503 window, an ISRC gap
// since closed, a namesake we couldn't yet disambiguate) self-heals on the next sweep
// instead of sticking on 0 socials forever. Artists that DO have socials are never
// re-queued; a genuinely social-less artist re-tries at most once per window.
const STALE_EMPTY_RETRY_DAYS = 30;

/**
 * Fetch a bounded page of artists the sweep should (re)resolve — the worklist.
 * Includes both the never-resolved (`resolved_at IS NULL`) and the self-healing
 * set: artists resolved to ZERO socials whose stamp is older than
 * `STALE_EMPTY_RETRY_DAYS`. Cursor-paged by artist id (same opaque convention as
 * the backfills).
 */
export async function listUnresolvedArtists(
  limit: number,
  cursor?: string,
): Promise<{ artists: UnresolvedArtistRow[]; nextCursor: string | null }> {
  const db = await getDb();
  const batchLimit = Math.min(Math.max(1, limit), 50);

  const staleBefore = new Date(
    Date.now() - STALE_EMPTY_RETRY_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  // Eligible = never resolved, OR resolved-but-empty and stale (0 socials + old stamp).
  const eligible = `(
    resolved_at is null
    or (
      resolved_at < ?
      and id not in (select distinct artist_id from artist_socials)
    )
  )`;

  const rows = typedRows<UnresolvedArtistRow>(
    (
      await db.execute({
        args: cursor ? [staleBefore, cursor, batchLimit] : [staleBefore, batchLimit],
        sql: cursor
          ? `select id, name from artists where ${eligible} and id > ?
             order by id asc limit ?`
          : `select id, name from artists where ${eligible}
             order by id asc limit ?`,
      })
    ).rows,
  );

  const nextCursor = rows.length === batchLimit ? (rows[rows.length - 1]?.id ?? null) : null;

  return { artists: rows, nextCursor };
}
