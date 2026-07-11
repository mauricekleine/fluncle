// Artist social resolution pipeline (Unit 2.1 of the artist-relationship RFC).
//
// Resolves an artist's cross-platform social identity into `artist_socials` rows:
//
//   1. MusicBrainz (primary): a NAME search — /ws/2/artist?query=artist:"<name>" —
//      cross-referenced against the artist's stored Spotify id. Each top candidate's
//      /ws/2/artist/<mbid>?inc=url-rels is deep-fetched; the candidate whose Spotify
//      url-rel id equals ours is the definitive identity match (accepted even over a
//      higher-scored candidate). A candidate whose Spotify rel DIFFERS is a namesake
//      and is rejected. Only when NO candidate exposes any Spotify rel to cross-check
//      do we fall back to a name+score match; otherwise the artist stays unresolved
//      rather than resolve to a namesake. The matched MBID's url-rels are classified
//      by host. MB url-rels are human-curated → status="auto" (trusted). Also stamps
//      `artists.mbid` + `artists.wikidata_qid`.
//
//      (ISRC-based MBID lookup was retired: DnB ISRCs are frequently absent from MB's
//      index and the walk landed on empty/wrong MBIDs, resolving most artists to 0–1
//      links. Name-search + Spotify cross-reference is the correct, durable identity.)
//
//   2. Firecrawl (gap-fill): fills every missing social platform except homepage (MB
//      covers it) and spotify (always known — it's the identity key), CHEAPEST source
//      first — scrape a link hub MB already gave us (linktree/homepage), else /v2/search
//      for the hub then scrape it, else a broad /v2/search bucketed by host. Uses the
//      Worker-held FIRECRAWL_API_KEY. Gap-fill rows → status="candidate" (operator-review
//      gated). (/v2/extract was retired — it never polled its async job AND only scraped
//      the Spotify-SPA seed, so it silently returned nothing for every artist.)
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
import { logEvent } from "./log";
import { mbFetch, setMusicbrainzRateLimitForTests } from "./musicbrainz";
import { getYouTubeAccessToken } from "./youtube";

// ── Constants ────────────────────────────────────────────────────────────────

// Firecrawl gap-fill endpoints. /v2/extract was RETIRED: it's async (the code never
// polled the returned job id → it read `data` off the initial POST, which is always
// empty → the gap-fill was a silent no-op for every artist) AND it only reads the seed
// URL you hand it — seeded with the Spotify SPA (which lists no socials) it found
// nothing. The replacements read a page that ACTUALLY lists the socials: /v2/scrape
// (JSON mode) over a link hub (linktree/homepage), and /v2/search for real web search.
const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape";
const FIRECRAWL_SEARCH_URL = "https://api.firecrawl.dev/v2/search";
// A hard per-call ceiling so a slow/hung hub scrape can't stall the resolve (a real
// homepage can be very slow; best-effort → abort and move on).
const FIRECRAWL_TIMEOUT_MS = 45_000;
const YOUTUBE_CHANNELS_API = "https://www.googleapis.com/youtube/v3/channels?part=id&maxResults=1";

// ── Rate limiter ─────────────────────────────────────────────────────────────
// The MB gate lives in ./musicbrainz.ts — the ONE client every MB caller in the
// Worker shares (this resolver, the Discogs bridge, the catalogue crawler), so they
// share one honest 1 req/s budget instead of keeping three and tripling the real rate.

/** Test seam: set the pacing floor to run without real timers. */
export function __setRateLimitForTests(ms: number): void {
  setMusicbrainzRateLimitForTests(ms);
}

// ── Platform type ─────────────────────────────────────────────────────────────

export type ArtistSocialPlatform =
  | "spotify"
  | "youtube"
  | "mixcloud"
  | "soundcloud"
  | "instagram"
  | "tiktok"
  | "bandcamp"
  | "beatport"
  | "twitter"
  | "facebook"
  | "homepage";

// ── MB types ─────────────────────────────────────────────────────────────────

type MbArtistSearchCandidate = {
  id?: string;
  name?: string;
  score?: number;
};

type MbArtistSearchResponse = {
  artists?: MbArtistSearchCandidate[];
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

// ── Firecrawl types ───────────────────────────────────────────────────────────

// /v2/scrape JSON mode answers synchronously with the extracted object under
// `data.json` — one string URL per requested platform key (built from the missing
// targets at call time, so widen to a partial platform map). "" means the hub page
// didn't list that platform.
type FirecrawlScrapeResponse = {
  success?: boolean;
  data?: { json?: Partial<Record<ArtistSocialPlatform, string>> };
};

// /v2/search groups hits by source; we only read the `web` results' URLs. Tolerate a
// bare-array `data` shape too (defensive — the field has shifted across versions).
type FirecrawlSearchResponse = {
  success?: boolean;
  data?: { web?: Array<{ url?: string }> } | Array<{ url?: string }>;
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

// Link HUBS — a page whose whole job is to list an artist's profiles (a linktree). MB
// sometimes carries one; it's the ideal free scrape seed (one call → every social), so
// the resolver CAPTURES these as hub URLs rather than discarding them.
const LINK_HUB_HOSTS = new Set([
  "linktr.ee",
  "lnk.to",
  "linkfire.com",
  "allmylinks.com",
  "link.tl",
  "komi.io",
  "beacons.ai",
  "ffm.to",
]);

// METADATA sites — catalogue/discography pages, NOT the artist's own link list. Their
// footers don't carry the socials, so scraping one just burns a call; keep dropping them.
const METADATA_HOSTS = new Set([
  "musicbrainz.org",
  "discogs.com",
  "last.fm",
  "allmusic.com",
  "rateyourmusic.com",
  "genius.com",
  "songkick.com",
  "setlist.fm",
]);

/** True when a URL is a link-hub (linktr.ee/lnk.to/…) — a scrapeable list of socials. */
export function isLinkHubUrl(resource: string): boolean {
  try {
    return LINK_HUB_HOSTS.has(new URL(resource).hostname.replace(/^www\./, ""));
  } catch {
    return false;
  }
}

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
  if (host === "beatport.com") {
    return "beatport";
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

  // Link hubs + metadata sites are never a "social" row: a hub is captured separately as
  // a scrape seed (see isLinkHubUrl / extractSocialsFromArtistData), a metadata site is
  // dropped outright.
  if (LINK_HUB_HOSTS.has(host) || METADATA_HOSTS.has(host)) {
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

/** The first non-empty path segment of a URL (the username slot on most socials), or null. */
function firstPathSegment(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).pathname.split("/").filter(Boolean)[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Reduce a username-in-first-segment social URL to its profile root — so a scraped/searched
 * DEEP link (a SoundCloud track, a Facebook post, a tweet) canonicalizes to the profile
 * instead of being stored verbatim. Returns null when the first segment is a known
 * non-profile section (a track list, a post) rather than a handle. Idempotent on MB's
 * already-clean profile URLs.
 */
function profileRootFromFirstSegment(
  rawUrl: string,
  base: string,
  nonProfile: Set<string>,
): string | null {
  const segment = firstPathSegment(rawUrl);

  if (!segment || nonProfile.has(segment.toLowerCase())) {
    return null;
  }

  return `${base}/${segment}`;
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
// social row (stored-XSS defense at ingestion; the operator confirm + render guards are
// the second layer).
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

    case "soundcloud":
      return profileRootFromFirstSegment(
        rawUrl,
        "https://soundcloud.com",
        new Set(["tracks", "sets", "reposts", "likes", "following", "followers", "popular-tracks"]),
      );

    case "mixcloud":
      return profileRootFromFirstSegment(
        rawUrl,
        "https://www.mixcloud.com",
        new Set(["discover", "categories", "live", "select"]),
      );

    case "facebook":
      return profileRootFromFirstSegment(
        rawUrl,
        "https://www.facebook.com",
        new Set([
          "p",
          "posts",
          "photo",
          "photos",
          "watch",
          "events",
          "groups",
          "pages",
          "story.php",
        ]),
      );

    case "twitter":
      return profileRootFromFirstSegment(
        rawUrl,
        "https://twitter.com",
        new Set(["i", "status", "home", "search", "hashtag", "intent", "share"]),
      );

    case "bandcamp": {
      // The subdomain IS the identity (nutone.bandcamp.com); reduce to the origin so a
      // /track or /album deep link collapses to the artist page.
      try {
        return new URL(rawUrl).origin;
      } catch {
        return null;
      }
    }

    default:
      return stripQuery(rawUrl) || null;
  }
}

// ── MB fetch helper ────────────────────────────────────────────────────────────
// `mbFetch` is the shared client (./musicbrainz.ts): 1 req/s, an identifiable
// User-Agent, Retry-After honoured on a 503, and `rateLimited` reported honestly.

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

// ── Lucene / Spotify-id helpers (for the name search + cross-reference) ────────

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
// NO candidate exposed a Spotify url-rel to cross-check against. Paired with an exact
// name match, this biases hard toward correctness — a wrong social link on a public
// artist page is worse than a missing one.
const NAME_SEARCH_SCORE_THRESHOLD = 90;

// How many name-search hits MB returns, and how many of the top ones we deep-fetch
// url-rels for (each deep-fetch is 1 req/s under MB's limit). Name search is now the
// primary — not a fallback — so we examine the full returned set to give the Spotify
// cross-reference the best chance of finding the identity match.
const NAME_SEARCH_LIMIT = 5;
const NAME_SEARCH_MAX_DEEP_FETCH = 5;

// ── URL-rel classification ────────────────────────────────────────────────────

/** Classify an MB artist's url-rels into resolved socials + the Wikidata QID. */
async function extractSocialsFromArtistData(
  artistData: MbArtistResponse,
): Promise<{ socials: ResolvedSocial[]; wikidataQid: string | null; hubUrls: string[] }> {
  const socials: ResolvedSocial[] = [];
  const hubUrls: string[] = [];
  let wikidataQid: string | null = null;

  for (const relation of artistData.relations ?? []) {
    const resource = relation.url?.resource;

    if (!resource) {
      continue;
    }

    // A link hub (linktr.ee/lnk.to/…) isn't a social row — capture it as a scrape seed
    // for the Firecrawl gap-fill (one scrape → every social it lists) instead of dropping it.
    if (isLinkHubUrl(resource)) {
      hubUrls.push(resource);
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

    // A homepage is also a scrapeable hub — an artist's own site footer usually lists
    // every social — so seed the gap-fill with it in addition to storing it as a social.
    if (classification === "homepage") {
      hubUrls.push(normalizedUrl);
    }

    // Deduplicate by platform (first wins).
    if (!socials.some((s) => s.platform === classification)) {
      socials.push({ platform: classification, source: "musicbrainz", url: normalizedUrl });
    }
  }

  return { hubUrls, socials, wikidataQid };
}

// ── MB artist resolution (name search + Spotify cross-reference) ───────────────

type MbResolution = {
  mbid: string | null;
  wikidataQid: string | null;
  socials: ResolvedSocial[];
  rateLimited: boolean;
  // The trust the MB socials persist at: an exact Spotify-id identity match earns "auto"
  // (public/trusted); the weaker name+score soft fallback is downgraded to "candidate"
  // (awaits an operator glance before it can surface publicly). Meaningless when there
  // are no socials — defaults to "candidate", the harmless floor.
  mbSocialStatus: "auto" | "candidate";
  // Link hubs (linktree/homepage) MB carried — the free scrape seeds for the gap-fill.
  hubUrls: string[];
};

function emptyResolution(mbid: string | null, rateLimited: boolean): MbResolution {
  return {
    hubUrls: [],
    mbSocialStatus: "candidate",
    mbid,
    rateLimited,
    socials: [],
    wikidataQid: null,
  };
}

/**
 * Resolve an artist's socials + KG anchors via MusicBrainz, name-search primary:
 *
 *   1. Search MB by artist NAME: /ws/2/artist?query=artist:"<lucene-escaped>".
 *   2. Deep-fetch each top candidate's `inc=url-rels`.
 *   3. Definitive match (auto): a candidate whose Spotify url-rel id === the stored
 *      `spotify_artist_id` is our artist — accept it immediately, even over a
 *      higher-scored candidate. Identity confirmed.
 *   4. Namesake reject: a candidate whose Spotify rel is present but DIFFERS is a
 *      different artist — never accept it.
 *   5. Soft fallback (candidate): only when NO candidate exposed ANY Spotify rel to
 *      cross-check against, accept the top candidate on a strong MB `score` (≥ threshold)
 *      plus an exact normalized name match — but at LOWER trust (`mbSocialStatus`
 *      "candidate": awaits an operator glance, never public until confirmed), since there
 *      was no identity confirmation. Otherwise stay unresolved rather than resolve to a
 *      namesake — the downstream Firecrawl gap-fill / operator review takes it.
 *
 * The matched MBID's url-rels are classified into socials. The whole walk is throttled
 * at 1 req/s (per-isolate serial gate). ISRC-based MBID lookup was retired (see header).
 */
export async function resolveArtistViaMb(
  artistName: string,
  spotifyArtistId: string | null,
): Promise<MbResolution> {
  const trimmedName = artistName.trim();

  if (!trimmedName) {
    return emptyResolution(null, false);
  }

  const query = `artist:"${luceneEscapePhrase(trimmedName)}"`;
  const searchResult = await mbFetch<MbArtistSearchResponse>(
    `/artist?query=${encodeURIComponent(query)}&limit=${NAME_SEARCH_LIMIT}`,
  );

  if (searchResult.rateLimited) {
    return emptyResolution(null, true);
  }

  const candidates = searchResult.data?.artists;

  if (searchResult.data?.error || !Array.isArray(candidates) || candidates.length === 0) {
    return emptyResolution(null, false);
  }

  const deepFetchCount = Math.min(candidates.length, NAME_SEARCH_MAX_DEEP_FETCH);

  // Whether any examined candidate carried a Spotify url-rel at all. If one did and none
  // matched ours, we're in namesake territory (MB tracks Spotify for this name-space and
  // our id isn't among the hits) → disable the soft name+score fallback: better a miss.
  let anyCandidateHadSpotifyRel = false;

  // The best-scored candidate we could examine that had NO Spotify rel — the only kind
  // eligible for the soft fallback. First (highest-scored) one wins.
  let fallbackCandidate: MbArtistSearchCandidate | null = null;
  let fallbackData: MbArtistResponse | null = null;

  for (let i = 0; i < deepFetchCount; i += 1) {
    const candidate = candidates[i];
    const candidateId = candidate?.id;

    if (!candidateId) {
      continue;
    }

    const artistResult = await mbFetch<MbArtistResponse>(
      `/artist/${encodeURIComponent(candidateId)}?inc=url-rels`,
    );

    if (artistResult.rateLimited) {
      return emptyResolution(null, true);
    }

    const artistData = artistResult.data;

    if (!artistData || artistData.error) {
      continue;
    }

    const candidateSpotifyId = spotifyArtistIdFromRelations(artistData.relations);

    // (3) Definitive identity match — accept immediately, even over a higher score.
    // Identity confirmed by the Spotify cross-reference → socials are trusted (auto).
    if (spotifyArtistId && candidateSpotifyId && candidateSpotifyId === spotifyArtistId) {
      const { socials, wikidataQid, hubUrls } = await extractSocialsFromArtistData(artistData);

      return {
        hubUrls,
        mbSocialStatus: "auto",
        mbid: candidateId,
        rateLimited: false,
        socials,
        wikidataQid,
      };
    }

    // (4) Candidate carries a Spotify rel we could check and it didn't match → namesake.
    // Record that a cross-check signal existed; never let it become the soft fallback.
    if (candidateSpotifyId) {
      anyCandidateHadSpotifyRel = true;
      continue;
    }

    // (5) No Spotify rel on this candidate — eligible for the soft name+score fallback.
    // Keep the first (highest-scored) qualifier; keep looping for a possible (3) match.
    if (
      fallbackCandidate === null &&
      (candidate?.score ?? 0) >= NAME_SEARCH_SCORE_THRESHOLD &&
      mbNameMatch(candidate?.name ?? "", trimmedName)
    ) {
      fallbackCandidate = candidate;
      fallbackData = artistData;
    }
  }

  // No definitive match. Only take the soft fallback when NOTHING gave us a Spotify rel
  // to cross-check — otherwise a namesake would slip through on name+score alone. The
  // fallback is name+score only (no identity confirmation) → its socials persist as
  // "candidate", never public until an operator confirms them.
  if (!anyCandidateHadSpotifyRel && fallbackCandidate?.id && fallbackData) {
    const { socials, wikidataQid, hubUrls } = await extractSocialsFromArtistData(fallbackData);

    return {
      hubUrls,
      mbSocialStatus: "candidate",
      mbid: fallbackCandidate.id,
      rateLimited: false,
      socials,
      wikidataQid,
    };
  }

  return emptyResolution(null, false);
}

// ── Firecrawl gap-fill ────────────────────────────────────────────────────────

// The social platforms Firecrawl is allowed to backfill. Deliberately EXCLUDES
// `homepage` (MB covers it ~11/12 and a "find the homepage" extract returns junk
// like Wikipedia) and `spotify` (always known — it's the identity key). Everything
// Firecrawl returns persists as status="candidate" (operator-review gated), so the
// wider net stays accuracy-safe. The order feeds the schema + prompt render order.
const FIRECRAWL_TARGETS: ArtistSocialPlatform[] = [
  "instagram",
  "tiktok",
  "youtube",
  "soundcloud",
  "bandcamp",
  "twitter",
  "facebook",
  "mixcloud",
  "beatport",
];

/**
 * Build the /v2/scrape JSON-mode extract (schema + prompt) for a link-hub page: one
 * string property per still-missing platform. `""` = the hub didn't list that platform.
 */
function buildHubExtract(targets: ArtistSocialPlatform[]): { prompt: string; schema: object } {
  const schema = {
    properties: Object.fromEntries(
      targets.map((p) => [
        p,
        { description: `Official ${p} profile URL, or "" if absent`, type: "string" },
      ]),
    ),
    type: "object",
  };

  const prompt = `From this artist's link page, extract the official ${targets.join(
    ", ",
  )} profile URL(s) actually linked on the page. Use "" for any that are absent.`;

  return { prompt, schema };
}

/**
 * A Firecrawl POST with a hard abort timeout. Returns parsed JSON, or null on any
 * non-2xx / network error / timeout (best-effort — the gap-fill never throws).
 */
async function firecrawlPost<T>(url: string, body: unknown, apiKey: string): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FIRECRAWL_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      body: JSON.stringify(body),
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      method: "POST",
      signal: controller.signal,
    });

    if (!response.ok) {
      logEvent("warn", "artist-resolution.firecrawl-failed", { status: response.status, url });
      return null;
    }

    return (await response.json()) as T;
  } catch (err) {
    logEvent("warn", "artist-resolution.firecrawl-error", { error: err, url });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Scrape ONE link hub (a linktree/homepage) with /v2/scrape JSON mode → the missing
 * platforms it lists. /v2/scrape reads the URL you hand it, so this only works on a page
 * that ACTUALLY lists the socials (a hub) — never on the Spotify SPA. Best-effort → {}.
 */
async function scrapeHubForSocials(
  hubUrl: string,
  targets: ArtistSocialPlatform[],
  apiKey: string,
): Promise<Partial<Record<ArtistSocialPlatform, string>>> {
  if (targets.length === 0) {
    return {};
  }

  const { prompt, schema } = buildHubExtract(targets);
  const payload = await firecrawlPost<FirecrawlScrapeResponse>(
    FIRECRAWL_SCRAPE_URL,
    { formats: [{ prompt, schema, type: "json" }], url: hubUrl },
    apiKey,
  );

  const json = payload?.data?.json;

  if (!payload?.success || !json) {
    return {};
  }

  const found: Partial<Record<ArtistSocialPlatform, string>> = {};

  for (const platform of targets) {
    const raw = json[platform];

    if (typeof raw === "string" && raw.trim()) {
      found[platform] = raw.trim();
    }
  }

  return found;
}

/** Real web search via /v2/search → the hit URLs (best-effort; [] on failure). */
async function firecrawlSearch(query: string, apiKey: string, limit: number): Promise<string[]> {
  const payload = await firecrawlPost<FirecrawlSearchResponse>(
    FIRECRAWL_SEARCH_URL,
    { limit, query },
    apiKey,
  );

  const data = payload?.data;
  const rows = Array.isArray(data) ? data : (data?.web ?? []);

  return rows.map((r) => r.url).filter((u): u is string => typeof u === "string");
}

// Fluncle's entire archive is drum & bass, so every artist is a DnB act — appending this
// to a web search disambiguates HARD against same-name artists in other genres. It's the
// difference between soundcloud.com/nutone and a random "nu-tone" namesake: without it a
// broad search returns whatever ranks for the bare name (wrong artists), with it the DnB
// act's real profiles rank first. Validated live on Nu:Tone across every platform.
const ARTIST_SEARCH_CONTEXT = "drum and bass";

/** The link-hub URL (linktr.ee/lnk.to/…) a web search surfaces for an artist, or null. */
async function findHubViaSearch(artistName: string, apiKey: string): Promise<string | null> {
  const urls = await firecrawlSearch(
    `"${artistName}" ${ARTIST_SEARCH_CONTEXT} linktree official links`,
    apiKey,
    8,
  );
  return urls.find(isLinkHubUrl) ?? null;
}

/** Bucket a web-search result URL to one of the gap-fill target platforms (or null). */
function bucketSearchUrl(url: string): ArtistSocialPlatform | null {
  const classification = classifyMbUrl(url);
  return classification && classification !== "wikidata" ? classification : null;
}

// Platforms whose profile handle IS the first path segment — so a search result's handle
// can be name-checked to reject a namesake/label (a TikTok search for an act with none
// returns the label's account). The rest are exempt: YouTube resolves to an opaque
// /channel/<id>, Bandcamp's identity is the subdomain, Beatport's is /artist/<slug>/<id> —
// name-checking the first segment there would wrongly drop correct hits.
const HANDLE_IN_FIRST_SEGMENT = new Set<ArtistSocialPlatform>([
  "instagram",
  "tiktok",
  "twitter",
  "soundcloud",
  "mixcloud",
  "facebook",
]);

/** Name tokens for the relatedness check: the full concatenation + each ≥3-char word. */
function artistNameTokens(artistName: string): string[] {
  const full = artistName.toLowerCase().replace(/[^a-z0-9]/g, "");
  const words = artistName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);

  return [...new Set(full.length >= 3 ? [full, ...words] : words)];
}

/**
 * A safe namesake guard for a Stage-3 search hit: on the first-segment platforms, the
 * result's handle must share a name token with the artist. Exempt (always true) for the
 * platforms whose handle isn't the first segment, and when the artist name yields no
 * usable token. Kills a label/namesake account a bare-platform search returns.
 */
function searchHitLooksRelated(
  platform: ArtistSocialPlatform,
  url: string,
  tokens: string[],
): boolean {
  if (!HANDLE_IN_FIRST_SEGMENT.has(platform) || tokens.length === 0) {
    return true;
  }

  const segment = firstPathSegment(url);

  if (!segment) {
    return false;
  }

  const handle = segment
    .replace(/^@/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

  if (!handle) {
    return false;
  }

  return tokens.some((token) => handle.includes(token) || token.includes(handle));
}

/**
 * Fill the social platforms MB didn't resolve, cheapest source first so we spend the
 * fewest Firecrawl credits:
 *
 *   1. Scrape any link hub MB already handed us (homepage / linktr.ee) — /v2/scrape JSON,
 *      one call → every social the hub lists. FREE discovery (MB gave us the URL).
 *   2. Still missing → /v2/search for the artist's link hub, then scrape it.
 *   3. Still missing → a DISAMBIGUATED per-platform web search, taking the first result
 *      that both host-matches the platform AND reduces to a profile root (so a video/post
 *      is skipped). Per-platform + the DnB context keeps the RIGHT artist's profile on top.
 *
 * (/v2/extract was retired — see the FIRECRAWL_* constants. It never polled its async job
 * AND only read the Spotify-SPA seed, so it returned nothing for every artist.)
 *
 * Every hit is stored already normalized to its canonical profile root, and returned as a
 * candidate row (status set to "candidate" at persist). Best-effort throughout — never throws.
 */
export async function resolveGapViaFirecrawl(
  artistName: string,
  spotifyUrl: string | null,
  mbid: string | null,
  missingPlatforms: Set<ArtistSocialPlatform>,
  mbHubUrls: string[],
): Promise<ResolvedSocial[]> {
  const targets = FIRECRAWL_TARGETS.filter((p) => missingPlatforms.has(p));

  if (targets.length === 0) {
    return [];
  }

  // Need SOME identity anchor before spending on a name-based web search — an MB hub, an
  // MB identity match, or the Spotify URL. Otherwise a bare name search risks a namesake.
  if (!spotifyUrl && !mbid && mbHubUrls.length === 0) {
    return [];
  }

  const apiKey = await readOptionalEnv("FIRECRAWL_API_KEY");

  if (!apiKey) {
    return [];
  }

  // `found` holds the canonical profile root per platform (normalized at insertion, so a
  // deep link / video is dropped here, not later).
  const found = new Map<ArtistSocialPlatform, string>();
  const remaining = (): ArtistSocialPlatform[] => targets.filter((p) => !found.has(p));

  const tryAdd = async (platform: ArtistSocialPlatform, rawUrl: string): Promise<void> => {
    if (found.has(platform) || !targets.includes(platform)) {
      return;
    }

    const normalized = await normalizeProfileUrl(platform, rawUrl);

    if (normalized) {
      found.set(platform, normalized);
    }
  };

  const absorbHub = async (map: Partial<Record<ArtistSocialPlatform, string>>): Promise<void> => {
    for (const [platform, url] of Object.entries(map)) {
      if (url) {
        await tryAdd(platform as ArtistSocialPlatform, url);
      }
    }
  };

  // Stage 1 — scrape the hubs MB already handed us (free; dedupe URLs).
  for (const hubUrl of new Set(mbHubUrls)) {
    if (remaining().length === 0) {
      break;
    }

    await absorbHub(await scrapeHubForSocials(hubUrl, remaining(), apiKey));
  }

  // Stage 2 — no MB hub covered it: search for the artist's link hub, then scrape it.
  if (remaining().length > 0) {
    const hubUrl = await findHubViaSearch(artistName, apiKey);

    if (hubUrl) {
      await absorbHub(await scrapeHubForSocials(hubUrl, remaining(), apiKey));
    }
  }

  // Stage 3 — per-platform disambiguated search (parallel), first related profile-root wins.
  const stillMissing = remaining();

  if (stillMissing.length > 0) {
    const tokens = artistNameTokens(artistName);

    await Promise.all(
      stillMissing.map(async (platform) => {
        const urls = await firecrawlSearch(
          `"${artistName}" ${ARTIST_SEARCH_CONTEXT} ${platform}`,
          apiKey,
          6,
        );

        for (const url of urls) {
          if (bucketSearchUrl(url) === platform && searchHitLooksRelated(platform, url, tokens)) {
            await tryAdd(platform, url);

            if (found.has(platform)) {
              break;
            }
          }
        }
      }),
    );
  }

  return [...found].map(([platform, url]) => ({ platform, source: "firecrawl", url }));
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

type ExistingSocialRow = {
  platform: string;
};

/**
 * Fetch an artist for the MB name search. Its `spotify_artist_id` is the identity the
 * name-search cross-reference matches against; `spotify_url` seeds the Firecrawl gap-fill.
 */
async function fetchArtist(artistId: string): Promise<ArtistRow | null> {
  const db = await getDb();

  const artistResult = await db.execute({
    args: [artistId],
    sql: `select id, name, spotify_artist_id, spotify_url, mbid, resolved_at
          from artists where id = ? limit 1`,
  });

  return typedRow<ArtistRow>(artistResult.rows) ?? null;
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
 *
 * OPERATOR ROWS ARE IMMUNE. A re-resolve never overwrites a link the operator owns — one
 * they ADDED (`source='operator'`) or CONFIRMED (`status='confirmed'`): its url, source,
 * AND status all stay exactly as the operator left them (the MB upsert's WHERE clause skips
 * those rows entirely, and the Firecrawl upsert is `do nothing`). Only machine rows
 * (`auto`/`candidate`) get refreshed — so MB confirming a platform still promotes a
 * firecrawl `candidate` to `auto`.
 *
 * `mbSocialStatus` carries the MB socials' trust: "auto" (public/trusted) for an exact
 * Spotify-id identity match, "candidate" (awaits an operator glance) for the weaker
 * name+score soft fallback.
 */
export async function persistResolution(
  artistId: string,
  mbid: string | null,
  wikidataQid: string | null,
  mbSocials: ResolvedSocial[],
  mbSocialStatus: "auto" | "candidate",
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

  // Upsert MB socials at the resolver-determined trust (auto for a confirmed identity,
  // candidate for the soft name+score fallback). The WHERE clause makes an OPERATOR-OWNED
  // row immune: a re-resolve skips (leaves untouched) any row the operator added
  // (source='operator') or confirmed (status='confirmed') — url, source, and status all
  // preserved. Only auto/candidate machine rows are refreshed to the fresh MB values.
  for (const social of mbSocials) {
    const id = randomUUID();
    await db.execute({
      args: [
        id,
        artistId,
        social.platform,
        social.url,
        "musicbrainz",
        mbSocialStatus,
        nowIso,
        nowIso,
      ],
      sql: `insert into artist_socials
              (id, artist_id, platform, url, source, status, created_at, updated_at)
            values (?, ?, ?, ?, ?, ?, ?, ?)
            on conflict(artist_id, platform) do update set
              url = excluded.url,
              source = excluded.source,
              status = excluded.status,
              updated_at = excluded.updated_at
            where artist_socials.source != 'operator'
              and artist_socials.status != 'confirmed'`,
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
 * name search (cross-referenced by Spotify id) then the Firecrawl gap-fill,
 * persists results, and returns a summary.
 *
 * This is the Worker-side logic behind the `resolve_artist` oRPC op. The box's
 * `fluncle-artist-sweep` cron drives it per unresolved artist via the CLI.
 */
export async function resolveArtist(artistId: string): Promise<ArtistResolutionResult> {
  const artist = await fetchArtist(artistId);

  if (!artist) {
    throw new Error(`Artist not found: ${artistId}`);
  }

  // ── 1. MusicBrainz name search + Spotify-id cross-reference ────────────────
  const mbResult = await resolveArtistViaMb(artist.name, artist.spotify_artist_id);

  // ── 2. Firecrawl gap-fill (every missing social except homepage + spotify) ──
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

  // Every Firecrawl-eligible platform not already resolved (by MB or a prior sweep).
  const gapPlatforms = new Set<ArtistSocialPlatform>();
  for (const platform of FIRECRAWL_TARGETS) {
    if (!existingPlatforms.has(platform)) {
      gapPlatforms.add(platform);
    }
  }

  const firecrawlSocials = await resolveGapViaFirecrawl(
    artist.name,
    artist.spotify_url,
    mbResult.mbid,
    gapPlatforms,
    mbResult.hubUrls,
  );

  // ── 3. Persist ─────────────────────────────────────────────────────────────
  await persistResolution(
    artistId,
    mbResult.mbid,
    mbResult.wikidataQid,
    mbResult.socials,
    mbResult.mbSocialStatus,
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
// its stamp is older than this — so a transient MB failure (a 503 window, a namesake we
// couldn't yet disambiguate, an artist MB has since gained a Spotify rel for) self-heals
// on the next sweep instead of sticking on 0 socials forever. Artists that DO have
// socials are never re-queued; a genuinely social-less artist re-tries at most once per
// window.
const STALE_EMPTY_RETRY_DAYS = 30;

/**
 * Fetch a bounded page of artists the sweep should (re)resolve — the worklist.
 * Includes both the never-resolved (`resolved_at IS NULL`) and the self-healing set:
 * artists resolved to ZERO socials whose stamp is older than `STALE_EMPTY_RETRY_DAYS`.
 * Cursor-paged by artist id (same opaque convention as the backfills).
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
