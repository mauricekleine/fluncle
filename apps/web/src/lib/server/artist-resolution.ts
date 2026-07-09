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
//   2. Firecrawl /v2/extract (gap-fill): every missing social platform except
//      homepage (MB covers it and "find the homepage" returns junk) and spotify
//      (always known — it's the identity key). Uses the Worker-held FIRECRAWL_API_KEY.
//      Gap-fill rows → status="candidate" (operator-review gated).
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

// Firecrawl returns one string URL per requested platform key. The schema is built
// from FIRECRAWL_TARGETS at call time, so widen `data` to a partial map keyed by any
// platform — `payload.data?.[platform]` reads each target's URL.
type FirecrawlExtractData = Partial<Record<ArtistSocialPlatform, string>>;

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
};

function emptyResolution(mbid: string | null, rateLimited: boolean): MbResolution {
  return { mbSocialStatus: "candidate", mbid, rateLimited, socials: [], wikidataQid: null };
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
      const { socials, wikidataQid } = await extractSocialsFromArtistData(artistData);

      return {
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
    const { socials, wikidataQid } = await extractSocialsFromArtistData(fallbackData);

    return {
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
 * The human prose label for a platform inside the Firecrawl prompt/schema description.
 * Only `twitter` renders as "Twitter/X" — the schema property KEY stays the platform
 * string (`twitter`) so `payload.data.twitter` reads back cleanly.
 */
function firecrawlPlatformProse(platform: ArtistSocialPlatform): string {
  return platform === "twitter" ? "Twitter/X" : platform;
}

/**
 * Use Firecrawl /v2/extract to fill in the social platforms MB didn't resolve —
 * every FIRECRAWL_TARGETS platform that's genuinely missing (homepage + spotify are
 * never targeted). One /v2/extract call, one schema property per missing target.
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
  // Only the Firecrawl-eligible platforms that are actually missing.
  const targets = FIRECRAWL_TARGETS.filter((p) => missingPlatforms.has(p));

  if (targets.length === 0) {
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

  const schema = {
    properties: Object.fromEntries(
      targets.map((p) => [
        p,
        { description: `Official ${firecrawlPlatformProse(p)} profile URL`, type: "string" },
      ]),
    ),
    type: "object",
  };

  const prompt = `Extract the official ${targets
    .map(firecrawlPlatformProse)
    .join(
      ", ",
    )} profile URL(s) for the music artist "${artistName}". Return only verified official accounts.`;

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

  for (const platform of targets) {
    const raw = payload.data[platform];

    if (!raw) {
      continue;
    }

    // normalizeProfileUrl handles every platform (explicit for tiktok/instagram/
    // youtube/spotify, stripQuery default for the rest incl. beatport).
    const normalized = await normalizeProfileUrl(platform, raw);

    if (normalized) {
      socials.push({ platform, source: "firecrawl", url: normalized });
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
 * The upsert strategy: a new source always wins on url (MB is more reliable than
 * Firecrawl; if MB and Firecrawl both have a platform, MB's row already exists and
 * the Firecrawl upsert skips it via the `do nothing` guard).
 *
 * `mbSocialStatus` carries the MB socials' trust: "auto" (public/trusted) for an exact
 * Spotify-id identity match, "candidate" (awaits an operator glance) for the weaker
 * name+score soft fallback. The `when status='confirmed' then 'confirmed'` guard still
 * preserves an operator-confirmed row on re-resolve regardless.
 */
async function persistResolution(
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
  // candidate for the soft name+score fallback).
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
