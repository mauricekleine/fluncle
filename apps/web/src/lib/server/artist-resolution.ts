import { slugify } from "@fluncle/contracts/util/galaxy-slug";
import { randomUUID } from "node:crypto";

import { type ArtistSocialPlatform, isHttpUrl } from "../artist-socials";
import { getDb, typedRow, typedRows } from "./db";
import { readOptionalEnv } from "./env";
import { logEvent } from "./log";
import { mbFetch, setMusicbrainzRateLimitForTests } from "./musicbrainz";
import { getYouTubeAccessToken } from "./youtube";

const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape";
const FIRECRAWL_SEARCH_URL = "https://api.firecrawl.dev/v2/search";

const FIRECRAWL_TIMEOUT_MS = 45_000;
const YOUTUBE_CHANNELS_API = "https://www.googleapis.com/youtube/v3/channels?part=id&maxResults=1";

const YOUTUBE_RESOLVE_TIMEOUT_MS = 10_000;

export function __setRateLimitForTests(ms: number): void {
  setMusicbrainzRateLimitForTests(ms);
}

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

type MbAlias = {
  name?: string;
  type?: string | null;
};

type MbArtistResponse = {
  id?: string;
  name?: string;
  relations?: MbUrlRel[];
  aliases?: MbAlias[];
  error?: unknown;
};

type FirecrawlScrapeResponse = {
  success?: boolean;
  data?: { json?: Partial<Record<ArtistSocialPlatform, string>> };
};

type FirecrawlSearchResponse = {
  success?: boolean;
  data?: { web?: Array<{ url?: string }> } | Array<{ url?: string }>;
};

export type ResolvedSocial = {
  platform: ArtistSocialPlatform;
  url: string;
  source: "musicbrainz" | "firecrawl";
};

export type ResolvedAlias = {
  alias: string;
  slug: string;
  kind: "name" | "hint";
};

export type ArtistResolutionResult = {
  artistId: string;
  mbid: string | null;
  wikidataQid: string | null;

  discogsUrl: string | null;
  lastfmUrl: string | null;
  socials: ResolvedSocial[];
  rateLimited: boolean;
};

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

export function isLinkHubUrl(resource: string): boolean {
  try {
    return LINK_HUB_HOSTS.has(new URL(resource).hostname.replace(/^www\./, ""));
  } catch {
    return false;
  }
}

export function classifyMbUrl(
  resource: string,
  relType?: string | null,
): ArtistSocialPlatform | "wikidata" | null {
  let host: string;

  try {
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
  if (host === "bsky.app") {
    return "bluesky";
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
  if (host === "twitch.tv") {
    return "twitch";
  }
  if (host === "wikidata.org") {
    return "wikidata";
  }

  if (LINK_HUB_HOSTS.has(host) || METADATA_HOSTS.has(host)) {
    return null;
  }

  if (relType === "official homepage") {
    return "homepage";
  }

  return null;
}

export function classifyMbAnchorUrl(resource: string): "discogs" | "lastfm" | null {
  let host: string;
  let path: string;

  try {
    const url = new URL(resource);

    host = url.hostname.replace(/^www\./, "");
    path = url.pathname;
  } catch {
    return null;
  }

  if (host === "discogs.com" && path.startsWith("/artist/")) {
    return "discogs";
  }

  if (host === "last.fm" && path.startsWith("/music/")) {
    return "lastfm";
  }

  return null;
}

function stripQuery(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return `${u.origin}${u.pathname}`.replace(/\/$/, "");
  } catch {
    return rawUrl;
  }
}

function firstPathSegment(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).pathname.split("/").filter(Boolean)[0] ?? null;
  } catch {
    return null;
  }
}

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

function extractTikTokHandle(rawUrl: string): string | null {
  try {
    const pathname = new URL(rawUrl).pathname;
    const match = pathname.match(/^\/@?([^/]+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function extractBlueskyHandle(rawUrl: string): string | null {
  try {
    const segments = new URL(rawUrl).pathname.split("/").filter(Boolean);

    return segments[0]?.toLowerCase() === "profile" ? (segments[1] ?? null) : null;
  } catch {
    return null;
  }
}

function extractInstagramHandle(rawUrl: string): string | null {
  try {
    const pathname = new URL(rawUrl).pathname;
    const match = pathname.match(/^\/([^/]+)\/?$/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

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

      signal: AbortSignal.timeout(YOUTUBE_RESOLVE_TIMEOUT_MS),
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

async function normalizeYouTubeUrl(rawUrl: string): Promise<string | null> {
  try {
    const u = new URL(rawUrl);
    const pathname = u.pathname;

    if (pathname.startsWith("/channel/")) {
      const channelId = pathname.split("/")[2];

      return channelId ? `https://www.youtube.com/channel/${channelId}` : null;
    }

    if (pathname.startsWith("/@")) {
      return await resolveYouTubeHandleToChannelUrl(rawUrl);
    }

    if (pathname.startsWith("/user/") || pathname.startsWith("/c/")) {
      return stripQuery(rawUrl);
    }

    if (pathname.startsWith("/watch") || pathname.startsWith("/playlist")) {
      return null;
    }

    return stripQuery(rawUrl);
  } catch {
    return null;
  }
}

export async function normalizeProfileUrl(
  platform: ArtistSocialPlatform,
  rawUrl: string,
): Promise<string | null> {
  if (!isHttpUrl(rawUrl)) {
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

    case "bluesky": {
      const handle = extractBlueskyHandle(rawUrl);
      return handle ? `https://bsky.app/profile/${handle}` : null;
    }

    case "youtube":
      return normalizeYouTubeUrl(rawUrl);

    case "spotify": {
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

    case "twitch":
      return profileRootFromFirstSegment(
        rawUrl,
        "https://www.twitch.tv",
        new Set(["videos", "clips", "directory", "p", "about", "schedule", "settings", "team"]),
      );

    case "bandcamp": {
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

const SOCIAL_DISPLAY_NAMES: Record<ArtistSocialPlatform, string> = {
  bandcamp: "Bandcamp",
  beatport: "Beatport",
  bluesky: "Bluesky",
  facebook: "Facebook",
  homepage: "homepage",
  instagram: "Instagram",
  mixcloud: "Mixcloud",
  soundcloud: "SoundCloud",
  spotify: "Spotify",
  tiktok: "TikTok",
  twitch: "Twitch",
  twitter: "Twitter / X",
  youtube: "YouTube",
};

export type SocialUrlValidation = { ok: true; url: string } | { ok: false; reason: string };

export async function validateSocialUrlForPlatform(
  platform: ArtistSocialPlatform,
  rawUrl: string,
): Promise<SocialUrlValidation> {
  const trimmed = rawUrl.trim();

  if (!trimmed) {
    return { ok: false, reason: "A URL is required" };
  }

  if (!isHttpUrl(trimmed)) {
    return { ok: false, reason: "Only http and https links are allowed" };
  }

  const classified = classifyMbUrl(trimmed);

  if (platform === "homepage") {
    if (classified && classified !== "wikidata") {
      return {
        ok: false,
        reason: `That's a ${SOCIAL_DISPLAY_NAMES[classified]} link, not a homepage`,
      };
    }
  } else if (classified !== platform) {
    return { ok: false, reason: `Not a ${SOCIAL_DISPLAY_NAMES[platform]} link` };
  }

  const normalized = await normalizeProfileUrl(platform, trimmed);

  if (!normalized) {
    return { ok: false, reason: `Not a ${SOCIAL_DISPLAY_NAMES[platform]} profile link` };
  }

  return { ok: true, url: normalized };
}

function mbNameMatch(mbName: string, artistName: string): boolean {
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .replace(/[^a-z0-9]/g, "");

  return normalize(mbName) === normalize(artistName);
}

export function luceneEscapePhrase(value: string): string {
  return value.replace(/[\\"]/g, "\\$&");
}

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

const NAME_SEARCH_SCORE_THRESHOLD = 90;

const NAME_SEARCH_LIMIT = 5;
const NAME_SEARCH_MAX_DEEP_FETCH = 5;

async function extractSocialsFromArtistData(artistData: MbArtistResponse): Promise<{
  socials: ResolvedSocial[];
  wikidataQid: string | null;
  discogsUrl: string | null;
  lastfmUrl: string | null;
  hubUrls: string[];
}> {
  const socials: ResolvedSocial[] = [];
  const hubUrls: string[] = [];
  let wikidataQid: string | null = null;
  let discogsUrl: string | null = null;
  let lastfmUrl: string | null = null;

  for (const relation of artistData.relations ?? []) {
    const resource = relation.url?.resource;

    if (!resource) {
      continue;
    }

    const anchor = classifyMbAnchorUrl(resource);

    if (anchor) {
      if (anchor === "discogs") {
        discogsUrl ??= stripQuery(resource);
      } else {
        lastfmUrl ??= stripQuery(resource);
      }

      continue;
    }

    if (isLinkHubUrl(resource)) {
      hubUrls.push(resource);
      continue;
    }

    const classification = classifyMbUrl(resource, relation.type);

    if (!classification) {
      continue;
    }

    if (classification === "wikidata") {
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

    if (classification === "homepage") {
      hubUrls.push(normalizedUrl);
    }

    if (!socials.some((s) => s.platform === classification)) {
      socials.push({ platform: classification, source: "musicbrainz", url: normalizedUrl });
    }
  }

  return { discogsUrl, hubUrls, lastfmUrl, socials, wikidataQid };
}

export function extractAliasesFromArtistData(
  artistData: MbArtistResponse,
  canonicalName: string,
): ResolvedAlias[] {
  const canonicalSlug = slugify(canonicalName);
  const aliases: ResolvedAlias[] = [];
  const seen = new Set<string>([canonicalSlug]);

  for (const alias of artistData.aliases ?? []) {
    const name = alias.name?.trim();

    if (!name) {
      continue;
    }

    const slug = slugify(name);

    if (!slug || seen.has(slug)) {
      continue;
    }

    seen.add(slug);
    aliases.push({ alias: name, kind: alias.type === "Search hint" ? "hint" : "name", slug });
  }

  return aliases;
}

type MbResolution = {
  mbid: string | null;
  wikidataQid: string | null;

  discogsUrl: string | null;
  lastfmUrl: string | null;
  socials: ResolvedSocial[];

  aliases: ResolvedAlias[];
  rateLimited: boolean;

  mbSocialStatus: "auto" | "candidate";

  hubUrls: string[];
};

function emptyResolution(mbid: string | null, rateLimited: boolean): MbResolution {
  return {
    aliases: [],
    discogsUrl: null,
    hubUrls: [],
    lastfmUrl: null,
    mbSocialStatus: "candidate",
    mbid,
    rateLimited,
    socials: [],
    wikidataQid: null,
  };
}

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

  let anyCandidateHadSpotifyRel = false;

  let fallbackCandidate: MbArtistSearchCandidate | null = null;
  let fallbackData: MbArtistResponse | null = null;

  for (let i = 0; i < deepFetchCount; i += 1) {
    const candidate = candidates[i];
    const candidateId = candidate?.id;

    if (!candidateId) {
      continue;
    }

    const artistResult = await mbFetch<MbArtistResponse>(
      `/artist/${encodeURIComponent(candidateId)}?inc=url-rels+aliases`,
    );

    if (artistResult.rateLimited) {
      return emptyResolution(null, true);
    }

    const artistData = artistResult.data;

    if (!artistData || artistData.error) {
      continue;
    }

    const candidateSpotifyId = spotifyArtistIdFromRelations(artistData.relations);

    if (spotifyArtistId && candidateSpotifyId && candidateSpotifyId === spotifyArtistId) {
      const { socials, wikidataQid, discogsUrl, lastfmUrl, hubUrls } =
        await extractSocialsFromArtistData(artistData);

      return {
        aliases: extractAliasesFromArtistData(artistData, trimmedName),
        discogsUrl,
        hubUrls,
        lastfmUrl,
        mbSocialStatus: "auto",
        mbid: candidateId,
        rateLimited: false,
        socials,
        wikidataQid,
      };
    }

    if (candidateSpotifyId) {
      anyCandidateHadSpotifyRel = true;
      continue;
    }

    if (
      fallbackCandidate === null &&
      (candidate?.score ?? 0) >= NAME_SEARCH_SCORE_THRESHOLD &&
      mbNameMatch(candidate?.name ?? "", trimmedName)
    ) {
      fallbackCandidate = candidate;
      fallbackData = artistData;
    }
  }

  if (!anyCandidateHadSpotifyRel && fallbackCandidate?.id && fallbackData) {
    const { socials, wikidataQid, discogsUrl, lastfmUrl, hubUrls } =
      await extractSocialsFromArtistData(fallbackData);

    return {
      aliases: extractAliasesFromArtistData(fallbackData, trimmedName),
      discogsUrl,
      hubUrls,
      lastfmUrl,
      mbSocialStatus: "candidate",
      mbid: fallbackCandidate.id,
      rateLimited: false,
      socials,
      wikidataQid,
    };
  }

  return emptyResolution(null, false);
}

const FIRECRAWL_TARGETS: ArtistSocialPlatform[] = [
  "instagram",
  "tiktok",
  "bluesky",
  "youtube",
  "soundcloud",
  "bandcamp",
  "twitter",
  "facebook",
  "mixcloud",
  "twitch",
  "beatport",
];

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

const ARTIST_SEARCH_CONTEXT = "drum and bass";

async function findHubViaSearch(artistName: string, apiKey: string): Promise<string | null> {
  const urls = await firecrawlSearch(
    `"${artistName}" ${ARTIST_SEARCH_CONTEXT} linktree official links`,
    apiKey,
    8,
  );
  return urls.find(isLinkHubUrl) ?? null;
}

function bucketSearchUrl(url: string): ArtistSocialPlatform | null {
  const classification = classifyMbUrl(url);
  return classification && classification !== "wikidata" ? classification : null;
}

const HANDLE_IN_FIRST_SEGMENT = new Set<ArtistSocialPlatform>([
  "instagram",
  "tiktok",
  "twitter",
  "soundcloud",
  "mixcloud",
  "facebook",
  "twitch",
]);

function artistNameTokens(artistName: string): string[] {
  const full = artistName.toLowerCase().replace(/[^a-z0-9]/g, "");
  const words = artistName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);

  return [...new Set(full.length >= 3 ? [full, ...words] : words)];
}

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

  if (!spotifyUrl && !mbid && mbHubUrls.length === 0) {
    return [];
  }

  const apiKey = await readOptionalEnv("FIRECRAWL_API_KEY");

  if (!apiKey) {
    return [];
  }

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

  for (const hubUrl of new Set(mbHubUrls)) {
    if (remaining().length === 0) {
      break;
    }

    await absorbHub(await scrapeHubForSocials(hubUrl, remaining(), apiKey));
  }

  if (remaining().length > 0) {
    const hubUrl = await findHubViaSearch(artistName, apiKey);

    if (hubUrl) {
      await absorbHub(await scrapeHubForSocials(hubUrl, remaining(), apiKey));
    }
  }

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

async function fetchArtist(artistId: string): Promise<ArtistRow | null> {
  const db = await getDb();

  const artistResult = await db.execute({
    args: [artistId],
    sql: `select id, name, spotify_artist_id, spotify_url, mbid, resolved_at
          from artists where id = ? limit 1`,
  });

  return typedRow<ArtistRow>(artistResult.rows) ?? null;
}

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

export async function persistResolution(
  artistId: string,
  mbid: string | null,
  wikidataQid: string | null,
  mbSocials: ResolvedSocial[],
  mbSocialStatus: "auto" | "candidate",
  firecrawlSocials: ResolvedSocial[],
  mbAliases: ResolvedAlias[] = [],
  anchors: { discogsUrl: string | null; lastfmUrl: string | null } = {
    discogsUrl: null,
    lastfmUrl: null,
  },
): Promise<void> {
  const db = await getDb();
  const nowIso = new Date().toISOString();

  await db.execute({
    args: [mbid, wikidataQid, anchors.discogsUrl, anchors.lastfmUrl, nowIso, nowIso, artistId],
    sql: `update artists
          set mbid = coalesce(?, mbid),
              wikidata_qid = coalesce(?, wikidata_qid),
              discogs_url = coalesce(?, discogs_url),
              lastfm_url = coalesce(?, lastfm_url),
              resolved_at = ?,
              updated_at = ?
          where id = ?`,
  });

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
              (id, artist_id, platform, url, source, status, reviewed_at, created_at, updated_at)
            values (?, ?, ?, ?, ?, ?, null, ?, ?)
            on conflict(artist_id, platform) do update set
              url = excluded.url,
              source = excluded.source,
              status = excluded.status,
              reviewed_at = case
                when artist_socials.url != excluded.url then null
                else artist_socials.reviewed_at
              end,
              updated_at = excluded.updated_at
            where artist_socials.source != 'operator'
              and artist_socials.status != 'confirmed'`,
    });
  }

  for (const social of firecrawlSocials) {
    const id = randomUUID();
    await db.execute({
      args: [id, artistId, social.platform, social.url, "firecrawl", "candidate", nowIso, nowIso],

      sql: `insert into artist_socials
              (id, artist_id, platform, url, source, status, reviewed_at, created_at, updated_at)
            values (?, ?, ?, ?, ?, ?, null, ?, ?)
            on conflict(artist_id, platform) do nothing`,
    });
  }

  for (const alias of mbAliases) {
    await db.execute({
      args: [`aa_${randomUUID()}`, artistId, alias.alias, alias.slug, alias.kind, nowIso],
      sql: `insert into artist_aliases
              (id, artist_id, alias, alias_slug, source, kind, status, created_at)
            values (?, ?, ?, ?, 'musicbrainz', ?, 'auto', ?)
            on conflict(artist_id, alias_slug, source) do nothing`,
    });
  }
}

export async function resolveArtist(artistId: string): Promise<ArtistResolutionResult> {
  const artist = await fetchArtist(artistId);

  if (!artist) {
    throw new Error(`Artist not found: ${artistId}`);
  }

  const mbResult = await resolveArtistViaMb(artist.name, artist.spotify_artist_id);

  const existingPlatforms = await fetchExistingPlatforms(artistId);

  for (const s of mbResult.socials) {
    existingPlatforms.add(s.platform);
  }

  if (mbResult.rateLimited) {
    return {
      artistId,
      discogsUrl: null,
      lastfmUrl: null,
      mbid: null,
      rateLimited: true,
      socials: [],
      wikidataQid: null,
    };
  }

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

  await persistResolution(
    artistId,
    mbResult.mbid,
    mbResult.wikidataQid,
    mbResult.socials,
    mbResult.mbSocialStatus,
    firecrawlSocials,
    mbResult.aliases,
    { discogsUrl: mbResult.discogsUrl, lastfmUrl: mbResult.lastfmUrl },
  );

  return {
    artistId,
    discogsUrl: mbResult.discogsUrl,
    lastfmUrl: mbResult.lastfmUrl,
    mbid: mbResult.mbid,
    rateLimited: false,
    socials: [...mbResult.socials, ...firecrawlSocials],
    wikidataQid: mbResult.wikidataQid,
  };
}

type UnresolvedArtistRow = {
  id: string;
  name: string;
};

const STALE_EMPTY_RETRY_DAYS = 30;

export async function listUnresolvedArtists(
  limit: number,
  cursor?: string,
): Promise<{ artists: UnresolvedArtistRow[]; nextCursor: string | null }> {
  const db = await getDb();
  const batchLimit = Math.min(Math.max(1, limit), 50);

  const staleBefore = new Date(
    Date.now() - STALE_EMPTY_RETRY_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

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
