import { type InStatement } from "@libsql/client/web";
import { listedArtistWhere } from "./artist-visibility";
import { getDb, typedRows } from "./db";
import {
  type EmbeddingCandidate,
  readEmbeddingBlob,
  rankBySimilarity,
  toVectorProbe,
} from "./embedding";
import { bestArtistAvatarUrl } from "../media";
import { isSonarArtistsEnabled, searchSonar, type SonarMatch } from "./sonar";
import { executeVectorFallback, vectorFallbackCandidateLimitSql } from "./vector-fallback";

export const ARTIST_NEIGHBOURS_LIMIT = 4;

export const ARTIST_SIMILAR_EDGES = 8;

export const ARTIST_RANK_BATCH_SIZE = 50;

export const ARTIST_RANK_CHUNK = 25;

export type ArtistSignature = {
  firstFoundAt: string | undefined;
};

export type ArtistIdentity = {
  imageUrl: string | undefined;
  name: string;
  slug: string;
};

export type ArtistNeighbour = ArtistIdentity & {
  certified: boolean;
};

export type SignatureFinding = {
  addedAt: string;
};

export function meanEmbedding(vectors: number[][]): number[] | null {
  if (vectors.length === 0) {
    return null;
  }

  let width = 0;
  for (const vector of vectors) {
    if (vector.length > width) {
      width = vector.length;
    }
  }

  const sum = Array.from<number>({ length: width }).fill(0);

  for (const vector of vectors) {
    for (let index = 0; index < width; index += 1) {
      sum[index] = (sum[index] ?? 0) + (vector[index] ?? 0);
    }
  }

  return sum.map((component) => component / vectors.length);
}

export type ArtistEmbeddingGroup = {
  artistId: string;
  imageUrl: string | undefined;
  name: string;
  slug: string;
  vectors: number[][];
};

export function rankSimilarArtists(
  targetArtistId: string,
  groups: ArtistEmbeddingGroup[],
  limit: number,
): ArtistIdentity[] {
  const targetGroup = groups.find((group) => group.artistId === targetArtistId);
  const target = targetGroup ? meanEmbedding(targetGroup.vectors) : null;

  if (!target) {
    return [];
  }

  const candidates: EmbeddingCandidate<ArtistIdentity>[] = [];

  for (const group of groups) {
    if (group.artistId === targetArtistId) {
      continue;
    }

    const mean = meanEmbedding(group.vectors);

    if (mean) {
      candidates.push({
        embedding: mean,
        item: { imageUrl: group.imageUrl, name: group.name, slug: group.slug },
      });
    }
  }

  return rankBySimilarity(target, candidates, limit);
}

export const MAX_SIMILAR_ARTISTS_INPUT = 6;

export const SIMILAR_ARTISTS_LIMIT = 12;

export function rankSimilarToArtists(
  selectedArtistIds: string[],
  groups: ArtistEmbeddingGroup[],
  limit: number,
): ArtistIdentity[] {
  const selected = new Set(selectedArtistIds);
  const selectedMeans: number[][] = [];

  for (const group of groups) {
    if (!selected.has(group.artistId)) {
      continue;
    }

    const mean = meanEmbedding(group.vectors);

    if (mean) {
      selectedMeans.push(mean);
    }
  }

  const target = meanEmbedding(selectedMeans);

  if (!target) {
    return [];
  }

  const candidates: EmbeddingCandidate<ArtistIdentity>[] = [];

  for (const group of groups) {
    if (selected.has(group.artistId)) {
      continue;
    }

    const mean = meanEmbedding(group.vectors);

    if (mean) {
      candidates.push({
        embedding: mean,
        item: { imageUrl: group.imageUrl, name: group.name, slug: group.slug },
      });
    }
  }

  return rankBySimilarity(target, candidates, limit);
}

export function summarizeArtistSignature(findings: SignatureFinding[]): ArtistSignature {
  let firstFoundAt: string | undefined;

  for (const finding of findings) {
    if (finding.addedAt && (firstFoundAt === undefined || finding.addedAt < firstFoundAt)) {
      firstFoundAt = finding.addedAt;
    }
  }

  return { firstFoundAt };
}

const ARTIST_RANK_LOGIC_VERSION = "v1";

export function artistCentroidFingerprint(embeddedTrackCount: number): string {
  return `${ARTIST_RANK_LOGIC_VERSION}:${embeddedTrackCount}`;
}

export type RankArtistsSummary = {
  centroidsComputed: number;

  centroidsRemoved: number;

  edgesWritten: number;

  logicVersion: string;

  remaining: number;
};

const ARTIST_RANK_MORE_REMAIN = 1;

type ArtistVectorRow = { artist_id: string; embedding_blob: unknown };
type StaleArtistRow = { artist_id: string };
type EdgeCandidateRow = { dist: number; neighbour_id: string };

const STALE_ARTISTS_INNER = `select live.artist_id as artist_id
            from (
              select ta.artist_id as artist_id, count(*) as n
              from track_artists ta
              join track_embeddings emb on emb.track_id = ta.track_id
              group by ta.artist_id
            ) live
            left join artist_centroids ac on ac.artist_id = live.artist_id
            where ac.artist_id is null
               or ac.rank_corpus <> ('${ARTIST_RANK_LOGIC_VERSION}:' || live.n)
            union
            select ac.artist_id as artist_id
            from artist_centroids ac
            where not exists (
              select 1 from track_artists ta
              join track_embeddings emb on emb.track_id = ta.track_id
              where ta.artist_id = ac.artist_id
            )`;

const STALE_ARTISTS_PAGE = `select artist_id from (${STALE_ARTISTS_INNER})
          order by artist_id asc
          limit ?`;

async function countStaleArtists(): Promise<number> {
  const db = await getDb();
  const result = await db.execute({
    args: [],
    sql: `select count(*) as n from (${STALE_ARTISTS_INNER})`,
  });

  return Number(typedRows<{ n: number }>(result.rows)[0]?.n ?? 0);
}

async function remainingArtistRankWork(options: {
  batchSize: number;
  countRemaining: boolean;
  limit: number;
}): Promise<number> {
  if (options.countRemaining || options.batchSize < options.limit) {
    return countStaleArtists();
  }

  return ARTIST_RANK_MORE_REMAIN;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];

  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }

  return chunks;
}

const EDGE_RERANK_SQL = `select ac.artist_id as neighbour_id,
                   vector_distance_cos(
                     ac.centroid_blob,
                     (select centroid_blob from artist_centroids where artist_id = ?)
                   ) as dist
            from artist_centroids ac
            where ac.artist_id <> ?
            order by dist asc, ac.artist_id asc
            limit ?`;

export async function rankArtists(
  limit = ARTIST_RANK_BATCH_SIZE,
  now: () => string = () => new Date().toISOString(),
  countRemaining = false,
): Promise<RankArtistsSummary> {
  const db = await getDb();
  const bounded = Math.max(0, limit);

  const staleResult = await db.execute({ args: [bounded], sql: STALE_ARTISTS_PAGE });
  const staleArtists = typedRows<StaleArtistRow>(staleResult.rows).map((row) => row.artist_id);

  if (staleArtists.length === 0) {
    return {
      centroidsComputed: 0,
      centroidsRemoved: 0,
      edgesWritten: 0,
      logicVersion: ARTIST_RANK_LOGIC_VERSION,
      remaining: bounded > 0 ? 0 : await countStaleArtists(),
    };
  }

  const stamp = now();
  let centroidsRemoved = 0;
  let edgesWritten = 0;

  const computed: { artistId: string; fingerprint: string }[] = [];

  for (const artistChunk of chunk(staleArtists, ARTIST_RANK_CHUNK)) {
    const placeholders = artistChunk.map(() => "?").join(", ");

    const vectorResult = await db.execute({
      args: artistChunk,
      sql: `select ta.artist_id as artist_id, emb.embedding_blob as embedding_blob
            from track_artists ta
            join track_embeddings emb on emb.track_id = ta.track_id
            where ta.artist_id in (${placeholders})`,
    });

    const grouped = new Map<string, { count: number; vectors: number[][] }>();

    for (const artistId of artistChunk) {
      grouped.set(artistId, { count: 0, vectors: [] });
    }

    for (const row of typedRows<ArtistVectorRow>(vectorResult.rows)) {
      const entry = grouped.get(row.artist_id);

      if (!entry) {
        continue;
      }

      entry.count += 1;

      const embedding = readEmbeddingBlob(row.embedding_blob);

      if (embedding) {
        entry.vectors.push(embedding);
      }
    }

    const centroidWrites: InStatement[] = [];

    for (const artistId of artistChunk) {
      const entry = grouped.get(artistId);
      const mean = entry ? meanEmbedding(entry.vectors) : null;

      if (!entry || entry.count === 0 || !mean) {
        centroidWrites.push({
          args: [artistId],
          sql: `delete from artist_centroids where artist_id = ?`,
        });
        centroidWrites.push({
          args: [artistId],
          sql: `delete from artist_similar where artist_id = ?`,
        });
        centroidWrites.push({
          args: [artistId],
          sql: `delete from artist_similar where neighbour_artist_id = ?`,
        });
        centroidsRemoved += 1;
        continue;
      }

      const fingerprint = artistCentroidFingerprint(entry.count);

      centroidWrites.push({
        args: [artistId, JSON.stringify(mean), entry.count, fingerprint, stamp],
        sql: `insert into artist_centroids (artist_id, centroid_blob, vector_count, rank_corpus, computed_at)
              values (?, vector32(?), ?, ?, ?)
              on conflict(artist_id) do update set
                centroid_blob = excluded.centroid_blob,
                vector_count = excluded.vector_count,
                rank_corpus = excluded.rank_corpus,
                computed_at = excluded.computed_at`,
      });
      computed.push({ artistId, fingerprint });
    }

    if (centroidWrites.length > 0) {
      await db.batch(centroidWrites, "write");
    }
  }

  for (const computedChunk of chunk(computed, ARTIST_RANK_CHUNK)) {
    const edgeWrites: InStatement[] = [];

    for (const { artistId, fingerprint } of computedChunk) {
      const edgeResult = await db.execute({
        args: [artistId, artistId, ARTIST_SIMILAR_EDGES],
        sql: EDGE_RERANK_SQL,
      });
      const edges = typedRows<EdgeCandidateRow>(edgeResult.rows);

      edgeWrites.push({ args: [artistId], sql: `delete from artist_similar where artist_id = ?` });

      edges.forEach((edge, index) => {
        edgeWrites.push({
          args: [artistId, edge.neighbour_id, 1 - Number(edge.dist), index, fingerprint, stamp],
          sql: `insert into artist_similar
                  (artist_id, neighbour_artist_id, similarity, rank, rank_corpus, computed_at)
                values (?, ?, ?, ?, ?, ?)`,
        });
        edgesWritten += 1;
      });
    }

    if (edgeWrites.length > 0) {
      await db.batch(edgeWrites, "write");
    }
  }

  return {
    centroidsComputed: computed.length,
    centroidsRemoved,
    edgesWritten,
    logicVersion: ARTIST_RANK_LOGIC_VERSION,

    remaining: await remainingArtistRankWork({
      batchSize: staleArtists.length,
      countRemaining,
      limit: bounded,
    }),
  };
}

type NeighbourRow = {
  certified: number;
  image_url: string | null;
  name: string;
  slug: string;
};

export const ARTIST_NEIGHBOURS_SQL = `select a.name as name, a.slug as slug, a.image_url as image_url,
             (a.certified_finding_count > 0) as certified
      from artist_similar s
      join artists a on a.id = s.neighbour_artist_id
      where s.artist_id = ? and ${listedArtistWhere("a")}
      order by s.rank asc
      limit ?`;

export async function getArtistNeighbours(
  artistId: string,
  limit = ARTIST_NEIGHBOURS_LIMIT,
): Promise<ArtistNeighbour[]> {
  if (limit <= 0) {
    return [];
  }

  const db = await getDb();
  const result = await db.execute({
    args: [artistId, Math.max(0, limit)],
    sql: ARTIST_NEIGHBOURS_SQL,
  });

  return typedRows<NeighbourRow>(result.rows).map((row) => ({
    certified: Number(row.certified) === 1,
    imageUrl: row.image_url ?? undefined,
    name: row.name,
    slug: row.slug,
  }));
}

export type SimilarArtistNeighbour = {
  artistId: string;
  imageUrl: string | undefined;
  name: string;
  slug: string;
};

type SimilarArtistRow = {
  artist_id: string;
  image_key: string | null;
  image_state: string | null;
  image_updated_at: string | null;
  image_url: string | null;
  name: string;
  slug: string;
};

export async function listSimilarArtistNeighbours(
  slugs: string[],
  limit: number,
): Promise<SimilarArtistNeighbour[]> {
  const cleaned = [...new Set(slugs.map((slug) => slug.trim()).filter(Boolean))].slice(
    0,
    MAX_SIMILAR_ARTISTS_INPUT,
  );

  if (cleaned.length === 0 || limit <= 0) {
    return [];
  }

  const db = await getDb();
  const selectedPlaceholders = cleaned.map(() => "?").join(", ");
  const selectedResult = await db.execute({
    args: cleaned,
    sql: `select a.id as artist_id, ac.centroid_blob as centroid_blob
          from artists a
          join artist_centroids ac on ac.artist_id = a.id
          where a.slug in (${selectedPlaceholders})`,
  });
  const selected = typedRows<{ artist_id: string; centroid_blob: unknown }>(selectedResult.rows);

  if (selected.length === 0) {
    return [];
  }

  const vectors: number[][] = [];

  for (const row of selected) {
    const vector = readEmbeddingBlob(row.centroid_blob);

    if (vector) {
      vectors.push(vector);
    }
  }

  const probe = meanEmbedding(vectors);

  if (!probe) {
    return [];
  }

  const selectedIds = selected.map((row) => row.artist_id);

  if (await isSonarArtistsEnabled()) {
    const matches = await searchSonar({
      excludeIds: selectedIds,
      index: "centroids",
      probes: [probe],
      topK: Math.max(0, limit),
    });

    if (matches && matches.length > 0) {
      return hydrateArtistNeighbours(matches);
    }
  }

  const idPlaceholders = selectedIds.map(() => "?").join(", ");

  const result = await executeVectorFallback(db, "sonar.fallback.artists", {
    args: [...selectedIds, toVectorProbe(probe), Math.max(0, limit)],
    sql: `with candidates(artist_id) as materialized (
              select ac.artist_id
              from artist_centroids ac
              where ac.artist_id not in (${idPlaceholders})
              order by ac.artist_id
              ${vectorFallbackCandidateLimitSql()}
            ), winners(artist_id, dist) as materialized (
            select candidates.artist_id, vector_distance_cos(ac.centroid_blob, ?) as dist
            from candidates
            join artist_centroids ac on ac.artist_id = candidates.artist_id
            order by dist asc, candidates.artist_id asc
            limit ?
          )
          select a.id as artist_id, a.slug as slug, a.name as name, a.image_url as image_url,
                 a.image_key as image_key, a.image_state as image_state,
                 a.image_updated_at as image_updated_at
          from winners
          cross join artists a on a.id = winners.artist_id
          where ${listedArtistWhere("a")}
          order by winners.dist asc, winners.artist_id asc`,
  });

  return typedRows<SimilarArtistRow>(result.rows).map(toSimilarArtistNeighbour);
}

function toSimilarArtistNeighbour(row: SimilarArtistRow): SimilarArtistNeighbour {
  return {
    artistId: row.artist_id,
    imageUrl: bestArtistAvatarUrl({
      imageKey: row.image_key,
      imageState: row.image_state,
      imageUpdatedAt: row.image_updated_at,
      imageUrl: row.image_url,
    }),
    name: row.name,
    slug: row.slug,
  };
}

async function hydrateArtistNeighbours(matches: SonarMatch[]): Promise<SimilarArtistNeighbour[]> {
  const ids = matches.map((match) => match.id);
  const placeholders = ids.map(() => "?").join(", ");
  const db = await getDb();
  const result = await db.execute({
    args: ids,
    sql: `select a.id as artist_id, a.slug as slug, a.name as name, a.image_url as image_url,
                 a.image_key as image_key, a.image_state as image_state,
                 a.image_updated_at as image_updated_at
          from artists a
          where a.id in (${placeholders}) and ${listedArtistWhere("a")}`,
  });
  const byId = new Map(typedRows<SimilarArtistRow>(result.rows).map((row) => [row.artist_id, row]));

  return ids
    .map((id) => byId.get(id))
    .filter((row): row is SimilarArtistRow => row !== undefined)
    .map(toSimilarArtistNeighbour);
}
