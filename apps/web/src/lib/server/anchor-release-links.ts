import { getDb, typedRows } from "./db";
import { logEvent } from "./log";
import { mbFetch } from "./musicbrainz";
import { anchorSpotifySearchAllowed, recordAnchorSpotifyCall } from "./anchor-spotify-search";
import { fetchSpotifyAlbumTracks, type SpotifyAlbumTrack } from "./spotify";
import { ANCHOR_RULED_OUT_LABEL_CLAUSE, anchorEligibilityClause } from "./track-work";

const CACHE_SECONDS = 30 * 24 * 60 * 60;
const MISS_BACKOFF_MS = CACHE_SECONDS * 1000;
const FETCH_FAILURE_SECONDS = 24 * 60 * 60;

type RecordingResponse = { releases?: { id?: string }[] };
type ReleaseResponse = {
  media?: { tracks?: { recording?: { id?: string } }[] }[];
  relations?: { url?: { resource?: string } }[];
};

type ReleaseEvidence = {
  albumId: null | string;
  checkedAt: null | string;
  recordingIds: string[];
  releaseId: string;
  siblingTrackIds: string[];
  tracks: SpotifyAlbumTrack[];
};

export type ReleaseLinkResult = {
  anchored: boolean;
  anchoredCount: number;
  albumFetchFailed: number;
  albumsFetched: number;
  backoffSkipped: number;
  cacheHits: number;
  noAlbum: number;
  remainder: null | number;
  throttled: boolean;
  verifiedBy: "isrc" | "search" | "search-subset" | null;
};

export type ReleaseLinkProbe = {
  evidence: ReleaseEvidence[];
  issuedAt: number;
  result: ReleaseLinkResult;
  trackId: string;
};

export function emptyReleaseLinkResult(): ReleaseLinkResult {
  return {
    albumFetchFailed: 0,
    albumsFetched: 0,
    anchored: false,
    anchoredCount: 0,
    backoffSkipped: 0,
    cacheHits: 0,
    noAlbum: 0,
    remainder: null,
    throttled: false,
    verifiedBy: null,
  };
}

function albumIdFromRelease(release: ReleaseResponse): string | null {
  for (const relation of release.relations ?? []) {
    const url = relation.url?.resource;
    if (!url) {
      continue;
    }
    try {
      const parsed = new URL(url);
      const match = /^\/album\/([A-Za-z0-9]{22})\/?$/.exec(parsed.pathname);
      if (parsed.hostname === "open.spotify.com" && match?.[1]) {
        return match[1];
      }
    } catch {
      continue;
    }
  }
  return null;
}

function normalizedTracks(value: unknown): SpotifyAlbumTrack[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const tracks: SpotifyAlbumTrack[] = [];
  for (const item of value) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.spotifyTrackId !== "string" ||
      typeof item.title !== "string" ||
      !Array.isArray(item.artists) ||
      !Number.isFinite(item.durationMs) ||
      !Number.isFinite(item.discNumber) ||
      !Number.isFinite(item.trackNumber) ||
      (item.isrc !== null && typeof item.isrc !== "string")
    ) {
      continue;
    }
    const artists: SpotifyAlbumTrack["artists"] = [];
    for (const artist of item.artists) {
      if (artist && typeof artist.id === "string" && typeof artist.name === "string") {
        artists.push({ id: artist.id, name: artist.name });
      }
    }
    if (artists.length === 0) {
      continue;
    }
    tracks.push({
      artists,
      discNumber: item.discNumber,
      durationMs: item.durationMs,
      isrc: item.isrc,
      spotifyTrackId: item.spotifyTrackId,
      title: item.title,
      trackNumber: item.trackNumber,
    });
  }
  return tracks;
}

export async function isEligibleReleaseSibling(trackId: string): Promise<boolean> {
  const db = await getDb();
  const eligibility = anchorEligibilityClause();
  const result = await db.execute({
    args: [trackId, ...eligibility.args],
    sql: `select 1 from tracks t left join findings f on f.track_id = t.track_id
      where t.track_id = ? and t.spotify_uri is null and t.is_catalogue = 1 and f.track_id is null
      and ${ANCHOR_RULED_OUT_LABEL_CLAUSE} and ${eligibility.sql}
      limit 1`,
  });
  return result.rows.length > 0;
}

async function eligibleSiblingIds(recordingIds: string[]): Promise<string[]> {
  if (recordingIds.length === 0) {
    return [];
  }
  const db = await getDb();
  const eligibility = anchorEligibilityClause();
  const ids = new Set<string>();
  for (let offset = 0; offset < recordingIds.length; offset += 250) {
    const chunk = recordingIds.slice(offset, offset + 250);
    const rows = typedRows<{ track_id: string }>(
      (
        await db.execute({
          args: [...chunk, ...eligibility.args],
          sql: `select t.track_id from tracks t left join findings f on f.track_id = t.track_id
        where t.mb_recording_id in (${chunk.map(() => "?").join(",")})
        and t.spotify_uri is null and t.is_catalogue = 1 and f.track_id is null
        and ${ANCHOR_RULED_OUT_LABEL_CLAUSE} and ${eligibility.sql}`,
        })
      ).rows,
    );
    for (const row of rows) {
      ids.add(row.track_id);
    }
  }
  return [...ids].sort();
}

// oxlint-disable-next-line complexity
export async function probeReleaseLinks(
  trackId: string,
  recordingMbid: null | string,
  now: Date,
  spotifyAllowed: boolean,
): Promise<ReleaseLinkProbe> {
  const probe: ReleaseLinkProbe = {
    evidence: [],
    issuedAt: Date.now(),
    result: emptyReleaseLinkResult(),
    trackId,
  };
  if (!recordingMbid) {
    return probe;
  }
  const { env } = await import("cloudflare:workers").catch(() => ({ env: undefined }));
  const cache = env?.SPOTIFY_ALBUM_TRACKS;
  if (!cache) {
    return probe;
  }
  const db = await getDb();
  const existing = await db.execute({
    args: [trackId],
    sql: "select spotify_anchor_source, spotify_anchor_verified_by from tracks where track_id = ? and spotify_uri is not null",
  });
  if (existing.rows[0]?.spotify_anchor_source === "release-link") {
    const via = existing.rows[0]?.spotify_anchor_verified_by;
    probe.result.anchored = true;
    probe.result.verifiedBy =
      via === "isrc" || via === "search" || via === "search-subset" ? via : null;
    return probe;
  }
  const releaseKey = `recording-releases:${recordingMbid}`;
  let releaseIds: string[] | null = null;
  try {
    const cached: unknown = await cache.get(releaseKey, "json");
    if (Array.isArray(cached) && cached.every((id) => typeof id === "string")) {
      releaseIds = cached.slice(0, 3);
      probe.result.cacheHits += 1;
    }
  } catch (error) {
    logEvent("warn", "anchor.release-cache-read-failed", { error, recordingMbid });
  }
  if (!releaseIds) {
    const recording = await mbFetch<RecordingResponse>(
      `/recording/${encodeURIComponent(recordingMbid)}?inc=releases`,
    );
    if (!recording.data) {
      return probe;
    }
    releaseIds = [...new Set((recording.data.releases ?? []).map((item) => item.id))]
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .slice(0, 3);
    try {
      await cache.put(releaseKey, JSON.stringify(releaseIds), { expirationTtl: CACHE_SECONDS });
    } catch (error) {
      logEvent("warn", "anchor.release-cache-write-failed", { error, recordingMbid });
    }
  }
  for (const releaseId of releaseIds) {
    const prior = typedRows<{ checked_at: string; spotify_album_id: null | string }>(
      (
        await db.execute({
          args: [releaseId],
          sql: "select checked_at, spotify_album_id from anchor_release_links where release_mbid = ?",
        })
      ).rows,
    )[0];
    if (
      prior &&
      now.getTime() - Date.parse(prior.checked_at) < MISS_BACKOFF_MS &&
      !prior.spotify_album_id
    ) {
      probe.result.backoffSkipped += 1;
      continue;
    }
    const release = await mbFetch<ReleaseResponse>(
      `/release/${encodeURIComponent(releaseId)}?inc=recordings+url-rels`,
    );
    if (!release.data) {
      continue;
    }
    const freshMapping = prior && now.getTime() - Date.parse(prior.checked_at) < MISS_BACKOFF_MS;
    const albumId = freshMapping ? prior.spotify_album_id : albumIdFromRelease(release.data);
    const evidence: ReleaseEvidence = {
      albumId,
      checkedAt: freshMapping ? null : now.toISOString(),
      recordingIds: [
        ...new Set(
          (release.data.media ?? []).flatMap((medium) =>
            (medium.tracks ?? []).map((item) => item.recording?.id),
          ),
        ),
      ].filter((id): id is string => typeof id === "string" && id.length > 0),
      releaseId,
      siblingTrackIds: [],
      tracks: [],
    };
    probe.evidence.push(evidence);
    if (!albumId) {
      probe.result.noAlbum += 1;
      continue;
    }
    const key = `album:${albumId}`;
    try {
      const cached: unknown = await cache.get(key, "json");
      const normalized = normalizedTracks(cached);
      if (normalized) {
        evidence.tracks = normalized;
        probe.result.cacheHits += 1;
        evidence.siblingTrackIds = await eligibleSiblingIds(evidence.recordingIds);
        continue;
      }
      if (await cache.get(`album-error:${albumId}`)) {
        probe.result.backoffSkipped += 1;
        continue;
      }
    } catch (error) {
      logEvent("warn", "anchor.release-cache-read-failed", { albumId, error });
    }
    if (!spotifyAllowed || !(await anchorSpotifySearchAllowed(new Date()))) {
      continue;
    }
    try {
      const fetched = await fetchSpotifyAlbumTracks(albumId, async () => {
        const pageNow = new Date();
        if (!(await anchorSpotifySearchAllowed(pageNow))) {
          throw new Error("Spotify anchor gate closed");
        }
        await recordAnchorSpotifyCall(pageNow);
      });
      evidence.tracks = normalizedTracks(fetched) ?? [];
      probe.result.albumsFetched += 1;
    } catch (error) {
      if (error instanceof Error && error.message === "Spotify anchor gate closed") {
        continue;
      }
      const throttled = error instanceof Error && error.message.includes("429");
      probe.result.throttled ||= throttled;
      if (!throttled) {
        probe.result.albumFetchFailed += 1;
        try {
          await cache.put(`album-error:${albumId}`, "1", { expirationTtl: FETCH_FAILURE_SECONDS });
        } catch (cacheError) {
          logEvent("warn", "anchor.release-cache-write-failed", { albumId, error: cacheError });
        }
      }
      logEvent("warn", "anchor.release-album-fetch-failed", { albumId, error });
      if (throttled) {
        break;
      }
      continue;
    }
    try {
      if (evidence.tracks.length > 0) {
        await cache.put(key, JSON.stringify(evidence.tracks), { expirationTtl: CACHE_SECONDS });
      }
    } catch (error) {
      logEvent("warn", "anchor.release-cache-write-failed", { albumId, error });
    }
    if (evidence.tracks.length > 0) {
      evidence.siblingTrackIds = await eligibleSiblingIds(evidence.recordingIds);
    }
  }
  return probe;
}

export async function commitReleaseLinks(
  probe: ReleaseLinkProbe,
  anchor: (trackId: string, tracks: SpotifyAlbumTrack[]) => Promise<boolean>,
  cursor = 0,
): Promise<ReleaseLinkResult> {
  const result = emptyReleaseLinkResult();
  const db = await getDb();
  if (cursor === 0) {
    for (const evidence of probe.evidence) {
      if (!evidence.checkedAt) {
        continue;
      }
      await db.execute({
        args: [evidence.releaseId, evidence.albumId, evidence.checkedAt],
        sql: `insert into anchor_release_links (release_mbid, spotify_album_id, checked_at)
              values (?, ?, ?) on conflict(release_mbid) do update set
              spotify_album_id = excluded.spotify_album_id, checked_at = excluded.checked_at
              where excluded.checked_at > anchor_release_links.checked_at`,
      });
    }
  }
  const siblings = probe.evidence.flatMap((evidence) =>
    evidence.tracks.length > 0
      ? evidence.siblingTrackIds.map((trackId) => ({ trackId, tracks: evidence.tracks }))
      : [],
  );
  const deadline = Date.now() + 12_000;
  for (let index = cursor; index < siblings.length; index += 1) {
    if (Date.now() >= deadline) {
      result.remainder = index;
      break;
    }
    const sibling = siblings[index];
    if (!sibling) {
      continue;
    }
    try {
      if (await anchor(sibling.trackId, sibling.tracks)) {
        result.anchoredCount += 1;
      }
    } catch (error) {
      logEvent("warn", "anchor.release-sibling-failed", { error, trackId: sibling.trackId });
    }
  }
  const current = await db.execute({
    args: [probe.trackId],
    sql: "select spotify_anchor_source, spotify_anchor_verified_by from tracks where track_id = ? and spotify_uri is not null",
  });
  if (current.rows[0]?.spotify_anchor_source === "release-link") {
    result.anchored = true;
    const via = current.rows[0]?.spotify_anchor_verified_by;
    result.verifiedBy = via === "isrc" || via === "search" || via === "search-subset" ? via : null;
  }
  return result;
}

export async function resolveReleaseLinks(
  trackId: string,
  recordingMbid: null | string,
  now: Date,
  spotifyAllowed: boolean,
  anchor: (trackId: string, tracks: SpotifyAlbumTrack[]) => Promise<boolean>,
): Promise<ReleaseLinkResult> {
  const probe = await probeReleaseLinks(trackId, recordingMbid, now, spotifyAllowed);
  const result = probe.result;
  let cursor = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const committed = await commitReleaseLinks(probe, anchor, cursor);
    result.anchoredCount += committed.anchoredCount;
    result.anchored ||= committed.anchored;
    result.verifiedBy ??= committed.verifiedBy;
    if (committed.remainder === null) {
      break;
    }
    cursor = committed.remainder;
  }
  return result;
}
