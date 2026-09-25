import { type CatalogueTrackListItem, type SearchFilters } from "@fluncle/contracts/orpc";
import { type Client } from "@libsql/client";
import { parseArtistsJson } from "./artists";
import { listedArtistWhere } from "./artist-visibility";
import { getDb, typedRows } from "./db";
import {
  type FreshCatalogueItem,
  type FreshFinding,
  LEAD_ARTIST_JOIN,
  LEAD_ARTIST_SELECT,
  type LeadArtistRow,
  leadArtistAvatarUrl,
} from "./fresh";
import {
  type HubOrderedPageShape,
  type HubPageAnchor,
  type HubProjectedPageStart,
  hubAnchorExtractionQuery,
  hubClauseHash,
  hubClauseSetKey,
  hubCorpusFingerprint,
  hubOffsetPageQuery,
  hubPageAnchorsFromRows,
  hubSeekPageQuery,
  isShallowHubPage,
  loadPersistedHubPageAnchors,
  persistHubPageAnchors,
  persistedAnchorDecision,
  scheduleHubPageAnchorRefresh,
} from "./hub-page-anchors";
import { type CatalogueHubNumberedPage, CatalogueHubPageOutOfRangeError } from "./labels";
import {
  readProjectedAggregateBuckets,
  readProjectedDefaultTrackTotal,
  readProjectedTrackHubPageStart,
} from "./public-projection-cutover";
import {
  type Clause,
  compileFilters,
  resolveFilterEntities,
  type ResolvedFilterEntities,
} from "./search";
import { logPageUrl } from "../fluncle-links";
import { bestAlbumCoverUrl } from "../media";
import { hasTrackPageIdentity, trackPageUrl } from "../track-page";
import { hasPreviewSource } from "../track-preview";
import { fold } from "./track-match";
import { releasedByTodaySql, releaseTodayUtc, validReleaseDateSql } from "./release-day";
import { TRACK_SELECT, toPublicTrackListItem, toTrackListItem, type TrackRow } from "./tracks";

export const TRACKS_HUB_PAGE_SIZE = 48;

export const TRACKS_HUB_ORDER_BY = "tracks.release_date desc, tracks.track_id desc";

export type TracksHubFilters = Pick<
  SearchFilters,
  "bpmMax" | "bpmMin" | "key" | "label" | "yearMax" | "yearMin"
> & {
  certified?: boolean;
  galaxy?: string;
};

export type TracksHubArtistLink = { name: string; slug?: string };

export type TracksHubEntry =
  | {
      artistLinks: TracksHubArtistLink[];
      finding: FreshFinding;
      kind: "finding";
      releaseDate: string;
    }
  | {
      artistLinks: TracksHubArtistLink[];
      kind: "catalogue";
      label?: string;
      labelSlug?: string;
      releaseDate: string;
      track: FreshCatalogueItem;
    };

export type TracksHubYearLaneEntry = { page: number; year: string };

type TracksHubRow = LeadArtistRow &
  TrackRow & {
    artist_slugs_json: string | null;

    certified: number;
  };

function galaxyClause(slug: string): Clause {
  return {
    args: [slug],
    sql: `findings.galaxy_id = (
            select id from galaxies where slug = ? and name is not null and retired_at is null
          )`,
  };
}

export async function resolveTracksHubEntities(
  filters: TracksHubFilters,
): Promise<ResolvedFilterEntities> {
  return resolveFilterEntities(filters);
}

export function tracksHubClauses(
  filters: TracksHubFilters,
  resolved: ResolvedFilterEntities = {},
  today?: string,
): Clause[] {
  const clauses = compileFilters(filters, resolved);

  if (today !== undefined) {
    clauses.push({ args: [today], sql: releasedByTodaySql("tracks.release_date") });
  }

  if (filters.galaxy) {
    clauses.push(galaxyClause(filters.galaxy));
  }

  if (filters.certified === true) {
    clauses.push({ args: [], sql: `tracks.is_catalogue = 0` });
  } else if (filters.certified === false) {
    clauses.push({ args: [], sql: `tracks.is_catalogue = 1` });
  }

  return clauses;
}

function whereFor(clauses: Clause[]): { args: (number | string)[]; where: string } {
  return {
    args: clauses.flatMap((clause) => clause.args),
    where: clauses.length > 0 ? `where ${clauses.map((clause) => clause.sql).join(" and ")}` : "",
  };
}

function findingsJoinFor(clauses: Clause[]): string {
  return clauses.some((clause) => clause.sql.includes("findings."))
    ? "left join findings on findings.track_id = tracks.track_id"
    : "";
}

export function tracksHubSeekClause(anchor: HubPageAnchor): Clause {
  if (anchor.key === null) {
    return {
      args: [anchor.id],
      sql: `tracks.release_date is null and tracks.track_id < ?`,
    };
  }

  return {
    args: [anchor.key, anchor.key, anchor.id],
    sql: `(tracks.release_date < ?
           or (tracks.release_date = ? and tracks.track_id < ?)
           or tracks.release_date is null)`,
  };
}

function tracksHubOrderedShape(
  clauses: Clause[],
  projection = "tracks.track_id as track_id",
): HubOrderedPageShape {
  return {
    clauses,
    from: `tracks ${findingsJoinFor(clauses)}`,
    idExpr: "tracks.track_id",
    keyAlias: "rd",
    keyExpr: "tracks.release_date",
    orderBy: TRACKS_HUB_ORDER_BY,
    pageSize: TRACKS_HUB_PAGE_SIZE,
    projection,
    seekAfter: tracksHubSeekClause,
  };
}

export function tracksHubClauseKey(
  filters: TracksHubFilters,
  resolved: ResolvedFilterEntities = {},
): string {
  return hubClauseSetKey(tracksHubClauses(filters, resolved));
}

function tracksHubPersistedClauseHash(): string {
  return hubClauseHash(
    JSON.stringify({
      clauses: hubClauseSetKey([]),
      orderBy: TRACKS_HUB_ORDER_BY,
      pageSize: TRACKS_HUB_PAGE_SIZE,
    }),
  );
}

export const TRACKS_HUB_ANCHOR_ADDRESS = {
  clauseHash: tracksHubPersistedClauseHash(),
  hub: "tracks",
} as const;

const HUB_AGGREGATE_TTL_MS = 60_000;

const HUB_AGGREGATE_CACHE_MAX = 32;

type HubAggregateEntry = { expires: number; value: Promise<unknown> };

const hubAggregateCache = new Map<string, HubAggregateEntry>();

async function memoizedAggregate<T>(key: string, load: () => Promise<T>): Promise<T> {
  const cached = hubAggregateCache.get(key);
  const now = Date.now();

  if (cached && cached.expires > now) {
    return cached.value as Promise<T>;
  }

  const value = load();

  hubAggregateCache.set(key, { expires: now + HUB_AGGREGATE_TTL_MS, value });

  if (hubAggregateCache.size > HUB_AGGREGATE_CACHE_MAX) {
    const oldest = hubAggregateCache.keys().next();

    if (!oldest.done) {
      hubAggregateCache.delete(oldest.value);
    }
  }

  try {
    return await value;
  } catch (error) {
    hubAggregateCache.delete(key);

    throw error;
  }
}

export function resetTracksHubAggregateCache(): void {
  hubAggregateCache.clear();
}

function aggregateKey(kind: string, clauses: Clause[]): string {
  return `${kind}:${hubClauseSetKey(clauses)}`;
}

const ARTIST_SLUGS_SELECT = `(select json_group_array(json_object('name', a.name, 'slug', a.slug))
     from track_artists ta join artists a on a.id = ta.artist_id
     where ta.track_id = tracks.track_id and ${listedArtistWhere("a")}) as artist_slugs_json`;

function parseArtistSlugMap(json: string | null): Map<string, string> {
  const map = new Map<string, string>();

  if (!json) {
    return map;
  }

  try {
    const parsed = JSON.parse(json) as unknown;

    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        const name = (entry as Record<string, unknown>)?.["name"];
        const slug = (entry as Record<string, unknown>)?.["slug"];

        if (typeof name === "string" && typeof slug === "string" && slug) {
          map.set(fold(name), slug);
        }
      }
    }
  } catch {
    return map;
  }

  return map;
}

function toTracksHubEntry(row: TracksHubRow): TracksHubEntry {
  const releaseDate = row.release_date ?? "";
  const artistAvatarUrl = leadArtistAvatarUrl(row);
  const displayArtists = parseArtistsJson(row.artists_json);
  const slugMap = parseArtistSlugMap(row.artist_slugs_json);
  const artistLinks: TracksHubArtistLink[] = displayArtists.map((name) => {
    const slug = slugMap.get(fold(name));

    return slug ? { name, slug } : { name };
  });

  if (row.certified) {
    return {
      artistLinks,
      finding: { ...toPublicTrackListItem(toTrackListItem(row)), artistAvatarUrl },
      kind: "finding",
      releaseDate,
    };
  }

  return {
    artistLinks,
    kind: "catalogue",
    label: row.label ?? undefined,
    labelSlug: row.label_slug ?? undefined,
    releaseDate,
    track: {
      albumImageUrl: bestAlbumCoverUrl({
        imageKey: row.album_image_key,
        imageState: row.album_image_state,
        imageUpdatedAt: row.album_image_updated_at,
        spotifyUrl: row.album_image_url,
      }),
      artistAvatarUrl,
      artists: displayArtists,
      bpm: row.bpm ?? undefined,
      durationMs: row.duration_ms || undefined,
      key: row.key ?? undefined,
      previewable: hasPreviewSource({ isrc: row.isrc, previewUrl: row.preview_url }),
      releaseDate,
      spotifyUrl: row.spotify_url ?? undefined,
      title: row.title,
      trackId: row.track_id,
    },
  };
}

export function toCatalogueTrackListItem(entry: TracksHubEntry): CatalogueTrackListItem {
  if (entry.kind === "finding") {
    const finding = entry.finding;

    return {
      album: finding.album,
      albumSlug: finding.albumSlug,
      artists: finding.artists,
      certified: true,
      coverImageUrl: finding.albumImageUrl,
      label: finding.label,
      labelSlug: finding.labelSlug,
      logId: finding.logId,
      releaseDate: (finding.releaseDate ?? entry.releaseDate) || undefined,
      spotifyUrl: finding.spotifyUrl,
      title: finding.title,
      trackId: finding.trackId,

      ...(finding.logId ? { url: logPageUrl(finding.logId) } : {}),
    };
  }

  return {
    artists: entry.track.artists,
    certified: false,
    label: entry.label,
    labelSlug: entry.labelSlug,
    releaseDate: entry.releaseDate || undefined,
    spotifyUrl: entry.track.spotifyUrl,
    title: entry.track.title,
    trackId: entry.track.trackId,
    ...(hasTrackPageIdentity(entry.track) ? { url: trackPageUrl(entry.track.trackId) } : {}),
  };
}

export function tracksHubCountQuery(
  filters: TracksHubFilters,
  resolved: ResolvedFilterEntities = {},
  today?: string,
): {
  args: (number | string)[];
  sql: string;
} {
  const clauses = tracksHubClauses(filters, resolved, today);
  const { args, where } = whereFor(clauses);

  return {
    args,
    sql: `select count(*) as total
          from tracks
          ${findingsJoinFor(clauses)}
          ${where}`,
  };
}

export function tracksHubIdPageQuery(
  filters: TracksHubFilters,
  limit: number,
  offset: number,
  resolved: ResolvedFilterEntities = {},
  today?: string,
): { args: (number | string)[]; sql: string } {
  const clauses = tracksHubClauses(filters, resolved, today);
  const query = hubOffsetPageQuery(tracksHubOrderedShape(clauses), limit, offset);

  return {
    args: query.args,
    sql: query.sql,
  };
}

export function tracksHubAnchorExtractionQuery(
  filters: TracksHubFilters,
  resolved: ResolvedFilterEntities = {},
  today?: string,
): { args: (number | string)[]; sql: string } {
  return hubAnchorExtractionQuery(
    tracksHubOrderedShape(tracksHubClauses(filters, resolved, today)),
  );
}

export function tracksHubSeekIdPageQuery(
  filters: TracksHubFilters,
  page: number,
  anchors: HubPageAnchor[],
  resolved: ResolvedFilterEntities = {},
  today?: string,
): { args: (number | string)[]; remainder: number; sql: string } {
  const query = hubSeekPageQuery(
    tracksHubOrderedShape(tracksHubClauses(filters, resolved, today)),
    page,
    anchors,
  );

  return { args: query.args, remainder: query.remainder, sql: query.sql };
}

type ProjectedTracksHubIdQuery = { args: (number | string)[]; sql: string };

export type ProjectedTracksHubIdPageQueries = {
  nullFill?: (remaining: number) => ProjectedTracksHubIdQuery;
  primary: ProjectedTracksHubIdQuery;
};

export function projectedTracksHubIdPageQueries(
  start: HubProjectedPageStart,
  limit: number,
): ProjectedTracksHubIdPageQueries {
  if (start.phase === "null") {
    return {
      primary:
        start.after === null
          ? {
              args: [limit, start.offset],
              sql: `select tracks.track_id as track_id
                from tracks indexed by tracks_release_date_track_id_idx
                where tracks.release_date is null
                order by ${TRACKS_HUB_ORDER_BY}
                limit ? offset ?`,
            }
          : {
              args: [start.after.id, limit, start.offset],
              sql: `select tracks.track_id as track_id
                from tracks indexed by tracks_release_date_track_id_idx
                where tracks.release_date is null and tracks.track_id < ?
                order by ${TRACKS_HUB_ORDER_BY}
                limit ? offset ?`,
            },
    };
  }

  if (start.after === null) {
    return {
      primary: {
        args: [limit, start.offset],
        sql: `select tracks.track_id as track_id
          from tracks indexed by tracks_release_date_track_id_idx
          order by ${TRACKS_HUB_ORDER_BY}
          limit ? offset ?`,
      },
    };
  }

  if (start.after.key === null) {
    throw new Error("projected tracks hub page start mixes a NULL row into the non-NULL phase");
  }

  return {
    nullFill: (remaining) => ({
      args: [remaining],
      sql: `select tracks.track_id as track_id
        from tracks indexed by tracks_release_date_track_id_idx
        where tracks.release_date is null
        order by ${TRACKS_HUB_ORDER_BY}
        limit ?`,
    }),
    primary: {
      args: [start.after.key, start.after.id, limit, start.offset],
      sql: `select tracks.track_id as track_id
        from tracks indexed by tracks_release_date_track_id_idx
        where (tracks.release_date, tracks.track_id) < (?, ?)
        order by ${TRACKS_HUB_ORDER_BY}
        limit ? offset ?`,
    },
  };
}

async function readProjectedTracksHubIdPage(
  client: Pick<Client, "execute">,
  start: HubProjectedPageStart,
  limit: number,
): Promise<Awaited<ReturnType<Client["execute"]>>> {
  const queries = projectedTracksHubIdPageQueries(start, limit);
  const primary = await client.execute(queries.primary);
  const remaining = limit - primary.rows.length;

  if (remaining <= 0 || queries.nullFill === undefined) {
    return primary;
  }

  const fill = await client.execute(queries.nullFill(remaining));
  return { ...primary, rows: [...primary.rows, ...fill.rows] };
}

export function tracksHubHydrateQuery(ids: string[]): { args: string[]; sql: string } {
  const placeholders = ids.map(() => "?").join(", ");

  return {
    args: ids,
    sql: `select ${TRACK_SELECT}, ${LEAD_ARTIST_SELECT},
                 (findings.track_id is not null) as certified,
                 ${ARTIST_SLUGS_SELECT}
          from tracks
          left join findings on findings.track_id = tracks.track_id
          ${LEAD_ARTIST_JOIN}
          where tracks.track_id in (${placeholders})`,
  };
}

async function countTracksHub(
  filters: TracksHubFilters,
  resolved: ResolvedFilterEntities,
  today?: string,
  futureCount = 0,
): Promise<number> {
  const clauses = tracksHubClauses(filters, resolved, today);
  const query = tracksHubCountQuery(filters, resolved, today);

  return memoizedAggregate(aggregateKey("count", clauses), async () => {
    const db = await getDb();
    if (tracksHubClauses(filters, resolved).length === 0) {
      return (await readDefaultTracksHubTotal(db)) - futureCount;
    }
    const result = await db.execute(query);

    return Number(typedRows<{ total: number }>(result.rows)[0]?.total ?? 0);
  });
}

async function extractTracksHubAnchors(
  filters: TracksHubFilters,
  resolved: ResolvedFilterEntities,
  today?: string,
): Promise<HubPageAnchor[]> {
  const db = await getDb();
  const query = tracksHubAnchorExtractionQuery(filters, resolved, today);
  const result = await db.execute(query);

  return hubPageAnchorsFromRows(
    typedRows<Record<string, unknown>>(result.rows),
    "rd",
    TRACKS_HUB_PAGE_SIZE,
  );
}

async function refreshPersistedTracksHubAnchors(): Promise<void> {
  const db = await getDb();
  const anchorQuery = tracksHubAnchorExtractionQuery({});
  const countQuery = tracksHubCountQuery({});
  const firstQuery = tracksHubIdPageQuery({}, 1, 0);
  const [anchorResult, countResult, firstResult] = await Promise.all([
    db.execute(anchorQuery),
    db.execute(countQuery),
    db.execute(firstQuery),
  ]);
  const anchors = hubPageAnchorsFromRows(
    typedRows<Record<string, unknown>>(anchorResult.rows),
    "rd",
    TRACKS_HUB_PAGE_SIZE,
  );
  const total = Number(typedRows<{ total: number }>(countResult.rows)[0]?.total ?? 0);
  const firstId = typedRows<{ track_id: string }>(firstResult.rows)[0]?.track_id;

  await persistHubPageAnchors(
    TRACKS_HUB_ANCHOR_ADDRESS.hub,
    TRACKS_HUB_ANCHOR_ADDRESS.clauseHash,
    anchors,
    hubCorpusFingerprint(total, firstId),
  );
}

function scheduleTracksHubAnchorRefresh(): void {
  scheduleHubPageAnchorRefresh(
    `${TRACKS_HUB_ANCHOR_ADDRESS.hub}:${TRACKS_HUB_ANCHOR_ADDRESS.clauseHash}`,
    refreshPersistedTracksHubAnchors,
  );
}

export async function listTracksHubPage(
  filters: TracksHubFilters,
  page: number,
  now: Date = new Date(),
): Promise<CatalogueHubNumberedPage<TracksHubEntry>> {
  const db = await getDb();
  const limit = TRACKS_HUB_PAGE_SIZE;
  const boundary = releaseTodayUtc(now);
  const { futureCount, retainedHeadCount } = await releaseHeadCounts(db, boundary);
  const today = futureCount > 0 ? boundary : undefined;

  const resolved = await resolveTracksHubEntities(filters);
  const clauses = tracksHubClauses(filters, resolved, today);
  let total: number;
  let idsResult: Awaited<ReturnType<typeof db.execute>>;

  const logicalRank = (page - 1) * limit;
  const retainedHeadRows = Math.min(limit, Math.max(0, retainedHeadCount - logicalRank));
  const projectedRank = futureCount + Math.max(logicalRank, retainedHeadCount);
  const projectedPage = Math.floor(projectedRank / limit) + 1;
  const projectedSkip = projectedRank % limit;
  const projectedStart =
    tracksHubClauses(filters, resolved).length === 0
      ? await readProjectedTrackHubPageStart(db, TRACKS_HUB_ANCHOR_ADDRESS, limit, projectedPage)
      : undefined;

  if (projectedStart !== undefined) {
    total = projectedStart.total - futureCount;
    if (page > Math.max(Math.ceil(total / limit), 1)) {
      throw new CatalogueHubPageOutOfRangeError();
    }
    const headResult =
      retainedHeadRows > 0
        ? await db.execute({
            args: [boundary, retainedHeadRows, logicalRank],
            sql: `select tracks.track_id as track_id
            from tracks indexed by tracks_release_date_track_id_idx
            where tracks.release_date > ? and not ${validReleaseDateSql("tracks.release_date")}
            order by ${TRACKS_HUB_ORDER_BY} limit ? offset ?`,
          })
        : undefined;
    const tailLimit = limit - retainedHeadRows;
    const projectedRows =
      projectedStart.start !== undefined && tailLimit > 0
        ? await readProjectedTracksHubIdPage(db, projectedStart.start, tailLimit + projectedSkip)
        : undefined;
    const baseResult =
      projectedRows ?? headResult ?? (await db.execute(`select track_id from tracks where 0`));
    idsResult = {
      ...baseResult,
      rows: [...(headResult?.rows ?? []), ...(projectedRows?.rows.slice(projectedSkip) ?? [])],
    };
  } else if (isShallowHubPage(page, limit)) {
    [total, idsResult] = await Promise.all([
      countTracksHub(filters, resolved, today, futureCount),
      db.execute(tracksHubIdPageQuery(filters, limit, (page - 1) * limit, resolved, today)),
    ]);
  } else if (clauses.length > 0) {
    const anchorsPromise = memoizedAggregate(aggregateKey("anchors", clauses), () =>
      extractTracksHubAnchors(filters, resolved, today),
    );
    const result = await Promise.all([
      countTracksHub(filters, resolved, today, futureCount),
      anchorsPromise,
    ]);
    total = result[0];
    idsResult = await db.execute(
      tracksHubSeekIdPageQuery(filters, page, result[1], resolved, today),
    );
  } else {
    const firstQuery = tracksHubIdPageQuery({}, 1, 0);
    const [resolvedTotal, stored, firstResult] = await Promise.all([
      countTracksHub(filters, resolved, today, futureCount),
      loadPersistedHubPageAnchors(
        TRACKS_HUB_ANCHOR_ADDRESS.hub,
        TRACKS_HUB_ANCHOR_ADDRESS.clauseHash,
      ),
      db.execute(firstQuery),
    ]);
    total = resolvedTotal;
    const firstId = typedRows<{ track_id: string }>(firstResult.rows)[0]?.track_id;
    const decision = persistedAnchorDecision(
      page,
      limit,
      stored,
      hubCorpusFingerprint(total, firstId),
    );

    if (decision.refresh) {
      scheduleTracksHubAnchorRefresh();
    }

    idsResult = await db.execute(
      decision.mode === "seek" && stored
        ? tracksHubSeekIdPageQuery(filters, page, stored.anchors, resolved)
        : tracksHubIdPageQuery(filters, limit, (page - 1) * limit, resolved),
    );
  }

  const ids = typedRows<{ track_id: string }>(idsResult.rows).map((row) => row.track_id);

  if (ids.length === 0 && page > 1) {
    throw new CatalogueHubPageOutOfRangeError();
  }

  const rows: TracksHubRow[] = [];

  if (ids.length > 0) {
    const hydrated = await db.execute(tracksHubHydrateQuery(ids));

    const byId = new Map(typedRows<TracksHubRow>(hydrated.rows).map((row) => [row.track_id, row]));

    for (const id of ids) {
      const row = byId.get(id);

      if (row) {
        rows.push(row);
      }
    }
  }

  return {
    items: rows.map(toTracksHubEntry),
    page,
    pageCount: Math.max(Math.ceil(total / limit), 1),
    total,
  };
}

async function releaseHeadCounts(
  client: Pick<Client, "execute">,
  today: string,
): Promise<{ futureCount: number; retainedHeadCount: number }> {
  const result = await client.execute({
    args: [today],
    sql: `select count(*) as after_today,
          coalesce(sum(case when ${validReleaseDateSql("tracks.release_date")} then 1 else 0 end), 0) as future_count
          from tracks indexed by tracks_release_date_track_id_idx
          where tracks.release_date > ?`,
  });
  const row = typedRows<{ after_today: number; future_count: number }>(result.rows)[0];
  const futureCount = Number(row?.future_count ?? 0);
  return { futureCount, retainedHeadCount: Number(row?.after_today ?? 0) - futureCount };
}

export async function countAllTracks(now: Date = new Date()): Promise<number> {
  const today = releaseTodayUtc(now);
  const clauses = tracksHubClauses({}, {}, today);
  return memoizedAggregate(aggregateKey("count", clauses), async () => {
    const db = await getDb();
    const projected = await readProjectedDefaultTrackTotal(db);
    if (projected !== undefined) {
      return projected - (await releaseHeadCounts(db, today)).futureCount;
    }
    const result = await db.execute(tracksHubCountQuery({}, {}, today));
    return Number(typedRows<{ total: number }>(result.rows)[0]?.total ?? 0);
  });
}

export async function readDefaultTracksHubTotal(client: Pick<Client, "execute">): Promise<number> {
  const projected = await readProjectedDefaultTrackTotal(client);
  if (projected !== undefined) {
    return projected;
  }
  const result = await client.execute(tracksHubCountQuery({}));
  return Number(typedRows<{ total: number }>(result.rows)[0]?.total ?? 0);
}

function isYearBucket(year: string): boolean {
  return /^\d{4}$/.test(year);
}

export function yearPages(
  counts: { n: number; year: string }[],
  pageSize: number,
): TracksHubYearLaneEntry[] {
  const lane: TracksHubYearLaneEntry[] = [];
  let rank = 0;

  for (const { n, year } of counts) {
    if (isYearBucket(year)) {
      lane.push({ page: Math.floor(rank / pageSize) + 1, year });
    }

    rank += Number(n);
  }

  return lane;
}

export function tracksHubYearLaneQuery(
  filters: TracksHubFilters,
  resolved: ResolvedFilterEntities = {},
  today?: string,
): {
  args: (number | string)[];
  clauses: Clause[];
  sql: string;
} {
  const clauses: Clause[] = [
    { args: [], sql: `tracks.release_date is not null` },
    ...tracksHubClauses(filters, resolved, today),
  ];
  const { args, where } = whereFor(clauses);

  return {
    args,
    clauses,

    sql: `select substr(tracks.release_date, 1, 4) as year, count(*) as n
          from tracks
          ${findingsJoinFor(clauses)}
          ${where}
          group by year
          order by year desc`,
  };
}

export async function listTracksHubYearLane(
  filters: TracksHubFilters,
  now: Date = new Date(),
): Promise<TracksHubYearLaneEntry[]> {
  const db = await getDb();
  const boundary = releaseTodayUtc(now);
  const today = (await releaseHeadCounts(db, boundary)).futureCount > 0 ? boundary : undefined;
  const resolved = await resolveTracksHubEntities(filters);
  const { clauses, ...query } = tracksHubYearLaneQuery(filters, resolved, today);

  return memoizedAggregate(aggregateKey("years", clauses), async () => {
    if (tracksHubClauses(filters, resolved).length === 0) {
      const projected = await readProjectedAggregateBuckets(db, "release_date_bucket", today);
      if (projected !== undefined) {
        return yearPages(
          projected
            .filter(({ count }) => count > 0)
            .map(({ bucket, count }) => ({ n: count, year: bucket })),
          TRACKS_HUB_PAGE_SIZE,
        );
      }
    }
    const result = await db.execute(query);

    return yearPages(typedRows<{ n: number; year: string }>(result.rows), TRACKS_HUB_PAGE_SIZE);
  });
}
