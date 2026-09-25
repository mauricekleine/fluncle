import { type SearchStyle } from "../search-styles";
import { LONG_FORM_MS } from "../catalogue-eligibility";
import { meanEmbedding } from "./artist-dossier";
import { listedArtistWhere } from "./artist-visibility";
import { getDb, typedRows } from "./db";
import { readEmbeddingBlob, toVectorProbe } from "./embedding";
import { type Clause } from "./search";
import { isSonarSonicEnabled, searchSonar, type SonarFilter, SONAR_MAX_TOP_K } from "./sonar";
import { validReleaseDateSql } from "./release-day";
import {
  executeVectorFallback,
  isVectorDeadlineExpired,
  vectorFallbackCandidateLimitSql,
} from "./vector-fallback";

export type StyleProbe =
  | { anchors: string[]; probe: number[]; status: "ready" }
  | { missing: string[]; status: "incomplete" };

export const STYLE_PREFILTER_CAP = 20_000;

const PROBE_TTL_MS = 10 * 60_000;

const probeCache = new Map<string, { expires: number; value: Promise<StyleProbe> }>();

export function resetStyleProbeCache(): void {
  probeCache.clear();
}

type AnchorRow = { centroid_blob: unknown; name: string; slug: string };

async function loadStyleProbe(style: SearchStyle): Promise<StyleProbe> {
  if (style.anchors.length === 0) {
    return { missing: [], status: "incomplete" };
  }

  const db = await getDb();
  const placeholders = style.anchors.map(() => "?").join(", ");
  const result = await db.execute({
    args: [...style.anchors],
    sql: `select artists.slug as slug, artists.name as name, ac.centroid_blob as centroid_blob
          from artists
          join artist_centroids ac on ac.artist_id = artists.id
          where artists.slug in (${placeholders})
            and ${listedArtistWhere()}`,
  });
  const bySlug = new Map(typedRows<AnchorRow>(result.rows).map((row) => [row.slug, row]));
  const anchors: string[] = [];
  const vectors: number[][] = [];
  const missing: string[] = [];

  for (const slug of style.anchors) {
    const row = bySlug.get(slug);
    const vector = row ? readEmbeddingBlob(row.centroid_blob) : null;

    if (row && vector) {
      anchors.push(row.name);
      vectors.push(vector);
    } else {
      missing.push(slug);
    }
  }

  const probe = missing.length === 0 ? meanEmbedding(vectors) : null;

  return probe ? { anchors, probe, status: "ready" } : { missing, status: "incomplete" };
}

export async function resolveStyleProbe(style: SearchStyle): Promise<StyleProbe> {
  const cached = probeCache.get(style.slug);
  const now = Date.now();

  if (cached && cached.expires > now) {
    return cached.value;
  }

  const value = loadStyleProbe(style);

  probeCache.set(style.slug, { expires: now + PROBE_TTL_MS, value });

  try {
    return await value;
  } catch (error) {
    probeCache.delete(style.slug);

    throw error;
  }
}

export const STYLE_FUTURE_EXCLUDE_CAP = 2_000;

export type StyleRankFilters = { bpmMax?: number; bpmMin?: number };

export async function rankTrackIdsByProbe(
  probe: number[],
  options: {
    clauses: Clause[];
    deadlineMs?: number;
    depth: number;
    excludeTrackId?: string;
    from?: string;
    publicDuration?: boolean;
    releasedBy?: string;
    sonarFilter?: StyleRankFilters;
  },
): Promise<string[] | null> {
  const depth = Math.min(Math.max(Math.trunc(options.depth), 1), SONAR_MAX_TOP_K);

  if (options.clauses.length === 0) {
    if (!(await isSonarSonicEnabled())) {
      return null;
    }

    const future = options.releasedBy === undefined ? [] : await futureTrackIds(options.releasedBy);

    if (future === null) {
      return null;
    }

    const filter: SonarFilter = {};

    if (typeof options.sonarFilter?.bpmMin === "number") {
      filter.bpm_min = options.sonarFilter.bpmMin;
    }

    if (typeof options.sonarFilter?.bpmMax === "number") {
      filter.bpm_max = options.sonarFilter.bpmMax;
    }

    const request = {
      excludeIds: [...(options.excludeTrackId ? [options.excludeTrackId] : []), ...future],
      index: "tracks" as const,
      probes: [probe],
      topK: depth,
    };

    if (options.publicDuration) {
      const [findings, catalogue] = await Promise.all([
        searchSonar({ ...request, filter: { ...filter, has_finding: true } }),
        searchSonar({
          ...request,
          filter: { ...filter, duration_ms_max: LONG_FORM_MS, has_finding: false },
        }),
      ]);
      if (findings === null || catalogue === null) {
        return null;
      }
      const seen = new Set<string>();
      return [...findings, ...catalogue]
        .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
        .filter((match) => {
          if (seen.has(match.id)) {
            return false;
          }
          seen.add(match.id);
          return true;
        })
        .slice(0, depth)
        .map((match) => match.id);
    }

    const matches = await searchSonar({ ...request, filter });

    return matches === null ? null : matches.map((match) => match.id);
  }

  const where = [
    ...options.clauses.map((clause) => clause.sql),
    ...(options.excludeTrackId ? ["tracks.track_id != ?"] : []),
    `tracks.has_embedding = 1`,
  ].join(" and ");
  const db = await getDb();
  let result: Awaited<ReturnType<typeof executeVectorFallback>>;

  try {
    result = await executeVectorFallback(
      db,
      "sonar.fallback.style",
      {
        args: [
          ...options.clauses.flatMap((clause) => clause.args),
          ...(options.excludeTrackId ? [options.excludeTrackId] : []),
          toVectorProbe(probe),
          depth,
        ],
        sql: `with candidates(track_id) as materialized (
              select tracks.track_id
              from tracks ${options.from ?? ""}
              join track_embeddings emb on emb.track_id = tracks.track_id
              where ${where}
              order by tracks.track_id
              ${vectorFallbackCandidateLimitSql(STYLE_PREFILTER_CAP)}
            ), winners(track_id, dist) as materialized (
              select candidates.track_id, vector_distance_cos(emb.embedding_blob, ?) as dist
              from candidates
              join track_embeddings emb on emb.track_id = candidates.track_id
              order by dist asc, candidates.track_id asc
              limit ?
            )
            select winners.track_id as track_id, (select count(*) from candidates) as scanned
            from winners
            order by winners.dist asc, winners.track_id asc`,
      },
      { candidateLimit: STYLE_PREFILTER_CAP, deadlineMs: options.deadlineMs },
    );
  } catch (error) {
    if (isVectorDeadlineExpired(error)) {
      return null;
    }

    throw error;
  }

  const rows = typedRows<{ scanned: number; track_id: string }>(result.rows);

  if (Number(rows[0]?.scanned ?? 0) >= STYLE_PREFILTER_CAP) {
    return null;
  }

  return rows.map((row) => row.track_id);
}

async function futureTrackIds(today: string): Promise<string[] | null> {
  const db = await getDb();
  const result = await db.execute({
    args: [today, STYLE_FUTURE_EXCLUDE_CAP + 1],
    sql: `select tracks.track_id as track_id from tracks
          where tracks.release_date > ?
            and ${validReleaseDateSql("tracks.release_date")}
            and tracks.has_embedding = 1
          limit ?`,
  });
  const ids = typedRows<{ track_id: string }>(result.rows).map((row) => row.track_id);

  return ids.length > STYLE_FUTURE_EXCLUDE_CAP ? null : ids;
}
