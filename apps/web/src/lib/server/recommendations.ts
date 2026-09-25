import { bestAlbumCoverUrl } from "../media";
import { REC_ELIGIBLE_WHERE } from "../catalogue-eligibility";
import { parseArtistsJson } from "./artists";
import { TRACK_OR_LOG_ID_CTE } from "./track-id-resolver";
import { DUPLICATE_SIMILARITY, diversifyRanked, LONG_FORM_MS } from "./catalogue";
import { getDb, typedRow, typedRows } from "./db";
import { cosineFromDistance, readEmbeddingBlob, toVectorProbe } from "./embedding";
import { jsonError } from "./env";
import { type PublicUser } from "./public-auth";
import {
  isSonarRecsCatalogueEnabled,
  isSonarRecsEnabled,
  searchSonar,
  type SonarMatch,
} from "./sonar";
import { executeVectorFallback, vectorFallbackCandidateLimitSql } from "./vector-fallback";

export const MAX_REC_SEEDS = 12;

export const RECOMMENDATIONS_PAGE = 30;

export const RECOMMENDATIONS_POOL = RECOMMENDATIONS_PAGE * 3 + 25;

export const FINDINGS_SLOT_COUNT = 3;

export const FRONTIER_NOVELTY_WINDOW = 8;

export const RECOMMENDATIONS_RATE_LIMIT = 60;
export const RECOMMENDATIONS_RATE_WINDOW_MS = 60 * 60 * 1000;

export { REC_ELIGIBLE_WHERE } from "../catalogue-eligibility";

type TrackRefRow = {
  log_id: null | string;
  track_id: string;
};

type SeedListRow = {
  added_at: string;
  album_image_key: null | string;
  album_image_state: null | string;
  album_image_updated_at: null | string;
  album_image_url: null | string;
  artists_json: string;
  log_id: null | string;
  title: string;
  track_id: string;
};

type SeedVectorRow = {
  embedding_blob: unknown;
  track_id: string;
};

type ScanRow = {
  dist: number | null;
  track_id: string;
};

type HydrateRow = {
  album_image_key: null | string;
  album_image_state: null | string;
  album_image_updated_at: null | string;
  album_image_url: null | string;
  artists_json: string;
  bpm: null | number;
  duration_ms: null | number;
  key: null | string;
  label: null | string;
  log_id: null | string;
  note: null | string;
  release_date: null | string;
  spotify_uri: null | string;
  spotify_url: null | string;
  title: string;
  track_id: string;
};

export type RecSeedItem = {
  addedAt: string;
  artists: string[];
  imageUrl?: string;
  logId?: string;
  title: string;
  trackId: string;
};

export type RecommendationFindingItem = {
  artists: string[];
  bpm?: number;
  durationMs?: number;
  imageUrl?: string;
  key?: string;
  label?: string;
  logId: string;
  note?: string;
  similarity: number;
  spotifyUri?: string;
  spotifyUrl?: string;
  title: string;
  trackId: string;
  year?: string;
};

export type RecommendationCatalogueItem = {
  artists: string[];
  bpm?: number;
  durationMs?: number;
  imageUrl?: string;
  key?: string;
  label?: string;
  similarity: number;
  spotifyUri?: string;
  spotifyUrl?: string;
  title: string;
  trackId: string;
  year?: string;
};

export type RecommendationsResult = {
  catalogue: RecommendationCatalogueItem[];
  findings: RecommendationFindingItem[];
  ok: true;
  seedsSkipped: string[];
  seedsUsed: number;
};

async function findSeedTrack(trackIdOrLogId: string): Promise<TrackRefRow | undefined> {
  const value = trackIdOrLogId.trim();

  if (!value) {
    return undefined;
  }

  const db = await getDb();

  const result = await db.execute({
    args: [value, value, value],
    sql: `with ${TRACK_OR_LOG_ID_CTE}
      select tracks.track_id, findings.log_id from resolved_track
      join tracks on tracks.track_id = resolved_track.track_id
      left join findings on findings.track_id = tracks.track_id
      limit 1`,
  });

  return typedRow<TrackRefRow>(result.rows);
}

export async function listRecSeeds(user: PublicUser): Promise<{ ok: true; seeds: RecSeedItem[] }> {
  const result = await (
    await getDb()
  ).execute({
    args: [user.id],
    sql: `select s.track_id, s.added_at, t.title, t.artists_json, t.album_image_url, f.log_id,
        (select image_key from albums where albums.id = t.album_id) as album_image_key,
        (select image_state from albums where albums.id = t.album_id) as album_image_state,
        (select image_updated_at from albums where albums.id = t.album_id) as album_image_updated_at
      from user_rec_seeds s
      join tracks t on t.track_id = s.track_id
      left join findings f on f.track_id = s.track_id
      where s.user_id = ?
      order by s.added_at desc, s.track_id asc`,
  });

  return {
    ok: true,
    seeds: typedRows<SeedListRow>(result.rows).map((row) => ({
      addedAt: row.added_at,
      artists: parseArtistsJson(row.artists_json),
      imageUrl: bestAlbumCoverUrl({
        imageKey: row.album_image_key,
        imageState: row.album_image_state,
        imageUpdatedAt: row.album_image_updated_at,
        spotifyUrl: row.album_image_url,
      }),
      logId: row.log_id ?? undefined,
      title: row.title,
      trackId: row.track_id,
    })),
  };
}

export async function saveRecSeed(
  user: PublicUser,
  body: unknown,
): Promise<Response | { ok: true; seed: { addedAt: string; logId?: string; trackId: string } }> {
  if (!isRecord(body)) {
    return jsonError(400, "invalid_request", "Invalid seed");
  }

  const id =
    typeof body.trackId === "string"
      ? body.trackId
      : typeof body.logId === "string"
        ? body.logId
        : "";
  const track = await findSeedTrack(id);

  if (!track) {
    return jsonError(404, "track_not_found", "No track by that id");
  }

  const db = await getDb();
  const existing = await db.execute({
    args: [user.id],
    sql: `select track_id from user_rec_seeds where user_id = ?`,
  });
  const seeded = typedRows<{ track_id: string }>(existing.rows).map((row) => row.track_id);

  if (!seeded.includes(track.track_id) && seeded.length >= MAX_REC_SEEDS) {
    return jsonError(
      409,
      "seed_limit",
      `You can pick up to ${MAX_REC_SEEDS} seeds. Remove one to add another.`,
    );
  }

  const now = new Date().toISOString();

  await db.execute({
    args: [user.id, track.track_id, now],
    sql: `insert into user_rec_seeds (user_id, track_id, added_at)
      values (?, ?, ?)
      on conflict(user_id, track_id) do update set added_at = excluded.added_at`,
  });

  return {
    ok: true,
    seed: {
      addedAt: now,
      logId: track.log_id ?? undefined,
      trackId: track.track_id,
    },
  };
}

export async function deleteRecSeed(
  user: PublicUser,
  trackIdOrLogId: string,
): Promise<Response | { ok: true }> {
  const track = await findSeedTrack(trackIdOrLogId);

  if (!track) {
    return jsonError(404, "track_not_found", "No track by that id");
  }

  await (
    await getDb()
  ).execute({
    args: [user.id, track.track_id],
    sql: `delete from user_rec_seeds where user_id = ? and track_id = ?`,
  });

  return { ok: true };
}

export async function listRecommendations(
  user: PublicUser,
  options?: { excludeRecent?: boolean },
): Promise<RecommendationsResult | Response> {
  if (!user.emailVerified) {
    return jsonError(403, "email_unverified", "Verify your email to get your recommendations.");
  }

  const excludeRecent = options?.excludeRecent ?? false;
  const db = await getDb();

  const [seedResult, recentResult, sonarEnabled, sonarCatalogueEnabled] = await Promise.all([
    db.execute({
      args: [user.id],
      sql: `select s.track_id, emb.embedding_blob
        from user_rec_seeds s
        join tracks t on t.track_id = s.track_id
        left join track_embeddings emb on emb.track_id = t.track_id
        where s.user_id = ?
        order by s.added_at asc, s.track_id asc`,
    }),
    excludeRecent
      ? db.execute({
          args: [user.id, user.id, FRONTIER_NOVELTY_WINDOW],
          sql: `select fet.track_id
            from frontier_editions fe
            join frontier_edition_tracks fet on fet.edition_id = fe.id
            where fe.user_id = ?
              and fe.id in (select id from frontier_editions where user_id = ? order by number desc limit ?)
            group by fet.track_id`,
        })
      : null,
    isSonarRecsEnabled(),
    isSonarRecsCatalogueEnabled(),
  ]);
  const seedRows = typedRows<SeedVectorRow>(seedResult.rows);
  const vectors: number[][] = [];
  const seedIds: string[] = [];
  const seedsSkipped: string[] = [];

  for (const row of seedRows) {
    const vector = readEmbeddingBlob(row.embedding_blob);

    seedIds.push(row.track_id);

    if (vector) {
      vectors.push(vector);
    } else {
      seedsSkipped.push(row.track_id);
    }
  }

  if (vectors.length === 0) {
    return { catalogue: [], findings: [], ok: true, seedsSkipped, seedsUsed: 0 };
  }

  const probes = vectors.map(toVectorProbe);

  const seedExclusion =
    seedIds.length > 0 ? `and t.track_id not in (${seedIds.map(() => "?").join(", ")})` : "";

  const excludedIds: string[] = [];

  if (recentResult) {
    for (const row of typedRows<{ track_id: string }>(recentResult.rows)) {
      excludedIds.push(row.track_id);
    }
  }

  const recentExclusion =
    excludeRecent && excludedIds.length > 0
      ? `and t.track_id not in (${excludedIds.map(() => "?").join(", ")})`
      : "";

  const distanceTerms = probes.map(() => "vector_distance_cos(embedding_blob, ?)");
  const bestDistance =
    distanceTerms.length === 1 ? distanceTerms.join("") : `min(${distanceTerms.join(", ")})`;

  const [cataloguePool, findingSlots] = await Promise.all([
    resolveScan(
      sonarCatalogueEnabled ? sonarCataloguePool(vectors, [...seedIds, ...excludedIds]) : null,
      async () => {
        const catalogueScan = await executeVectorFallback(
          db,
          "sonar.fallback.recommendations-catalogue",
          {
            args: [...seedIds, ...excludedIds, ...probes, RECOMMENDATIONS_POOL],
            sql: `with candidates(track_id) as materialized (
                select t.track_id
                from tracks t
                left join findings f on f.track_id = t.track_id
                left join track_embeddings emb on emb.track_id = t.track_id
                where ${REC_ELIGIBLE_WHERE}
                  ${seedExclusion}
                  ${recentExclusion}
                order by t.track_id
                ${vectorFallbackCandidateLimitSql()}
              ), ranked(track_id, dist) as materialized (
                select candidates.track_id, ${bestDistance} as dist
                from candidates
                join track_embeddings emb on emb.track_id = candidates.track_id
              )
            select track_id, dist from ranked
            where dist is not null
            order by dist asc, track_id asc
            limit ?`,
          },
        );

        return typedRows<ScanRow>(catalogueScan.rows);
      },
    ),
    resolveScan(
      sonarEnabled ? sonarFindingSlots(vectors, [...seedIds, ...excludedIds]) : null,
      async () => {
        const findingsScan = await executeVectorFallback(
          db,
          "sonar.fallback.recommendations-findings",
          {
            args: [...seedIds, ...excludedIds, ...probes, FINDINGS_SLOT_COUNT],
            sql: `with candidates(track_id) as materialized (
                select t.track_id
                from findings f
                cross join tracks t on t.track_id = f.track_id
                cross join track_embeddings emb on emb.track_id = t.track_id
                where f.log_id is not null
                  ${seedExclusion}
                  ${recentExclusion}
                order by t.track_id
                ${vectorFallbackCandidateLimitSql()}
              ), ranked(track_id, dist) as materialized (
                select candidates.track_id, ${bestDistance} as dist
                from candidates
                join track_embeddings emb on emb.track_id = candidates.track_id
              )
            select track_id, dist from ranked
            where dist is not null
            order by dist asc, track_id asc
            limit ?`,
          },
        );

        return typedRows<ScanRow>(findingsScan.rows);
      },
    ),
  ]);

  const hydrated = await hydrateTracks([
    ...cataloguePool.map((row) => row.track_id),
    ...findingSlots.map((row) => row.track_id),
  ]);

  type PoolEntry = { row: HydrateRow; similarity: number };

  const pool: PoolEntry[] = cataloguePool.flatMap((scan) => {
    const row = hydrated.get(scan.track_id);
    const similarity = cosineFromDistance(scan.dist);

    return row && similarity !== null ? [{ row, similarity }] : [];
  });

  const catalogue = diversifyRanked(pool, RECOMMENDATIONS_PAGE, (entry) => {
    const artists = parseArtistsJson(entry.row.artists_json);

    return {
      artist: artists[0] ? artists[0].trim().toLowerCase() : null,
      key: entry.row.key ? entry.row.key.trim().toLowerCase() : null,
      score: entry.similarity,
      year: entry.row.release_date ? entry.row.release_date.slice(0, 4) : null,
    };
  }).map((entry) => ({
    artists: parseArtistsJson(entry.row.artists_json),
    ...readoutOf(entry.row),
    imageUrl: coverOf(entry.row),
    similarity: entry.similarity,
    spotifyUri: entry.row.spotify_uri ?? undefined,
    spotifyUrl: entry.row.spotify_url ?? undefined,
    title: entry.row.title,
    trackId: entry.row.track_id,
  }));

  const findings = findingSlots.flatMap((scan) => {
    const row = hydrated.get(scan.track_id);
    const similarity = cosineFromDistance(scan.dist);

    if (!row || row.log_id === null || similarity === null) {
      return [];
    }

    return [
      {
        artists: parseArtistsJson(row.artists_json),
        ...readoutOf(row),
        imageUrl: coverOf(row),
        logId: row.log_id,
        note: row.note ?? undefined,
        similarity,
        spotifyUri: row.spotify_uri ?? undefined,
        spotifyUrl: row.spotify_url ?? undefined,
        title: row.title,
        trackId: row.track_id,
      },
    ];
  });

  return { catalogue, findings, ok: true, seedsSkipped, seedsUsed: probes.length };
}

function sonarFindingSlots(
  vectors: number[][],
  excludeIds: string[],
): Promise<SonarMatch[] | null> {
  return searchSonar({
    excludeIds,
    filter: { certified: true },
    index: "tracks",
    probes: vectors,
    topK: FINDINGS_SLOT_COUNT,
  });
}

function sonarCataloguePool(
  vectors: number[][],
  excludeIds: string[],
): Promise<SonarMatch[] | null> {
  return searchSonar({
    excludeIds,
    filter: {
      anchored: true,
      dismissed: false,
      duration_ms_max: LONG_FORM_MS,
      has_finding: false,
      is_duplicate: false,
      nearest_finding_score_max: DUPLICATE_SIMILARITY,
    },
    index: "tracks",
    probes: vectors,
    topK: RECOMMENDATIONS_POOL,
  });
}

async function resolveScan(
  sonarMatches: Promise<SonarMatch[] | null> | null,
  runTursoScan: () => Promise<ScanRow[]>,
): Promise<ScanRow[]> {
  if (sonarMatches) {
    const matches = await sonarMatches;

    if (matches && matches.length > 0) {
      return matches.map((match) => ({ dist: 1 - match.score, track_id: match.id }));
    }
  }

  return runTursoScan();
}

async function hydrateTracks(trackIds: string[]): Promise<Map<string, HydrateRow>> {
  const ids = [...new Set(trackIds)];

  if (ids.length === 0) {
    return new Map();
  }

  const result = await (
    await getDb()
  ).execute({
    args: ids,
    sql: `select t.track_id, t.title, t.artists_json, t.album_image_url, t.spotify_url,
        t.spotify_uri, t.key, t.bpm, t.duration_ms, t.label, t.release_date, f.log_id, f.note,
        (select image_key from albums where albums.id = t.album_id) as album_image_key,
        (select image_state from albums where albums.id = t.album_id) as album_image_state,
        (select image_updated_at from albums where albums.id = t.album_id) as album_image_updated_at
      from tracks t
      left join findings f on f.track_id = t.track_id
      where t.track_id in (${ids.map(() => "?").join(", ")})`,
  });

  const byTrackId = new Map<string, HydrateRow>();

  for (const row of typedRows<HydrateRow>(result.rows)) {
    byTrackId.set(row.track_id, row);
  }

  return byTrackId;
}

function readoutOf(row: HydrateRow): {
  bpm?: number;
  durationMs?: number;
  key?: string;
  label?: string;
  year?: string;
} {
  return {
    bpm: row.bpm ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    key: row.key ?? undefined,
    label: row.label ?? undefined,
    year: row.release_date ? row.release_date.slice(0, 4) : undefined,
  };
}

function coverOf(row: HydrateRow): string | undefined {
  return bestAlbumCoverUrl({
    imageKey: row.album_image_key,
    imageState: row.album_image_state,
    imageUpdatedAt: row.album_image_updated_at,
    spotifyUrl: row.album_image_url,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
