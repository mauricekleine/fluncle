import { type SearchEntity, type SearchFilters, type SearchHit } from "@fluncle/contracts/orpc";
import { slugify } from "@fluncle/contracts/util/galaxy-slug";
import { parseKey } from "../key-camelot";
import { mixtapeCoverUrl } from "../mixtapes";
import {
  isBareToken,
  keySpellings,
  parseCoordinate,
  parseSonicPhrase,
  toFtsMatch,
  tokenize,
} from "../search-query";
import { bestArtistAvatarUrl, labelLogoUrl } from "../media";
import { hasPreviewSource } from "../track-preview";
import { ALBUM_INDEX_MIN_TRACKS } from "./albums";
import { MAX_SIMILAR_ARTISTS_INPUT, meanEmbedding } from "./artist-dossier";
import { listedArtistWhere } from "./artist-visibility";
import { getDb, typedRow, typedRows } from "./db";
import { readEmbeddingBlob, toVectorProbe } from "./embedding";
import { hubInclusionWhere, LABEL_INDEX_MIN_TRACKS, resolveConfirmedAliasLabelId } from "./labels";
import { translateQuery } from "./search-llm";
import { isSonarSonicEnabled, searchSonar, type SonarFilter, type SonarMatch } from "./sonar";
import { hydrateRankedSonarMatches } from "./sonar-hydration";
import {
  executeVectorFallback,
  VECTOR_FALLBACK_DEADLINE_MS,
  vectorFallbackCandidateLimitSql,
} from "./vector-fallback";

const DEFAULT_LIMIT = 12;

const SONIC_LIMIT = 12;

export const SONIC_SCAN_TIMEOUT_MS = VECTOR_FALLBACK_DEADLINE_MS;

export type SearchResult = {
  anchor?: SearchHit;
  degraded: boolean;
  entities: SearchEntity[];
  filters?: SearchFilters;
  kind: "coordinate" | "empty" | "entity" | "filters" | "sonic" | "token";
  redirect?: string;
  results: SearchHit[];
};

type SearchRow = {
  album: string | null;
  album_image_url: string | null;
  artists_json: string;
  bpm: number | null;
  duration_ms: number | null;
  galaxy_name: string | null;
  key: string | null;
  label: string | null;
  log_id: string | null;
  isrc: string | null;
  preview_url: string | null;
  release_date: string | null;
  spotify_url: string | null;
  title: string;
  track_id: string;
};

const SEARCH_SELECT = `tracks.track_id, tracks.title, tracks.artists_json, tracks.album, tracks.album_image_url,
  tracks.bpm, tracks.duration_ms, tracks.isrc, tracks.preview_url, tracks.key, tracks.label, tracks.release_date, tracks.spotify_url, findings.log_id,
  (select name from galaxies where galaxies.id = findings.galaxy_id) as galaxy_name`;

const SEARCH_FROM = `tracks left join findings on findings.track_id = tracks.track_id`;

const CERTIFIED_FIRST = `case when findings.track_id is null then 1 else 0 end asc`;

function parseArtists(json: string): string[] {
  try {
    const raw: unknown = JSON.parse(json);

    return Array.isArray(raw) ? raw.filter((name): name is string => typeof name === "string") : [];
  } catch {
    return [];
  }
}

function toHit(row: SearchRow): SearchHit {
  return {
    album: row.album ?? undefined,
    albumImageUrl: row.album_image_url ?? undefined,
    artists: parseArtists(row.artists_json),
    bpm: row.bpm ?? undefined,
    certified: row.log_id !== null,
    durationMs: row.duration_ms || undefined,
    galaxy: row.galaxy_name ?? undefined,
    key: row.key ?? undefined,
    label: row.label ?? undefined,
    logId: row.log_id ?? undefined,
    previewable: hasPreviewSource({ isrc: row.isrc, previewUrl: row.preview_url }),
    releaseDate: row.release_date ?? undefined,
    spotifyUrl: row.spotify_url ?? undefined,
    title: row.title,
    trackId: row.track_id,
  };
}

function empty(kind: SearchResult["kind"] = "empty"): SearchResult {
  return { degraded: false, entities: [], kind, results: [] };
}

async function ftsSearch(match: string, limit: number): Promise<SearchHit[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [match, limit],
    sql: `select ${SEARCH_SELECT}
          from tracks_fts
          join tracks on tracks.track_id = tracks_fts.track_id
          left join findings on findings.track_id = tracks.track_id
          where tracks_fts match ?
          order by ${CERTIFIED_FIRST}, bm25(tracks_fts) asc, tracks.track_id asc
          limit ?`,
  });

  return typedRows<SearchRow>(result.rows).map(toHit);
}

type EntityRow = {
  image_key?: string | null;
  image_state?: string | null;
  image_updated_at?: string | null;
  image_url: string | null;
  logo_key?: string | null;
  logo_updated_at?: string | null;
  name: string;
  slug: string;
};

const ENTITY_LIMIT = 3;

type EntityQuery = {
  buildArgs: (needle: string, limit: number) => (number | string)[];
  sql: string;
};

export type EntityMatchMode = "exact" | "prefix";

export function entityMatchStatement(
  kind: SearchEntity["kind"],
  query: string,
  mode: EntityMatchMode,
  limit = ENTITY_LIMIT,
): { args: (number | string)[]; sql: string } | undefined {
  const needle = query.trim().toLowerCase();

  if (needle.length === 0) {
    return undefined;
  }

  const { buildArgs, sql } = entitySql(kind, mode);

  return { args: buildArgs(needle, limit), sql };
}

export function labelNameProbeStatement(needle: string): { args: string[]; sql: string } {
  return {
    args: [needle],
    sql: `select name from labels where name = ? collate nocase order by labels.rowid asc limit 1`,
  };
}

function entityUrl(kind: SearchEntity["kind"], slug: string): string {
  if (kind === "galaxy") {
    return `/galaxies/${slug}`;
  }

  if (kind === "mixtape") {
    return `/log/${slug}`;
  }

  return `/${kind}/${slug}`;
}

function entitySql(kind: SearchEntity["kind"], mode: EntityMatchMode): EntityQuery {
  const predicate = mode === "exact" ? "= ?" : "like ? || '%'";

  if (kind === "artist") {
    const nameMatch = mode === "exact" ? "artists.name = ? collate nocase" : "artists.name like ?";

    return {
      buildArgs: (needle, limit) => [
        needle,
        mode === "exact" ? needle : `${needle}%`,
        needle,
        limit,
      ],
      sql: `select artists.name as name, artists.slug as slug, artists.image_url as image_url,
              artists.image_key as image_key, artists.image_state as image_state,
              artists.image_updated_at as image_updated_at,
              case when lower(artists.name) ${predicate} then 0 else 1 end as name_rank
            from artists
            where (${nameMatch}
               or artists.id in (select artist_aliases.artist_id from artist_aliases
                                 where artist_aliases.kind = 'name'
                                   and artist_aliases.status in ('auto', 'confirmed')
                                   and lower(artist_aliases.alias) ${predicate}))
              and ${listedArtistWhere()}
            order by name_rank asc, length(artists.name) asc, artists.name asc
            limit ?`,
    };
  }

  if (kind === "galaxy") {
    return {
      buildArgs: (needle, limit) => [needle, limit],
      sql: `select galaxies.name as name, galaxies.slug as slug
            from galaxies
            where lower(galaxies.name) ${predicate}
              and galaxies.name is not null and galaxies.slug is not null
              and galaxies.retired_at is null
            order by length(galaxies.name) asc, galaxies.name asc
            limit ?`,
    };
  }

  if (kind === "mixtape") {
    return {
      buildArgs: (needle, limit) => [needle, limit],
      sql: `select mixtapes.title as name, mixtapes.log_id as slug
            from mixtapes
            where lower(mixtapes.title) ${predicate}
              and mixtapes.status = 'published' and mixtapes.log_id is not null
            order by length(mixtapes.title) asc, mixtapes.title asc
            limit ?`,
    };
  }

  const table = kind === "album" ? "albums" : "labels";
  const pointer = kind === "album" ? "album_id" : "label_id";
  const floor = kind === "album" ? ALBUM_INDEX_MIN_TRACKS : LABEL_INDEX_MIN_TRACKS;
  const isLabel = kind === "label";
  const nameMatch = mode === "exact" ? `${table}.name = ? collate nocase` : `${table}.name like ?`;
  const nameArg = (needle: string) => (mode === "exact" ? needle : `${needle}%`);
  const logoSelect = isLabel
    ? "labels.image_key as logo_key, labels.image_updated_at as logo_updated_at,"
    : "";
  const labelAliasWhere = isLabel
    ? `or labels.id in (select label_aliases.label_id from label_aliases
                        where label_aliases.kind = 'name'
                          and label_aliases.status = 'confirmed'
                          and lower(label_aliases.alias) ${predicate})`
    : "";
  const labelRankSelect = isLabel
    ? `case when lower(labels.name) ${predicate} then 0 else 1 end as name_rank,`
    : "";
  const labelRankOrder = isLabel ? "name_rank asc," : "";

  return {
    buildArgs: (needle, limit) =>
      isLabel ? [needle, nameArg(needle), needle, limit] : [nameArg(needle), limit],
    sql: `select ${table}.name as name, ${table}.slug as slug, ${logoSelect} ${labelRankSelect}
            (select t.album_image_url
               from tracks t join findings f on f.track_id = t.track_id
               where t.${pointer} = ${table}.id and f.log_id is not null
               order by f.added_at desc limit 1) as image_url
          from ${table}
          where (${nameMatch} ${labelAliasWhere})
            and ${hubInclusionWhere(table, floor)}
          order by ${labelRankOrder} length(${table}.name) asc, ${table}.name asc, ${table}.rowid asc
          limit ?`,
  };
}

function entityImageUrl(kind: SearchEntity["kind"], row: EntityRow): string | undefined {
  if (kind === "artist") {
    return bestArtistAvatarUrl({
      imageKey: row.image_key,
      imageState: row.image_state,
      imageUpdatedAt: row.image_updated_at,
      imageUrl: row.image_url,
    });
  }

  if (kind === "label") {
    return labelLogoUrl(row.logo_key, row.logo_updated_at) ?? row.image_url ?? undefined;
  }

  if (kind === "mixtape") {
    return mixtapeCoverUrl(row.slug);
  }

  return row.image_url ?? undefined;
}

async function matchEntities(
  kind: SearchEntity["kind"],
  query: string,
  mode: EntityMatchMode,
  limit = ENTITY_LIMIT,
): Promise<SearchEntity[]> {
  const statement = entityMatchStatement(kind, query, mode, limit);

  if (!statement) {
    return [];
  }

  const db = await getDb();
  const result = await db.execute(statement);

  return typedRows<EntityRow>(result.rows).map((row) => ({
    imageUrl: entityImageUrl(kind, row),
    kind,
    name: row.name,
    slug: row.slug,
    ...(kind === "galaxy" || kind === "mixtape" ? { url: entityUrl(kind, row.slug) } : {}),
  }));
}

async function prefixEntities(query: string): Promise<SearchEntity[]> {
  const [artists, labels, albums, galaxies, mixtapes] = await Promise.all([
    matchEntities("artist", query, "prefix"),
    matchEntities("label", query, "prefix"),
    matchEntities("album", query, "prefix"),
    matchEntities("galaxy", query, "prefix"),
    matchEntities("mixtape", query, "prefix"),
  ]);

  return [...artists, ...labels, ...albums, ...galaxies, ...mixtapes];
}

function entityRedirect(entity: SearchEntity): string {
  return entity.url ?? entityUrl(entity.kind, entity.slug);
}

async function resolveEntity(query: string): Promise<SearchResult | null> {
  const needle = query.trim().toLowerCase();

  if (needle.length === 0) {
    return null;
  }

  const [artists, labels, albums, galaxies, mixtapes] = await Promise.all([
    matchEntities("artist", needle, "exact", 1),
    matchEntities("label", needle, "exact", 1),
    matchEntities("album", needle, "exact", 1),
    matchEntities("galaxy", needle, "exact", 1),
    matchEntities("mixtape", needle, "exact", 1),
  ]);
  const entity = artists[0] ?? labels[0] ?? albums[0] ?? galaxies[0] ?? mixtapes[0];

  if (entity) {
    if (entity.kind === "galaxy" || entity.kind === "mixtape") {
      return {
        degraded: false,
        entities: [entity],
        kind: "entity",
        redirect: entityRedirect(entity),
        results: [],
      };
    }

    const filters: SearchFilters =
      entity.kind === "artist"
        ? { artist: entity.name }
        : entity.kind === "label"
          ? { label: entity.name }
          : { album: entity.name };
    const { results } = await runFilters(filters, DEFAULT_LIMIT);

    return {
      degraded: false,
      entities: [entity],
      kind: "entity",
      redirect: entityRedirect(entity),
      results,
    };
  }

  const db = await getDb();
  const label = typedRow<{ name: string }>(
    (await db.execute(labelNameProbeStatement(needle))).rows,
  );

  if (label) {
    return {
      ...(await runFilters({ label: label.name }, DEFAULT_LIMIT)),
      filters: { label: label.name },
      kind: "entity",
    };
  }

  const albumSlug = slugify(needle);
  const album = albumSlug
    ? typedRow<{ name: string }>(
        (
          await db.execute({
            args: [albumSlug],
            sql: `select name from albums where slug = ? limit 1`,
          })
        ).rows,
      )
    : undefined;

  if (album) {
    return {
      ...(await runFilters({ album: album.name }, DEFAULT_LIMIT)),
      filters: { album: album.name },
      kind: "entity",
    };
  }

  return null;
}

export type Clause = { args: (number | string)[]; sql: string };

export type ResolvedFilterEntities = {
  albumId?: string;
  artistId?: string;
  labelId?: string;
};

export async function resolveFilterEntities(
  filters: SearchFilters,
): Promise<ResolvedFilterEntities> {
  const [artistId, labelId, albumId] = await Promise.all([
    filters.artist ? resolveFilterArtistId(filters.artist) : Promise.resolve(undefined),
    filters.label ? resolveFilterEntityId("labels", filters.label) : Promise.resolve(undefined),
    filters.album ? resolveFilterEntityId("albums", filters.album) : Promise.resolve(undefined),
  ]);

  return {
    ...(albumId ? { albumId } : {}),
    ...(artistId ? { artistId } : {}),
    ...(labelId ? { labelId } : {}),
  };
}

async function resolveFilterArtistId(name: string): Promise<string | undefined> {
  const needle = name.trim().toLowerCase();

  if (needle.length === 0) {
    return undefined;
  }

  const slug = slugify(name);
  const db = await getDb();
  const primary = await db.execute({
    args: [needle, slug],
    sql: `select artists.id as id
          from artists
          where artists.renderable_track_count > 0
            and (artists.name = ? collate nocase or artists.slug = ?)
          order by length(artists.name) asc, artists.name asc
          limit 1`,
  });
  const primaryId = typedRow<{ id: string }>(primary.rows)?.id;

  if (primaryId !== undefined) {
    return primaryId;
  }

  const alias = await db.execute({
    args: [needle],
    sql: `select artists.id as id
          from artist_aliases
          join artists on artists.id = artist_aliases.artist_id
          where artist_aliases.kind = 'name'
            and artist_aliases.status in ('auto', 'confirmed')
            and lower(artist_aliases.alias) = ?
            and artists.renderable_track_count > 0
          order by length(artists.name) asc, artists.name asc
          limit 1`,
  });

  return typedRow<{ id: string }>(alias.rows)?.id;
}

async function resolveFilterEntityId(
  table: "albums" | "labels",
  name: string,
): Promise<string | undefined> {
  const slug = slugify(name);

  if (!slug) {
    return undefined;
  }

  const db = await getDb();
  const result = await db.execute({
    args: [slug],
    sql: `select id from ${table} where slug = ? and renderable_track_count > 0 limit 1`,
  });
  const directId = typedRow<{ id: string }>(result.rows)?.id;

  if (directId !== undefined || table === "albums") {
    return directId;
  }

  const aliasId = await resolveConfirmedAliasLabelId(slug);

  if (aliasId === undefined) {
    return undefined;
  }

  const gated = await db.execute({
    args: [aliasId],
    sql: `select id from labels where id = ? and renderable_track_count > 0 limit 1`,
  });

  return typedRow<{ id: string }>(gated.rows)?.id;
}

export function compileFilters(
  filters: SearchFilters,
  resolved: ResolvedFilterEntities = {},
): Clause[] {
  const clauses: Clause[] = [];

  if (filters.artist) {
    clauses.push(
      resolved.artistId
        ? {
            args: [resolved.artistId],
            sql: `tracks.track_id in (select track_id from track_artists where artist_id = ?)`,
          }
        : {
            args: [filters.artist.toLowerCase()],
            sql: `lower(tracks.artists_json) like '%' || ? || '%'`,
          },
    );
  }

  if (filters.label) {
    clauses.push(
      resolved.labelId
        ? { args: [resolved.labelId], sql: `tracks.label_id = ?` }
        : { args: [filters.label.toLowerCase()], sql: `lower(tracks.label) = ?` },
    );
  }

  if (filters.album) {
    clauses.push(
      resolved.albumId
        ? { args: [resolved.albumId], sql: `tracks.album_id = ?` }
        : { args: [filters.album.toLowerCase()], sql: `lower(tracks.album) = ?` },
    );
  }

  const parsedKey = parseKey(filters.key);

  if (parsedKey) {
    const spellings = keySpellings(parsedKey);

    clauses.push({
      args: spellings,
      sql: `tracks.key in (${spellings.map(() => "?").join(", ")})`,
    });
  }

  if (typeof filters.bpmMin === "number") {
    clauses.push({ args: [filters.bpmMin], sql: `tracks.bpm >= ?` });
  }

  if (typeof filters.bpmMax === "number") {
    clauses.push({ args: [filters.bpmMax], sql: `tracks.bpm <= ?` });
  }

  if (typeof filters.yearMin === "number") {
    clauses.push({
      args: [String(filters.yearMin)],
      sql: `tracks.release_date >= ?`,
    });
  }

  if (typeof filters.yearMax === "number") {
    clauses.push({
      args: [String(filters.yearMax + 1)],
      sql: `tracks.release_date < ?`,
    });
  }

  const match = filters.text ? toFtsMatch(filters.text) : null;

  if (match) {
    clauses.push({
      args: [match],
      sql: `tracks.track_id in (select track_id from tracks_fts where tracks_fts match ?)`,
    });
  }

  return clauses;
}

async function runFilters(filters: SearchFilters, limit: number): Promise<SearchResult> {
  const clauses = compileFilters(filters, await resolveFilterEntities(filters));

  if (clauses.length === 0) {
    return empty("filters");
  }

  const db = await getDb();
  const result = await db.execute({
    args: [...clauses.flatMap((clause) => clause.args), limit],
    sql: `select ${SEARCH_SELECT}
          from ${SEARCH_FROM}
          where ${clauses.map((clause) => clause.sql).join(" and ")}
          order by ${CERTIFIED_FIRST}, tracks.release_date desc, tracks.track_id asc
          limit ?`,
  });

  return {
    degraded: false,
    entities: [],
    filters,
    kind: "filters",
    results: typedRows<SearchRow>(result.rows).map(toHit),
  };
}

async function resolveAnchor(
  reference: string,
): Promise<{ hit: SearchHit; vector: number[] } | null> {
  const match = toFtsMatch(reference);

  if (!match) {
    return null;
  }

  const db = await getDb();
  const result = await db.execute({
    args: [match],
    sql: `select ${SEARCH_SELECT}, emb.embedding_blob
          from tracks_fts
          join tracks on tracks.track_id = tracks_fts.track_id
          join track_embeddings emb on emb.track_id = tracks.track_id
          left join findings on findings.track_id = tracks.track_id
          where tracks_fts match ?
          order by ${CERTIFIED_FIRST}, bm25(tracks_fts) asc, tracks.track_id asc
          limit 1`,
  });

  const row = typedRow<SearchRow & { embedding_blob: unknown }>(result.rows);

  if (!row) {
    return null;
  }

  const vector = readEmbeddingBlob(row.embedding_blob);

  return vector ? { hit: toHit(row), vector } : null;
}

export async function rankTracksByVector(
  probe: number[],
  columnFilters: SearchFilters,
  excludeTrackId: string | undefined,
  limit: number,
  options: { allowBoundedSql?: boolean } = {},
): Promise<SearchHit[] | null> {
  if (await isSonarSonicEnabled()) {
    const filter = sonarTrackFilter(columnFilters);

    if (!filter) {
      return null;
    }

    const matches = await searchSonar({
      excludeIds: excludeTrackId ? [excludeTrackId] : [],
      filter,
      index: "tracks",
      probes: [probe],
      topK: limit,
    });

    return matches === null ? null : hydrateTrackHits(matches);
  }

  if (options.allowBoundedSql !== true) {
    return null;
  }

  const clauses = compileFilters(columnFilters, await resolveFilterEntities(columnFilters));
  const where = [
    ...clauses.map((clause) => clause.sql),
    ...(excludeTrackId ? ["tracks.track_id != ?"] : []),
    `tracks.has_embedding = 1`,
  ].join(" and ");

  const db = await getDb();
  const result = await executeVectorFallback(db, "sonar.fallback.search", {
    args: [
      ...clauses.flatMap((clause) => clause.args),
      ...(excludeTrackId ? [excludeTrackId] : []),
      toVectorProbe(probe),
      limit,
    ],
    sql: `with candidates(track_id) as materialized (
            select tracks.track_id
            from ${SEARCH_FROM}
            join track_embeddings emb on emb.track_id = tracks.track_id
            where ${where}
            order by tracks.track_id
            ${vectorFallbackCandidateLimitSql()}
          ), winners(track_id, dist) as materialized (
          select candidates.track_id, vector_distance_cos(emb.embedding_blob, ?) as dist
          from candidates
          join track_embeddings emb on emb.track_id = candidates.track_id
          order by dist asc, candidates.track_id asc
          limit ?
        )
        select ${SEARCH_SELECT}
        from winners
        cross join tracks on tracks.track_id = winners.track_id
        left join findings on findings.track_id = tracks.track_id
        order by winners.dist asc, winners.track_id asc`,
  });

  return typedRows<SearchRow>(result.rows).map(toHit);
}

function sonarTrackFilter(columnFilters: SearchFilters): SonarFilter | null {
  if (
    columnFilters.artist !== undefined ||
    columnFilters.album !== undefined ||
    columnFilters.label !== undefined ||
    columnFilters.key !== undefined ||
    columnFilters.yearMin !== undefined ||
    columnFilters.yearMax !== undefined ||
    columnFilters.text !== undefined
  ) {
    return null;
  }

  const filter: SonarFilter = {};

  if (typeof columnFilters.bpmMin === "number") {
    filter.bpm_min = columnFilters.bpmMin;
  }

  if (typeof columnFilters.bpmMax === "number") {
    filter.bpm_max = columnFilters.bpmMax;
  }

  return filter;
}

async function hydrateTrackHits(matches: SonarMatch[]): Promise<SearchHit[]> {
  return hydrateRankedSonarMatches(
    matches,
    async (ids) => {
      const placeholders = ids.map(() => "?").join(", ");
      const db = await getDb();
      const result = await db.execute({
        args: ids,
        sql: `select ${SEARCH_SELECT} from ${SEARCH_FROM} where tracks.track_id in (${placeholders})`,
      });

      return typedRows<SearchRow>(result.rows);
    },
    (row) => row.track_id,
    (row) => toHit(row),
  );
}

const SONIC_UNAVAILABLE = Symbol("sonic-unavailable");
type SonicResolution = SearchResult | null | typeof SONIC_UNAVAILABLE;

async function runSonic(
  filters: SearchFilters,
  limit: number,
  allowBoundedSql: boolean,
): Promise<SonicResolution> {
  const reference = filters.soundsLike;

  if (!reference) {
    return null;
  }

  const anchor = await resolveAnchor(reference);

  if (!anchor) {
    return null;
  }

  const {
    soundsLike: _reference,
    soundsLikeArtists: _artists,
    text: _words,
    ...columnFilters
  } = filters;
  const results = await rankTracksByVector(
    anchor.vector,
    columnFilters,
    anchor.hit.trackId,
    limit,
    {
      allowBoundedSql,
    },
  );

  if (results === null) {
    return SONIC_UNAVAILABLE;
  }

  return { anchor: anchor.hit, degraded: false, entities: [], filters, kind: "sonic", results };
}

type CentroidRow = { artist_id: string; centroid_blob: unknown; name: string };

const CENTROID_SELECT = `select artists.id as artist_id, artists.name as name,
             ac.centroid_blob as centroid_blob`;
const CENTROID_TIEBREAK = `order by length(artists.name) asc, artists.name asc limit 1`;

async function resolveArtistCentroids(
  inputs: string[],
): Promise<{ names: string[]; vectors: number[][] }> {
  const cleaned = [...new Set(inputs.map((input) => input.trim()).filter(Boolean))].slice(
    0,
    MAX_SIMILAR_ARTISTS_INPUT,
  );
  const names: string[] = [];
  const vectors: number[][] = [];
  const seen = new Set<string>();

  if (cleaned.length === 0) {
    return { names, vectors };
  }

  const db = await getDb();

  for (const input of cleaned) {
    const needle = input.toLowerCase();
    const slug = slugify(input);
    const primary = await db.execute({
      args: [needle, slug],
      sql: `${CENTROID_SELECT}
            from artists
            join artist_centroids ac on ac.artist_id = artists.id
            where (artists.name = ? collate nocase or artists.slug = ?)
              and ${listedArtistWhere()}
            ${CENTROID_TIEBREAK}`,
    });
    let row = typedRow<CentroidRow>(primary.rows);

    if (!row) {
      const alias = await db.execute({
        args: [needle],
        sql: `${CENTROID_SELECT}
              from artist_aliases
              join artists on artists.id = artist_aliases.artist_id
              join artist_centroids ac on ac.artist_id = artists.id
              where artist_aliases.kind = 'name'
                and artist_aliases.status in ('auto', 'confirmed')
                and lower(artist_aliases.alias) = ?
                and ${listedArtistWhere()}
              ${CENTROID_TIEBREAK}`,
      });

      row = typedRow<CentroidRow>(alias.rows);
    }

    if (!row || seen.has(row.artist_id)) {
      continue;
    }

    const vector = readEmbeddingBlob(row.centroid_blob);

    if (!vector) {
      continue;
    }

    seen.add(row.artist_id);
    names.push(row.name);
    vectors.push(vector);
  }

  return { names, vectors };
}

async function runArtistSonic(
  filters: SearchFilters,
  limit: number,
  allowBoundedSql: boolean,
): Promise<SonicResolution> {
  const inputs = filters.soundsLikeArtists;

  if (!inputs || inputs.length === 0) {
    return null;
  }

  const resolved = await resolveArtistCentroids(inputs);
  const probe = meanEmbedding(resolved.vectors);

  if (!probe) {
    return null;
  }

  const {
    soundsLike: _reference,
    soundsLikeArtists: _artists,
    text: _words,
    ...columnFilters
  } = filters;
  const results = await rankTracksByVector(probe, columnFilters, undefined, limit, {
    allowBoundedSql,
  });

  if (results === null) {
    return SONIC_UNAVAILABLE;
  }

  return {
    degraded: false,
    entities: [],
    filters: { ...filters, soundsLikeArtists: resolved.names },
    kind: "sonic",
    results,
  };
}

const SPOTIFY_TRACK_REFERENCE =
  /^(?:spotify:track:|https:\/\/open\.spotify\.com\/(?:intl-[a-zA-Z-]+\/)?track\/)([0-9A-Za-z]{22})(?:[?#].*)?$/;

function parseSpotifyTrackId(q: string): string | null {
  return SPOTIFY_TRACK_REFERENCE.exec(q)?.[1] ?? null;
}

async function textFallback(q: string, limit: number, degraded: boolean): Promise<SearchResult> {
  const match = toFtsMatch(q, "or");
  const [results, entities] = await Promise.all([
    match ? ftsSearch(match, limit) : Promise.resolve([]),
    prefixEntities(tokenize(q)[0] ?? ""),
  ]);

  return { degraded, entities, kind: "token", results };
}

export async function searchArchive(options: {
  allowBoundedSonicForDiagnostics?: boolean;
  beforeModel?: () => Promise<void>;
  limit?: number;
  q: string;
}): Promise<SearchResult> {
  const q = options.q.trim();
  const limit = Math.min(
    Math.max(Math.trunc(options.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1),
    50,
  );

  if (q.length === 0) {
    return empty();
  }

  const coordinate = parseCoordinate(q);

  if (coordinate) {
    const db = await getDb();
    const found = typedRow<SearchRow>(
      (
        await db.execute({
          args: [coordinate],
          sql: `select ${SEARCH_SELECT} from ${SEARCH_FROM} where findings.log_id = ? limit 1`,
        })
      ).rows,
    );

    return found
      ? {
          degraded: false,
          entities: [],
          kind: "coordinate",
          redirect: `/log/${found.log_id}`,
          results: [toHit(found)],
        }
      : empty("coordinate");
  }

  const spotifyTrackId = parseSpotifyTrackId(q);

  if (spotifyTrackId !== null) {
    const db = await getDb();
    const found = typedRow<SearchRow>(
      (
        await db.execute({
          args: [`spotify:track:${spotifyTrackId}`],
          sql: `select ${SEARCH_SELECT} from ${SEARCH_FROM} where tracks.spotify_uri = ? limit 1`,
        })
      ).rows,
    );

    if (found) {
      return { degraded: false, entities: [], kind: "token", results: [toHit(found)] };
    }
  }

  const entity = await resolveEntity(q);

  if (entity) {
    return entity;
  }

  if (isBareToken(q)) {
    const match = toFtsMatch(q);
    const [results, entities] = await Promise.all([
      match ? ftsSearch(match, limit) : Promise.resolve([]),
      prefixEntities(q),
    ]);

    return { degraded: false, entities, kind: "token", results };
  }

  const sonicPhrase = parseSonicPhrase(q);

  if (sonicPhrase) {
    const sonic = await runSonic(
      { soundsLike: sonicPhrase },
      Math.min(limit, SONIC_LIMIT),
      options.allowBoundedSonicForDiagnostics === true,
    );

    if (sonic === SONIC_UNAVAILABLE) {
      return textFallback(q, limit, true);
    }

    if (sonic) {
      return sonic;
    }
  }

  await options.beforeModel?.();
  const filters = await translateQuery(q);

  if (filters) {
    const artistSonic = await runArtistSonic(
      filters,
      Math.min(limit, SONIC_LIMIT),
      options.allowBoundedSonicForDiagnostics === true,
    );

    if (artistSonic === SONIC_UNAVAILABLE) {
      return textFallback(q, limit, true);
    }

    if (artistSonic) {
      return artistSonic;
    }

    const sonic = await runSonic(
      filters,
      Math.min(limit, SONIC_LIMIT),
      options.allowBoundedSonicForDiagnostics === true,
    );

    if (sonic === SONIC_UNAVAILABLE) {
      return textFallback(q, limit, true);
    }

    if (sonic) {
      return sonic;
    }

    const filtered = await runFilters(filters, limit);

    if (filtered.results.length > 0) {
      return filtered;
    }

    if (compileFilters({ ...filters, text: undefined }).length > 0) {
      return filtered;
    }
  }

  return textFallback(q, limit, filters === null);
}
