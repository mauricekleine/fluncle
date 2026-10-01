import { type TrackSearchResult } from "@fluncle/contracts";
import { publicTrackWhere } from "../../db/public-track-visibility";
import { siteUrl } from "../fluncle-links";
import { toFtsMatch } from "../search-query";
import { getDb, typedRows } from "./db";
import { searchDeezerSubmissionTracks } from "./deezer";
import { logEvent } from "./log";
import { assertRateLimit } from "./rate-limit";
import { ftsSearchRows } from "./search";
import { parseSpotifyTrackUrl, searchTrackCandidates } from "./spotify";
import { normalizeIsrc } from "./track-match";

export const SEARCH_TRACKS_LIMIT = 30;
export const SEARCH_TRACKS_WINDOW_MS = 60 * 1000;

const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX_ENTRIES = 500;
const SEARCH_RESULT_LIMIT = 8;
const searchCache = new Map<string, { expiresAt: number; results: TrackSearchResult[] }>();

type CatalogueCandidateRow = {
  album: string | null;
  album_image_url: string | null;
  artists_json: string;
  duration_ms: number | null;
  isrc: string | null;
  spotify_uri: string | null;
  spotify_url: string | null;
  title: string;
  track_id: string;
};

type CandidateWithIdentity = TrackSearchResult & { isrc?: string };

export async function searchTracks({
  query,
  request,
}: {
  query: string;
  request: Request;
}): Promise<TrackSearchResult[]> {
  await assertRateLimit({
    action: "search_tracks",
    limit: SEARCH_TRACKS_LIMIT,
    request,
    windowMs: SEARCH_TRACKS_WINDOW_MS,
  });

  return cachedSearch(query);
}

async function cachedSearch(query: string): Promise<TrackSearchResult[]> {
  const key = query.toLowerCase();
  const now = Date.now();
  const hit = searchCache.get(key);

  if (hit && hit.expiresAt > now) {
    return hit.results;
  }

  const spotifyId = spotifyTrackId(query);
  const [catalogue, deezer] = await Promise.all([
    searchCatalogueCandidates(query).catch((error: unknown) => {
      logEvent("warn", "search-tracks.catalogue-failed", { error });
      return [];
    }),
    spotifyId
      ? Promise.resolve([])
      : searchDeezerSubmissionTracks(query, SEARCH_RESULT_LIMIT).catch((error: unknown) => {
          logEvent("warn", "deezer.submit-search-threw", { error });
          return [];
        }),
  ]);
  const firstTwo = uniqueCandidates([...catalogue, ...deezer]);
  let spotify: TrackSearchResult[] = [];

  if (firstTwo.length === 0) {
    try {
      spotify = (await searchTrackCandidates(query, "public_search")).slice(0, SEARCH_RESULT_LIMIT);
    } catch (error) {
      logEvent("warn", "search-tracks.spotify-failed", { error });
    }
  }

  const results = uniqueCandidates([...firstTwo, ...spotify])
    .slice(0, SEARCH_RESULT_LIMIT)
    .map(({ isrc: _isrc, ...candidate }) => candidate);

  searchCache.set(key, { expiresAt: now + CACHE_TTL_MS, results });

  if (searchCache.size > CACHE_MAX_ENTRIES) {
    const oldest = searchCache.keys().next().value;

    if (oldest !== undefined) {
      searchCache.delete(oldest);
    }
  }

  return results;
}

function uniqueCandidates(candidates: CandidateWithIdentity[]): CandidateWithIdentity[] {
  const seenIsrc = new Set<string>();
  const seenId = new Set<string>();

  return candidates.filter((candidate) => {
    const isrc = normalizeIsrc(candidate.isrc ?? null);
    const id = `${candidate.provider ?? "spotify"}:${candidate.id}`;

    if ((isrc && seenIsrc.has(isrc)) || seenId.has(id)) {
      return false;
    }

    if (isrc) {
      seenIsrc.add(isrc);
    }

    seenId.add(id);
    return true;
  });
}

function spotifyTrackId(query: string): string | undefined {
  try {
    return parseSpotifyTrackUrl(query);
  } catch {
    return undefined;
  }
}

async function searchCatalogueCandidates(query: string): Promise<TrackSearchResult[]> {
  const spotifyId = spotifyTrackId(query);
  const match = spotifyId ? null : toFtsMatch(query);

  if (!spotifyId && !match) {
    return [];
  }

  const rows = spotifyId
    ? typedRows<CatalogueCandidateRow>(
        (
          await (
            await getDb()
          ).execute({
            args: [`spotify:track:${spotifyId}`],
            sql: `select tracks.track_id, tracks.title, tracks.artists_json, tracks.album,
                     tracks.album_image_url, tracks.duration_ms, tracks.isrc, tracks.spotify_uri, tracks.spotify_url
              from tracks left join findings on findings.track_id = tracks.track_id
              where tracks.spotify_uri = ? and ${publicTrackWhere("tracks", "findings")}
              limit 1`,
          })
        ).rows,
      )
    : await ftsSearchRows(match ?? "", SEARCH_RESULT_LIMIT, true);

  return rows.flatMap((row) => {
    const id = spotifyTrackId(row.spotify_url ?? "") ?? spotifyTrackId(row.spotify_uri ?? "");

    if (!id && (!row.isrc || typeof row.duration_ms !== "number" || row.duration_ms <= 0)) {
      return [];
    }

    let artists: string[];

    try {
      const parsed: unknown = JSON.parse(row.artists_json);
      artists = Array.isArray(parsed)
        ? parsed.filter((artist): artist is string => typeof artist === "string")
        : [];
    } catch {
      artists = [];
    }

    return [
      {
        album: row.album ?? undefined,
        artists,
        artworkUrl: row.album_image_url ?? undefined,
        durationMs: row.duration_ms ?? undefined,
        id: id ?? row.track_id,
        ...(id ? {} : { externalUrl: `${siteUrl}/track/${encodeURIComponent(row.track_id)}` }),
        isrc: row.isrc ?? undefined,
        provider: id ? ("spotify" as const) : ("catalogue" as const),
        spotifyUrl: id ? `https://open.spotify.com/track/${id}` : "",
        title: row.title,
      },
    ];
  });
}

export function __resetSearchCache(): void {
  searchCache.clear();
}
