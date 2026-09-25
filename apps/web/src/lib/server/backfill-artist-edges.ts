import { getDb, typedRows } from "./db";
import {
  batchDueWorkSourceMutation,
  DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
  markDueWorkSourceMaintenanceStatements,
} from "./due-work";
import { isDueWorkCutoverEnabled, readPromotedDueWorkPage } from "./due-work-cutover";
import { encodeDueWorkOrder } from "./due-work-order";
import { parseArtistsJson } from "./artists";
import { restaleCatalogueRankStatements } from "./catalogue-rank-restale";
import { hubCountArtistEdgeStatements } from "./hub-counts";
import { fold } from "./track-match";

export const MAX_BATCH = 200;

const INSERT_CHUNK = 100;

const STAMP_CHUNK = 200;

export type ArtistEdgesBackfillResult = {
  dryRun: boolean;

  edgesWritten: number;

  fullyMatched: string[];
  fullyMatchedCount: number;

  nextCursor: string | null;
  ok: boolean;

  partiallyMatched: string[];
  partiallyMatchedCount: number;

  queueDepth: number;

  scanned: number;

  unmatchedNames: number;

  zeroMatched: string[];
  zeroMatchedCount: number;
};

export type TrackNameMatch = {
  edges: Array<{ artistId: string; position: number }>;

  matchedNames: number;

  totalNames: number;
};

export function buildArtistFoldMap(
  artists: ReadonlyArray<{ id: string; name: string }>,
  aliases: ReadonlyArray<{ alias: string; artist_id: string }>,
): Map<string, string> {
  const byFold = new Map<string, string>();
  const primaryKeys = new Set<string>();
  const ambiguous = new Set<string>();

  for (const artist of artists) {
    const key = fold(artist.name);

    if (!key || ambiguous.has(key)) {
      continue;
    }

    const existing = byFold.get(key);

    if (existing === undefined) {
      byFold.set(key, artist.id);
      primaryKeys.add(key);
    } else if (existing !== artist.id) {
      byFold.delete(key);
      primaryKeys.delete(key);
      ambiguous.add(key);
    }
  }

  for (const { alias, artist_id: artistId } of aliases) {
    const key = fold(alias);

    if (!key || ambiguous.has(key) || primaryKeys.has(key)) {
      continue;
    }

    const existing = byFold.get(key);

    if (existing === undefined) {
      byFold.set(key, artistId);
    } else if (existing !== artistId) {
      byFold.delete(key);
      ambiguous.add(key);
    }
  }

  return byFold;
}

export function buildIdentityClaimedNames(
  artists: ReadonlyArray<{ id: string; mbid?: null | string; name: string }>,
  aliases: ReadonlyArray<{ alias: string; artist_id: string }>,
): Map<string, Set<string>> {
  const claimed = new Set(
    artists.filter((artist) => Boolean(artist.mbid)).map((artist) => artist.id),
  );
  const byFold = new Map<string, Set<string>>();
  const add = (id: string, spelling: string) => {
    const key = fold(spelling);

    if (!key || !claimed.has(id)) {
      return;
    }

    getOrAdd(byFold, key).add(spelling.toLowerCase());
  };

  for (const artist of artists) {
    add(artist.id, artist.name);
  }

  for (const { alias, artist_id: artistId } of aliases) {
    add(artistId, alias);
  }

  return byFold;
}

function getOrAdd(map: Map<string, Set<string>>, key: string): Set<string> {
  let set = map.get(key);

  if (set === undefined) {
    set = new Set<string>();
    map.set(key, set);
  }

  return set;
}

export function matchTrackNames(
  names: string[],
  foldMap: Map<string, string>,
  identityClaimedNames?: ReadonlyMap<string, ReadonlySet<string>>,
): TrackNameMatch {
  const edges: Array<{ artistId: string; position: number }> = [];
  const seen = new Set<string>();
  let totalNames = 0;
  let matchedNames = 0;

  for (let i = 0; i < names.length; i++) {
    const name = names[i];

    if (typeof name !== "string" || name.trim() === "") {
      continue;
    }

    totalNames += 1;

    const key = fold(name);
    const artistId = foldMap.get(key);

    if (artistId === undefined) {
      continue;
    }

    const spellings = identityClaimedNames?.get(key);

    if (spellings && !spellings.has(name.toLowerCase())) {
      continue;
    }

    matchedNames += 1;

    if (seen.has(artistId)) {
      continue;
    }

    seen.add(artistId);
    edges.push({ artistId, position: i + 1 });
  }

  return { edges, matchedNames, totalNames };
}

type WorkRow = {
  artists_json: string;

  is_catalogue?: bigint | number;

  is_rankable?: bigint | number;
  track_id: string;
};

async function listWork(
  db: Awaited<ReturnType<typeof getDb>>,
  limit: number,
  cursor: string | undefined,
): Promise<WorkRow[]> {
  const result = await db.execute({
    args: cursor ? [cursor, limit] : [limit],
    sql: cursor
      ? `select t.track_id, t.artists_json, t.is_catalogue,
                t.key is not null and t.has_embedding = 1 as is_rankable
         from tracks t
         left join track_artists ta on ta.track_id = t.track_id
         where ta.track_id is null
           and t.artist_edges_backfilled_at is null
           and t.track_id > ?
         order by t.track_id asc
         limit ?`
      : `select t.track_id, t.artists_json, t.is_catalogue,
                t.key is not null and t.has_embedding = 1 as is_rankable
         from tracks t
         left join track_artists ta on ta.track_id = t.track_id
         where ta.track_id is null
           and t.artist_edges_backfilled_at is null
         order by t.track_id asc
         limit ?`,
  });

  return typedRows<WorkRow>(result.rows);
}

async function hydrateProjectedWork(
  db: Awaited<ReturnType<typeof getDb>>,
  trackIds: readonly string[],
): Promise<WorkRow[]> {
  if (trackIds.length === 0) {
    return [];
  }

  const result = await db.execute({
    args: [...trackIds],
    sql: `select track_id, artists_json, is_catalogue,
                 key is not null and has_embedding = 1 as is_rankable
          from tracks
          where track_id in (${trackIds.map(() => "?").join(", ")})`,
  });
  const byId = new Map(typedRows<WorkRow>(result.rows).map((row) => [row.track_id, row]));

  return trackIds.flatMap((trackId) => {
    const row = byId.get(trackId);
    return row === undefined ? [] : [row];
  });
}

export const ARTIST_EDGES_QUEUE_DEPTH_SQL = `select count(*) as queued
          from tracks t
          where t.artist_edges_backfilled_at is null
            and not exists (
              select 1 from track_artists ta where ta.track_id = t.track_id
            )`;

async function countWork(db: Awaited<ReturnType<typeof getDb>>): Promise<number> {
  const result = await db.execute({
    args: [],
    sql: ARTIST_EDGES_QUEUE_DEPTH_SQL,
  });
  const row = typedRows<{ queued: bigint | number }>(result.rows)[0];

  return Number(row?.queued ?? 0);
}

export async function loadArtists(
  db: Awaited<ReturnType<typeof getDb>>,
): Promise<Array<{ id: string; mbid: null | string; name: string }>> {
  const result = await db.execute({ args: [], sql: `select id, name, mbid from artists` });

  return typedRows<{ id: string; mbid: null | string; name: string }>(result.rows);
}

export async function loadAliases(
  db: Awaited<ReturnType<typeof getDb>>,
): Promise<Array<{ alias: string; artist_id: string }>> {
  const result = await db.execute({
    args: [],
    sql: `select artist_id, alias from artist_aliases
          where kind = 'name' and status in ('auto', 'confirmed')`,
  });

  return typedRows<{ alias: string; artist_id: string }>(result.rows);
}

async function insertEdges(
  db: Awaited<ReturnType<typeof getDb>>,
  tuples: ReadonlyArray<[string, string, number]>,
  certifiedTracks: ReadonlySet<string>,
  rankableTracks: ReadonlySet<string>,
): Promise<number> {
  let affected = 0;

  for (let i = 0; i < tuples.length; i += INSERT_CHUNK) {
    const chunk = tuples.slice(i, i + INSERT_CHUNK);
    const values = chunk.map(() => "(?, ?, ?)").join(", ");
    const results = await db.batch(
      [
        {
          args: chunk.flat(),
          sql: `insert or ignore into track_artists (track_id, artist_id, position) values ${values}`,
        },
        ...hubCountArtistEdgeStatements(
          chunk.map(([trackId, artistId]) => ({
            artistId,
            certified: certifiedTracks.has(trackId),
            rankable: rankableTracks.has(trackId),
            trackId,
          })),
        ),

        ...restaleCatalogueRankStatements(chunk.map(([trackId]) => trackId)),
        ...markDueWorkSourceMaintenanceStatements(
          [
            {
              subjectId: DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
              subjectType: "track" as const,
            },
            ...chunk.map(([trackId]) => ({ subjectId: trackId, subjectType: "track" as const })),
            ...chunk.map(([, artistId]) => ({
              subjectId: artistId,
              subjectType: "artist" as const,
            })),
          ],
          { producer: "artist-edge-backfill" },
        ),
      ],
      "write",
    );

    affected += results[0]?.rowsAffected ?? 0;
  }

  return affected;
}

async function stampVisited(
  db: Awaited<ReturnType<typeof getDb>>,
  trackIds: ReadonlyArray<string>,
): Promise<void> {
  const now = new Date().toISOString();

  for (let i = 0; i < trackIds.length; i += STAMP_CHUNK) {
    const chunk = trackIds.slice(i, i + STAMP_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");

    await batchDueWorkSourceMutation(
      db,
      [
        {
          args: [now, ...chunk],
          sql: `update tracks set artist_edges_backfilled_at = ?
                where track_id in (${placeholders})`,
        },
      ],
      chunk.map((subjectId) => ({ subjectId, subjectType: "track" })),
      { producer: "artist-edge-backfill-stamp" },
    );
  }
}

export async function resolveArtistEdges(
  limit: number,
  dryRun: boolean,
  cursor?: string,
): Promise<ArtistEdgesBackfillResult> {
  const db = await getDb();
  const batchLimit = Math.max(1, Math.min(limit, MAX_BATCH));
  const dueWorkCutoverEnabled = await isDueWorkCutoverEnabled();
  let rows: WorkRow[];

  if (dueWorkCutoverEnabled) {
    const page = await readPromotedDueWorkPage(db, "artist-edges", {
      continuation: cursor
        ? {
            sortKey: encodeDueWorkOrder([{ direction: "asc", kind: "text", value: cursor }]),
            subjectId: cursor,
          }
        : undefined,
      limit: batchLimit,
    });
    rows = await hydrateProjectedWork(db, page.subjectIds);
  } else {
    rows = await listWork(db, batchLimit, cursor);
  }

  const fullyMatched: string[] = [];
  const partiallyMatched: string[] = [];
  const zeroMatched: string[] = [];
  let unmatchedNames = 0;

  if (rows.length === 0) {
    return {
      dryRun,
      edgesWritten: 0,
      fullyMatched,
      fullyMatchedCount: 0,
      nextCursor: null,
      ok: true,
      partiallyMatched,
      partiallyMatchedCount: 0,
      queueDepth: await countWork(db),
      scanned: 0,
      unmatchedNames: 0,
      zeroMatched,
      zeroMatchedCount: 0,
    };
  }

  const [artists, aliases] = await Promise.all([loadArtists(db), loadAliases(db)]);
  const foldMap = buildArtistFoldMap(artists, aliases);
  const identityClaimedNames = buildIdentityClaimedNames(artists, aliases);

  const tuples: Array<[string, string, number]> = [];
  const visited: string[] = [];

  const certifiedTracks = new Set<string>();
  const rankableTracks = new Set<string>();

  for (const row of rows) {
    visited.push(row.track_id);

    if (row.is_catalogue !== undefined && Number(row.is_catalogue) === 0) {
      certifiedTracks.add(row.track_id);
    }

    if (row.is_rankable !== undefined && Number(row.is_rankable) === 1) {
      rankableTracks.add(row.track_id);
    }

    const match = matchTrackNames(
      parseArtistsJson(row.artists_json),
      foldMap,
      identityClaimedNames,
    );
    unmatchedNames += match.totalNames - match.matchedNames;

    for (const edge of match.edges) {
      tuples.push([row.track_id, edge.artistId, edge.position]);
    }

    if (match.matchedNames === 0) {
      zeroMatched.push(row.track_id);
    } else if (match.matchedNames === match.totalNames) {
      fullyMatched.push(row.track_id);
    } else {
      partiallyMatched.push(row.track_id);
    }
  }

  let edgesWritten = tuples.length;

  if (!dryRun) {
    edgesWritten = await insertEdges(db, tuples, certifiedTracks, rankableTracks);
    await stampVisited(db, visited);
  }

  const queueDepth = await countWork(db);
  const lastTrackId = rows.at(-1)?.track_id ?? null;
  const nextCursor = rows.length < batchLimit ? null : lastTrackId;

  return {
    dryRun,
    edgesWritten,
    fullyMatched,
    fullyMatchedCount: fullyMatched.length,
    nextCursor,
    ok: true,
    partiallyMatched,
    partiallyMatchedCount: partiallyMatched.length,
    queueDepth,
    scanned: rows.length,
    unmatchedNames,
    zeroMatched,
    zeroMatchedCount: zeroMatched.length,
  };
}
