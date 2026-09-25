// THE STYLE PROBE — how a style word is heard (lib/search-styles.ts has the lexicon).
//
// A style is its anchor artists' MuQ centroids averaged into ONE probe (the mean of means, so each
// anchor weighs equally whatever its catalogue depth — the `soundsLikeArtists` shape in
// `search.ts`), and every embedded track is ranked by cosine distance to it, closest first. It
// re-ranks; it never filters out a track for lacking a label, because no track carries one.
//
// ── THE QUERY SHAPES (docs/local-database.md, hosted Turso) ─────────────────────────────────────
//   - The anchors resolve in ONE statement: `artists.slug in (…)` rides the slug unique index, the
//     centroid join is by primary key, and the visibility gate applies (an unlisted anchor simply
//     does not weigh in, and the post-deploy probe fails on the missing name).
//   - The ranking is ONE exact pass. With no column filter it is Sonar's in-memory scan (the
//     complete corpus). With a column filter (key, label, year) it is the Turso scan BEHIND that
//     btree pre-filter, bound to {@link STYLE_PREFILTER_CAP} candidates and reporting how many it
//     saw: a pre-filter that reaches the cap is not an exact answer, so it is treated as
//     unavailable and degrades rather than passing a truncated scan off as the whole catalogue.
//     The probe binds as a raw BLOB, the rank happens in SQL, and nothing pulls the column.
//   - Several anchors are folded in the isolate (eight 4 KB centroids) into ONE probe: never one
//     scan per anchor, never `union all` branches.

import { type SearchStyle } from "../search-styles";
import { meanEmbedding } from "./artist-dossier";
import { listedArtistWhere } from "./artist-visibility";
import { getDb, typedRows } from "./db";
import { readEmbeddingBlob, toVectorProbe } from "./embedding";
import { type Clause } from "./search";
import { isSonarSonicEnabled, searchSonar, type SonarFilter, SONAR_MAX_TOP_K } from "./sonar";
import { executeVectorFallback, vectorFallbackCandidateLimitSql } from "./vector-fallback";

/** A style's probe, and the canonical names of the anchors that actually weighed in. */
export type StyleProbe = { anchors: string[]; probe: number[] };

/**
 * The most candidates a pre-filtered style scan may score. Well under the shared fallback bound:
 * a key, a label, or a year narrows today's catalogue to a few thousand embedded tracks, and a
 * pre-filter that does NOT narrow (a century-wide year range) should degrade rather than turn one
 * page view into a whole-corpus Turso scan.
 */
export const STYLE_PREFILTER_CAP = 20_000;

/** How long a resolved probe is reused in one isolate. Centroids are recomputed nightly. */
const PROBE_TTL_MS = 10 * 60_000;

const probeCache = new Map<string, { expires: number; value: Promise<StyleProbe | null> }>();

/** Drop every memoised probe, so a test that reseeds centroids starts cold. */
export function resetStyleProbeCache(): void {
  probeCache.clear();
}

type AnchorRow = { centroid_blob: unknown; name: string; slug: string };

async function loadStyleProbe(style: SearchStyle): Promise<StyleProbe | null> {
  if (style.anchors.length === 0) {
    return null;
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

  // The lexicon's order, so the echo reads the anchors in the order the style lists them.
  for (const slug of style.anchors) {
    const row = bySlug.get(slug);
    const vector = row ? readEmbeddingBlob(row.centroid_blob) : null;

    if (row && vector) {
      anchors.push(row.name);
      vectors.push(vector);
    }
  }

  const probe = meanEmbedding(vectors);

  return probe ? { anchors, probe } : null;
}

/**
 * Resolve a style to its probe, or `null` when none of its anchors has a centroid (the style then
 * declines, exactly as a sonic reference that names no real track declines). Memoised per isolate;
 * a rejection evicts itself so a failed read is never cached.
 */
export async function resolveStyleProbe(style: SearchStyle): Promise<StyleProbe | null> {
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

/** The column filters Sonar can express for a style ranking: inclusive BPM bounds only. */
export type StyleRankFilters = { bpmMax?: number; bpmMin?: number };

/**
 * Rank track ids by a probe, closest first, `depth` deep. Two routes, one answer shape:
 *
 *   - NO pre-filter clauses: Sonar's complete-corpus scan (BPM bounds ride its own filter). When
 *     Sonar is off or unavailable this returns `null` — the caller degrades; a whole-corpus Turso
 *     scan is never started on a page view.
 *   - Pre-filter clauses (key, label, year, release day…): the exact Turso scan behind them, capped
 *     at {@link STYLE_PREFILTER_CAP}. It returns `null` when the pre-filter reached the cap, because
 *     a truncated candidate set is not the closest-first catalogue it would be presented as.
 *
 * `null` always means UNAVAILABLE; `[]` is a valid empty ranking.
 */
export async function rankTrackIdsByProbe(
  probe: number[],
  options: {
    clauses: Clause[];
    depth: number;
    excludeTrackId?: string;
    /** The scan's `from` extras (a `findings` join when a clause reads it). */
    from?: string;
    sonarFilter?: StyleRankFilters;
  },
): Promise<string[] | null> {
  const depth = Math.min(Math.max(Math.trunc(options.depth), 1), SONAR_MAX_TOP_K);

  if (options.clauses.length === 0) {
    if (!(await isSonarSonicEnabled())) {
      return null;
    }

    const filter: SonarFilter = {};

    if (typeof options.sonarFilter?.bpmMin === "number") {
      filter.bpm_min = options.sonarFilter.bpmMin;
    }

    if (typeof options.sonarFilter?.bpmMax === "number") {
      filter.bpm_max = options.sonarFilter.bpmMax;
    }

    const matches = await searchSonar({
      excludeIds: options.excludeTrackId ? [options.excludeTrackId] : [],
      filter,
      index: "tracks",
      probes: [probe],
      topK: depth,
    });

    return matches === null ? null : matches.map((match) => match.id);
  }

  const where = [
    ...options.clauses.map((clause) => clause.sql),
    ...(options.excludeTrackId ? ["tracks.track_id != ?"] : []),
    `tracks.has_embedding = 1`,
  ].join(" and ");
  const db = await getDb();
  const result = await executeVectorFallback(
    db,
    "sonar.fallback.style",
    {
      // SQL-TEXT ORDER: the pre-filter clauses and the exclusion, then the probe, then the depth.
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
    { candidateLimit: STYLE_PREFILTER_CAP },
  );
  const rows = typedRows<{ scanned: number; track_id: string }>(result.rows);

  if (Number(rows[0]?.scanned ?? 0) >= STYLE_PREFILTER_CAP) {
    return null;
  }

  return rows.map((row) => row.track_id);
}
