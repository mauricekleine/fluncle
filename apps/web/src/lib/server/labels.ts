import { type Client, type InStatement, type Row } from "@libsql/client";
import { randomUUID } from "node:crypto";
import {
  type LabelAdminItem,
  type LabelAliasCandidate,
  type LabelDetail,
  type LabelListItem,
  type LabelSeedState,
  type MergeLabelResult,
} from "@fluncle/contracts";
import { labelFold, slugify } from "@fluncle/contracts/util/galaxy-slug";
import { bestAlbumCoverUrl, labelLogoUrl } from "../media";
import { bioBypassColumns } from "./bio-review";
import { restaleCatalogueRankByLabelStatement } from "./catalogue-rank-restale";
import {
  markCrawlProjectionRepairStatement,
  markCrawlProjectionRepairsFromSelectStatement,
} from "./crawl-due-work";
import { getDb, typedRows } from "./db";
import { FRESH_WINDOW_DAYS, releaseTodayUtc, releaseWindowLowerBound } from "./release-day";
import { isDueWorkCutoverEnabled, readPromotedDueWorkPage } from "./due-work-cutover";
import {
  type DueWorkStatement,
  DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
  markDueWorkSourceMaintenanceFromSelectStatements,
  markDueWorkSourceMaintenanceStatements,
} from "./due-work";
import {
  type HubOrderedPageShape,
  type HubPageAnchor,
  hubAnchorExtractionQuery,
  hubClauseHash,
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
import {
  type HubCountCensusRow,
  type HubCountDelta,
  hubCountDeltaStatement,
  relinkTracksToEntity,
  toHubCountMoveGroups,
} from "./hub-counts";

export { labelFold };

export const LABEL_INDEX_MIN_TRACKS = 3;

export { DISTRIBUTOR_DENYLIST, isDistributorLabel } from "../label-distributors";

type LabelRow = {
  created_at: string;
  disambiguation: string | null;
  founded_location: string | null;
  founding_date: string | null;
  id: string;
  image_key: string | null;
  image_updated_at: string | null;
  mb_label_id: string | null;
  name: string;
  ruled_at: string | null;
  scope_changed_at: string | null;
  seed_state: LabelSeedState;
  slug: string;
  updated_at: string;
};

type LabelCountRow = { label: string; n: number };

export function labelSlug(raw: string | null | undefined): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }

  const slug = slugify(raw.trim());

  return slug === "" ? undefined : slug;
}

function toLabelItem(row: LabelRow, findingCount: number): LabelAdminItem {
  return {
    createdAt: row.created_at,
    disambiguation: row.disambiguation,
    findingCount,
    foundedLocation: row.founded_location,
    foundingDate: row.founding_date,
    id: row.id,
    logoImageUrl: labelLogoUrl(row.image_key, row.image_updated_at),
    mbLabelId: row.mb_label_id,
    name: row.name,
    ruledAt: row.ruled_at,
    scopeChangedAt: row.scope_changed_at,
    seedState: row.seed_state,
    slug: row.slug,
    updatedAt: row.updated_at,
  };
}

const LABEL_COLUMNS = `id, name, slug, seed_state, ruled_at, scope_changed_at, created_at, updated_at,
   image_key, image_updated_at, mb_label_id, disambiguation, founding_date, founded_location`;

export const LABELS_ADMIN_PAGE_SIZE = 50;

export async function resolveConfirmedAliasLabelId(
  slug: string,
  client?: Pick<Client, "execute">,
): Promise<string | undefined> {
  const db = client ?? (await getDb());
  const result = await db.execute({
    args: [slug],
    sql: `select label_id from label_aliases where alias_slug = ? and status = 'confirmed' limit 1`,
  });

  return typedRows<{ label_id: string }>(result.rows)[0]?.label_id;
}

export async function ensureLabel(
  raw: string | null | undefined,
  mbLabelId?: null | string,
  client?: Pick<Client, "batch" | "execute">,
): Promise<string | undefined> {
  const db = client ?? (await getDb());
  const mbid = typeof mbLabelId === "string" && mbLabelId.trim() ? mbLabelId.trim() : null;

  if (mbid) {
    const byMbid = await db.execute({
      args: [mbid],
      sql: `select id from labels where mb_label_id = ? limit 1`,
    });
    const existingId = typedRows<{ id: string }>(byMbid.rows)[0]?.id;

    if (existingId) {
      return existingId;
    }
  }

  const slug = labelSlug(raw);

  if (!slug || typeof raw !== "string") {
    return undefined;
  }

  const aliasLabelId = await resolveConfirmedAliasLabelId(slug, db);

  if (aliasLabelId) {
    await adoptLabelMbLabelId(aliasLabelId, mbid, db);

    return aliasLabelId;
  }

  const now = new Date().toISOString();
  const labelId = `lbl_${randomUUID()}`;

  await db.batch(
    [
      {
        args: [labelId, raw.trim(), slug, mbid, now, now],
        sql: `insert into labels (id, name, slug, mb_label_id, created_at, updated_at)
              values (?, ?, ?, ?, ?, ?)
              on conflict (slug) do nothing`,
      },
      ...markDueWorkSourceMaintenanceStatements([{ subjectId: labelId, subjectType: "label" }], {
        onlyIfPreviousStatementChanged: true,
        producer: "label-mint",
      }),
    ],
    "write",
  );

  const result = await db.execute({
    args: [slug],
    sql: `select id, mb_label_id from labels where slug = ? limit 1`,
  });
  const row = typedRows<{ id: string; mb_label_id: null | string }>(result.rows)[0];

  if (!row) {
    return undefined;
  }

  if (!row.mb_label_id) {
    await adoptLabelMbLabelId(row.id, mbid, db);
  }

  return row.id;
}

export async function adoptLabelMbLabelId(
  labelId: string,
  mbid: null | string,
  client?: Pick<Client, "execute">,
): Promise<void> {
  if (!mbid) {
    return;
  }

  const db = client ?? (await getDb());

  await db
    .execute({
      args: [mbid, new Date().toISOString(), labelId],
      sql: `update labels set mb_label_id = ?, updated_at = ?
            where id = ? and mb_label_id is null`,
    })
    .catch(() => undefined);
}

export async function linkTrackToLabel(
  trackId: string,
  raw: string | null | undefined,
): Promise<void> {
  const labelId = await ensureLabel(raw);

  if (!labelId) {
    return;
  }

  await relinkTracksToEntity("labels", labelId, [trackId]);
}

export type LabelLineageEdge = { name: string; slug: string };

export type LabelRecord = {
  bio?: string;

  discogsLabelId: number | undefined;

  foundedLocation?: string;

  foundingDate?: string;
  id: string;

  logoImageUrl: string | undefined;

  mbLabelId: string | undefined;
  name: string;

  parentLabel?: LabelLineageEdge;

  renderableTrackCount?: number;
  slug: string;

  subLabels?: LabelLineageEdge[];
};

const LABEL_SUBLABELS_LIMIT = 50;

async function getLabelLineageEdges(
  labelId: string,
  parentLabelId: string | null,
): Promise<{ parentLabel?: LabelLineageEdge; subLabels: LabelLineageEdge[] }> {
  const db = await getDb();

  const [parentResult, childrenResult] = await Promise.all([
    parentLabelId
      ? db.execute({
          args: [parentLabelId],
          sql: `select name, slug from labels where id = ? limit 1`,
        })
      : undefined,
    db.execute({
      args: [labelId, LABEL_SUBLABELS_LIMIT],
      sql: `select name, slug from labels where parent_label_id = ? order by name collate nocase asc limit ?`,
    }),
  ]);
  const parentRow = parentResult
    ? typedRows<{ name: string; slug: string }>(parentResult.rows)[0]
    : undefined;

  return {
    parentLabel: parentRow ? { name: parentRow.name, slug: parentRow.slug } : undefined,
    subLabels: typedRows<{ name: string; slug: string }>(childrenResult.rows).map((child) => ({
      name: child.name,
      slug: child.slug,
    })),
  };
}

export async function getLabelBySlug(slug: string): Promise<LabelRecord | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [slug],
    sql: `select ${LABEL_COLUMNS}, bio, discogs_label_id, parent_label_id, renderable_track_count
          from labels where slug = ? limit 1`,
  });

  const row = typedRows<
    LabelRow & {
      bio: string | null;
      discogs_label_id: number | null;
      parent_label_id: string | null;
      renderable_track_count: number;
    }
  >(result.rows)[0];

  if (!row) {
    return undefined;
  }

  const lineage = await getLabelLineageEdges(row.id, row.parent_label_id);

  return {
    bio: typeof row.bio === "string" && row.bio.trim() ? row.bio : undefined,
    discogsLabelId: typeof row.discogs_label_id === "number" ? row.discogs_label_id : undefined,
    foundedLocation:
      typeof row.founded_location === "string" && row.founded_location.trim()
        ? row.founded_location
        : undefined,
    foundingDate:
      typeof row.founding_date === "string" && row.founding_date.trim()
        ? row.founding_date
        : undefined,
    id: row.id,
    logoImageUrl: labelLogoUrl(row.image_key, row.image_updated_at),
    mbLabelId: typeof row.mb_label_id === "string" && row.mb_label_id ? row.mb_label_id : undefined,
    name: row.name,
    parentLabel: lineage.parentLabel,
    renderableTrackCount: Number(row.renderable_track_count),
    slug: row.slug,
    subLabels: lineage.subLabels,
  };
}

export async function getLabelForAlbum(albumId: string): Promise<LabelRecord | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [albumId],
    sql: `select labels.id, labels.name, labels.slug, count(*) as n
          from tracks
          join labels on labels.id = tracks.label_id
          join findings on findings.track_id = tracks.track_id
          where tracks.album_id = ? and findings.log_id is not null
          group by labels.id
          order by n desc, labels.name collate nocase asc
          limit 1`,
  });

  const row = typedRows<{ id: string; name: string; slug: string }>(result.rows)[0];

  return row
    ? {
        discogsLabelId: undefined,
        id: row.id,
        logoImageUrl: undefined,
        mbLabelId: undefined,
        name: row.name,
        slug: row.slug,
      }
    : undefined;
}

function coverJsonSelect(pick: string): string {
  return `(select json_object('u', c.album_image_url, 'k', a2.image_key,
                              's', a2.image_state, 'v', a2.image_updated_at)
             from tracks c
             left join albums a2 on a2.id = c.album_id
            where c.track_id = ${pick})`;
}

const LABEL_COVER_PICK = `(select t2.track_id
                             from tracks t2
                            where t2.label_id = labels.id and t2.album_image_url is not null
                              and t2.release_date is (select max(t3.release_date)
                                                        from tracks t3
                                                       where t3.label_id = labels.id
                                                         and t3.album_image_url is not null)
                            order by t2.track_id asc
                            limit 1)`;

export const LABEL_CATALOGUE_COVER_JSON = coverJsonSelect(LABEL_COVER_PICK);

type CoverJson = {
  k?: null | string;
  s?: null | string;
  u?: null | string;
  v?: null | string;
};

export function coverFromJson(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw === "") {
    return undefined;
  }

  let parsed: CoverJson;

  try {
    parsed = JSON.parse(raw) as CoverJson;
  } catch {
    return undefined;
  }

  return bestAlbumCoverUrl({
    imageKey: parsed.k,
    imageState: parsed.s,
    imageUpdatedAt: parsed.v,
    spotifyUrl: parsed.u,
  });
}

export async function listKnownLabelNames(): Promise<string[]> {
  const db = await getDb();
  const result = await db.execute({
    sql: `select labels.name as name
          from findings
          cross join tracks on tracks.track_id = findings.track_id
          join labels on labels.id = tracks.label_id
          where findings.log_id is not null
            and trim(labels.name) <> ''
          group by labels.id
          order by labels.name collate nocase asc`,
  });

  return typedRows<{ name: string }>(result.rows).map((row) => row.name);
}

export type EntitySitemapRow = {
  coverImageUrl: string | undefined;

  lastmod: string | undefined;
  slug: string;
};

export function labelSitemapWindowStatement(minTracks: number, limit: number, afterSlug?: string) {
  const seek = afterSlug === undefined ? "labels.slug >= ?" : "labels.slug > ?";

  return {
    args: [afterSlug ?? "", minTracks, limit],
    sql: `select labels.slug as slug,
                 (select max(f.added_at)
                    from tracks t join findings f on f.track_id = t.track_id
                    where t.label_id = labels.id) as lastmod,
                 (select t.album_image_url
                    from tracks t join findings f on f.track_id = t.track_id
                    where t.label_id = labels.id
                      and f.log_id is not null
                      and f.added_at = (select max(f2.added_at)
                        from tracks t2 join findings f2 on f2.track_id = t2.track_id
                        where t2.label_id = labels.id and f2.log_id is not null)
                    limit 1) as cover_url
          from labels
          where ${seek} and labels.renderable_track_count >= ?
          order by labels.slug asc
          limit ?`,
  };
}

export async function listLabelSitemapRows(
  minTracks: number,
  window?: { afterSlug?: string; limit: number },
): Promise<EntitySitemapRow[]> {
  const db = await getDb();
  const result = await db.execute(
    window
      ? labelSitemapWindowStatement(minTracks, window.limit, window.afterSlug)
      : {
          args: [minTracks],
          sql: `select labels.slug as slug,
                 max(findings.added_at) as lastmod,
                 (select t2.album_image_url
                    from findings f2 join tracks t2 on t2.track_id = f2.track_id
                    where t2.label_id = labels.id and f2.log_id is not null
                    order by f2.added_at desc limit 1) as cover_url
          from labels
          join tracks on tracks.label_id = labels.id
          left join findings on findings.track_id = tracks.track_id
          where labels.renderable_track_count >= ?
          group by labels.id
          order by labels.slug asc`,
        },
  );

  return typedRows<{
    cover_url: string | null;
    lastmod: string | null;
    slug: string;
  }>(result.rows).map((row) => ({
    coverImageUrl: row.cover_url ?? undefined,
    lastmod: row.lastmod ?? undefined,
    slug: row.slug,
  }));
}

export async function maxLabelSitemapLastmod(minTracks: number): Promise<string | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [minTracks],
    sql: `select max(findings.added_at) as lastmod
          from findings
          cross join tracks on tracks.track_id = findings.track_id
          cross join labels on labels.id = tracks.label_id
          where labels.renderable_track_count >= ?`,
  });

  return typedRows<{ lastmod: string | null }>(result.rows)[0]?.lastmod ?? undefined;
}

export const CATALOGUE_HUB_DEFAULT_LIMIT = 48;

export type LabelHubEntry = {
  certified: boolean;

  coverImageUrl: string | undefined;

  logoImageUrl: string | undefined;
  name: string;
  slug: string;

  trackCount: number;
};

export function hubInclusionWhere(alias: string, floor: number): string {
  if (!Number.isSafeInteger(floor) || floor < 0) {
    throw new Error(`hub floor must be a non-negative integer constant, got ${floor}`);
  }

  return hubGateSql(alias, String(floor));
}

function hubGateSql(alias: string, floor: string): string {
  return `(${alias}.certified_finding_count > 0 or ${alias}.renderable_track_count >= ${floor})`;
}

function entityGateWhere(
  query: Pick<CatalogueEntityPageQuery, "alias" | "floor" | "visibilityWhere">,
): string {
  const gate = hubInclusionWhere(query.alias, query.floor);

  return query.visibilityWhere ? `${gate} and ${query.visibilityWhere}` : gate;
}

function hubRenderableColumn(alias: string): string {
  return `${alias}.renderable_track_count`;
}

type CatalogueHubRow = {
  latest_release_date?: string | null;
  artists_json?: string | null;
  certified?: number | null;
  cover_json?: string | null;
  cover_url?: string | null;
  image_key?: string | null;
  image_state?: string | null;
  image_updated_at?: string | null;
  image_url?: string | null;
  name: string;
  slug: string;
  track_count: number;
};

export type CatalogueEntityPageQuery = {
  alias: string;
  entity: string;
  floor: number;
  hub: "albums" | "artists" | "labels";
  idExpr: string;
  nameExpr: string;
  slugExpr: string;

  visibilityWhere?: string;
};

export type CatalogueHubQuery<Entry> = CatalogueEntityPageQuery & {
  mapRow: (row: CatalogueHubRow) => Entry;

  select: string;
};

export async function countIndexableHubEntities(
  query: Pick<CatalogueHubQuery<unknown>, "alias" | "entity" | "floor" | "visibilityWhere">,
): Promise<number> {
  const db = await getDb();

  const visibility = query.visibilityWhere ? ` and ${query.visibilityWhere}` : "";
  const result = await db.execute({
    args: [query.floor],
    sql: `select count(*) as n
          from ${query.entity}
          where ${hubRenderableColumn(query.alias)} >= ?${visibility}`,
  });

  return Number(typedRows<{ n: number }>(result.rows)[0]?.n ?? 0);
}

function escapeLikePattern(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export type CatalogueHubNumberedPage<Entry> = {
  items: Entry[];
  letters?: CatalogueHubLetter[];
  page: number;
  pageCount: number;

  total: number;
};

export type CatalogueHubLetter = { letter: string; page: number };

export class CatalogueHubPageOutOfRangeError extends Error {}

export const ENTITY_HUB_ORDER_BY = "g.slug asc, g.id asc";

export type HubOrder = "az" | "most" | "recent";

function orderedHubSql(query: CatalogueEntityPageQuery, order: HubOrder): string {
  if (order === "most") {
    return `-${query.alias}.renderable_track_count asc, ${query.slugExpr} asc`;
  }
  if (order === "recent") {
    return `${query.alias}.latest_release_date desc, ${query.slugExpr} desc`;
  }
  return entityHubOrderBy(query);
}

function filteredHubSql(order: HubOrder): string {
  if (order === "most") {
    return "-g.track_count asc, g.slug asc";
  }
  if (order === "recent") {
    return "g.latest_release_date desc, g.slug desc";
  }
  return ENTITY_HUB_ORDER_BY;
}

export function entityHubOrderBy(query: Pick<CatalogueEntityPageQuery, "idExpr" | "slugExpr">) {
  return `${query.slugExpr} asc, ${query.idExpr} asc`;
}

export function entityHubSeekClause(
  query: Pick<CatalogueEntityPageQuery, "idExpr" | "slugExpr">,
  anchor: HubPageAnchor,
) {
  return {
    args: [anchor.key ?? "", anchor.key ?? "", anchor.id],
    sql: `(${query.slugExpr} >= ? and (${query.slugExpr} > ? or ${query.idExpr} > ?))`,
  };
}

function entityBoundaryColumns(query: CatalogueEntityPageQuery): string {
  return `${query.idExpr} as id, ${query.slugExpr} as slug`;
}

function catalogueEntityPageShape(
  query: CatalogueEntityPageQuery,
  pageSize: number,
  projection: string,
  order: HubOrder = "az",
): HubOrderedPageShape {
  return {
    clauses: [{ args: [], sql: entityGateWhere(query) }],
    from: query.entity,
    idExpr: query.idExpr,
    keyAlias: "slug",
    keyExpr: query.slugExpr,
    orderBy: orderedHubSql(query, order),
    pageSize,
    projection,
    seekAfter: (anchor) => entityHubSeekClause(query, anchor),
  };
}

export function catalogueEntityAnchorExtractionQuery(
  query: CatalogueEntityPageQuery,
  pageSize: number,
  order: HubOrder = "az",
) {
  return hubAnchorExtractionQuery(
    catalogueEntityPageShape(query, pageSize, entityBoundaryColumns(query), order),
  );
}

export function catalogueEntityOffsetPageQuery(
  query: CatalogueEntityPageQuery,
  pageSize: number,
  offset: number,
  projection = entityBoundaryColumns(query),
  order: HubOrder = "az",
) {
  return hubOffsetPageQuery(
    catalogueEntityPageShape(query, pageSize, projection, order),
    pageSize,
    offset,
  );
}

export function catalogueEntitySeekPageQuery(
  query: CatalogueEntityPageQuery,
  pageSize: number,
  page: number,
  anchors: HubPageAnchor[],
  projection = entityBoundaryColumns(query),
  order: HubOrder = "az",
) {
  return hubSeekPageQuery(
    catalogueEntityPageShape(query, pageSize, projection, order),
    page,
    anchors,
  );
}

export function catalogueEntityCountQuery(query: CatalogueEntityPageQuery) {
  return {
    args: [],
    sql: `select count(*) as total
          from ${query.entity}
          where ${entityGateWhere(query)}`,
  };
}

function entityAnchorAddress(
  query: CatalogueEntityPageQuery,
  pageSize: number,
  surface: "browse" | "hub",
  order: HubOrder = "az",
): { clauseHash: string; hub: string } {
  return {
    clauseHash: hubClauseHash(
      JSON.stringify({
        entity: query.entity,
        floor: query.floor,
        orderBy: order === "az" ? ENTITY_HUB_ORDER_BY : orderedHubSql(query, order),
        pageSize,

        where: hubGateSql(query.alias, "?"),

        whereVisibility: query.visibilityWhere ?? null,
      }),
    ),
    hub: `${query.hub}-${surface}`,
  };
}

async function readOneSnapshot(statements: InStatement[]): Promise<Row[][]> {
  const db = await getDb();
  const results = await db.batch(statements, "read");

  if (results.length !== statements.length) {
    throw new Error(
      `entity list snapshot returned ${results.length} results for ${statements.length} statements`,
    );
  }

  return results.map((result) => result.rows);
}

async function refreshCatalogueEntityAnchors(
  query: CatalogueEntityPageQuery,
  pageSize: number,
  surface: "browse" | "hub",
  order: HubOrder = "az",
): Promise<void> {
  const [anchorRows = [], countRows = [], firstRows = []] = await readOneSnapshot([
    catalogueEntityAnchorExtractionQuery(query, pageSize, order),
    catalogueEntityCountQuery(query),
    catalogueEntityOffsetPageQuery(query, 1, 0, entityBoundaryColumns(query), order),
  ]);
  const anchors = hubPageAnchorsFromRows(
    typedRows<Record<string, unknown>>(anchorRows),
    "slug",
    pageSize,
  );
  const total = Number(typedRows<{ total: number }>(countRows)[0]?.total ?? 0);
  const firstId = typedRows<{ id: string }>(firstRows)[0]?.id;
  const address = entityAnchorAddress(query, pageSize, surface, order);

  await persistHubPageAnchors(
    address.hub,
    address.clauseHash,
    anchors,
    hubCorpusFingerprint(total, firstId),
  );
}

function scheduleCatalogueEntityAnchorRefresh(
  query: CatalogueEntityPageQuery,
  pageSize: number,
  surface: "browse" | "hub",
  order: HubOrder = "az",
): void {
  const address = entityAnchorAddress(query, pageSize, surface, order);

  scheduleHubPageAnchorRefresh(`${address.hub}:${address.clauseHash}`, () =>
    refreshCatalogueEntityAnchors(query, pageSize, surface, order),
  );
}

export function catalogueEntityLetterCountsQuery(query: CatalogueEntityPageQuery) {
  return {
    args: [],
    sql: `select substr(${query.slugExpr}, 1, 1) as letter, count(*) as n
          from ${query.entity}
          where ${entityGateWhere(query)}
          group by substr(${query.slugExpr}, 1, 1)
          order by substr(${query.slugExpr}, 1, 1) asc`,
  };
}

function catalogueEntityTotalQuery(query: CatalogueEntityPageQuery, withLetters: boolean) {
  return withLetters ? catalogueEntityLetterCountsQuery(query) : catalogueEntityCountQuery(query);
}

function catalogueEntityTotalFromRows(
  rows: Parameters<typeof typedRows>[0],
  withLetters: boolean,
  pageSize: number,
): { letters: CatalogueHubLetter[]; total: number } {
  if (!withLetters) {
    return { letters: [], total: Number(typedRows<{ total: number }>(rows)[0]?.total ?? 0) };
  }

  const counts = typedRows<{ letter: string; n: number }>(rows).map((row) => ({
    letter: row.letter,
    n: Number(row.n),
  }));

  return {
    letters: letterPages(counts, pageSize),
    total: counts.reduce((sum, row) => sum + row.n, 0),
  };
}

function compareSlugThenId(
  left: { id: string; slug: string },
  right: { id: string; slug: string },
): number {
  return left.slug < right.slug
    ? -1
    : left.slug > right.slug
      ? 1
      : left.id < right.id
        ? -1
        : left.id > right.id
          ? 1
          : 0;
}

async function anchoredCatalogueEntityRows(
  query: CatalogueEntityPageQuery,
  page: number,
  pageSize: number,
  surface: "browse" | "hub",
  projection: string,
  withLetters = false,
  order: HubOrder = "az",
): Promise<
  { letters: CatalogueHubLetter[]; rows: Record<string, unknown>[]; total: number } | undefined
> {
  const address = entityAnchorAddress(query, pageSize, surface, order);
  const stored = await loadPersistedHubPageAnchors(address.hub, address.clauseHash);

  if (!stored) {
    scheduleCatalogueEntityAnchorRefresh(query, pageSize, surface, order);
    return undefined;
  }

  const [totalRows = [], firstRows = [], pageRows = []] = await readOneSnapshot([
    catalogueEntityTotalQuery(query, withLetters),
    catalogueEntityOffsetPageQuery(query, 1, 0, entityBoundaryColumns(query), order),
    catalogueEntitySeekPageQuery(query, pageSize, page, stored.anchors, projection, order),
  ]);
  const { letters, total } = catalogueEntityTotalFromRows(totalRows, withLetters, pageSize);
  const firstId = typedRows<{ id: string }>(firstRows)[0]?.id;
  const decision = persistedAnchorDecision(
    page,
    pageSize,
    stored,
    hubCorpusFingerprint(total, firstId),
  );
  if (decision.refresh) {
    scheduleCatalogueEntityAnchorRefresh(query, pageSize, surface, order);
  }

  return {
    letters,
    rows: typedRows<Record<string, unknown>>(pageRows),
    total,
  };
}

async function unfilteredCatalogueEntityRows(
  query: CatalogueEntityPageQuery,
  page: number,
  pageSize: number,
  surface: "browse" | "hub",
  projection: string,
  withLetters = false,
  order: HubOrder = "az",
): Promise<{ letters: CatalogueHubLetter[]; rows: Record<string, unknown>[]; total: number }> {
  if (order === "az" && !isShallowHubPage(page, pageSize)) {
    const anchored = await anchoredCatalogueEntityRows(
      query,
      page,
      pageSize,
      surface,
      projection,
      withLetters,
      order,
    );

    if (anchored) {
      return anchored;
    }
  }

  const [totalRows = [], pageRows = []] = await readOneSnapshot([
    catalogueEntityTotalQuery(query, withLetters),
    catalogueEntityOffsetPageQuery(query, pageSize, (page - 1) * pageSize, projection, order),
  ]);

  return {
    ...catalogueEntityTotalFromRows(totalRows, withLetters, pageSize),
    rows: typedRows<Record<string, unknown>>(pageRows),
  };
}

export async function listHubPage<Entry>(
  query: CatalogueHubQuery<Entry>,
  page: number,
  withLetters = false,
  nameFilter?: string,
  order: HubOrder = "az",
): Promise<CatalogueHubNumberedPage<Entry>> {
  const limit = CATALOGUE_HUB_DEFAULT_LIMIT;
  const term = typeof nameFilter === "string" ? nameFilter.trim() : "";

  if (!term) {
    const served = await unfilteredCatalogueEntityRows(
      query,
      page,
      limit,
      "hub",
      `${query.idExpr} as id, ${query.slugExpr} as slug,
       ${query.alias}.renderable_track_count as n, (${query.alias}.certified_finding_count > 0) as cert`,
      withLetters && order === "az",
      order,
    );
    const sliced = served.rows as unknown as {
      cert: number;
      id: string;
      n: number;
      slug: string;
    }[];

    return {
      items: await hubTiles(query, sliced),
      letters: served.letters,
      page,
      pageCount: Math.max(Math.ceil(served.total / limit), 1),
      total: served.total,
    };
  }

  const db = await getDb();
  const letterArm =
    withLetters && order === "az"
      ? `union all
       select 'letter' as kind, '' as id, substr(g.slug, 1, 1) as slug, count(*) as n, 0 as cert
       from gated g group by substr(g.slug, 1, 1)`
      : "";

  const result = await db.execute({
    args: [`%${escapeLikePattern(term)}%`, limit, (page - 1) * limit],
    sql: `with gated as materialized (
            select ${query.idExpr} as id, ${query.slugExpr} as slug,
                   ${query.alias}.renderable_track_count as track_count,
                   (${query.alias}.certified_finding_count > 0) as certified,
                   ${query.alias}.latest_release_date as latest_release_date
            from ${query.entity}
            where ${query.nameExpr} like ? escape '\\' and ${entityGateWhere(query)}
          )
          select 'total' as kind, '' as id, '' as slug, (select count(*) from gated) as n, 0 as cert
          union all
          select * from (
            select 'row' as kind, g.id as id, g.slug as slug, g.track_count as n,
                   g.certified as cert
            from gated g order by ${filteredHubSql(order)} limit ? offset ?
          )
          ${letterArm}`,
  });

  const rows = typedRows<{ cert: number; id: string; kind: string; n: number; slug: string }>(
    result.rows,
  );
  const total = Number(rows.find((row) => row.kind === "total")?.n ?? 0);
  const sliced = rows.filter((row) => row.kind === "row");
  const letters = letterPages(
    rows
      .filter((row) => row.kind === "letter")
      .map((row) => ({ letter: row.slug, n: Number(row.n) }))
      .sort((left, right) => (left.letter < right.letter ? -1 : 1)),
    limit,
  );

  return {
    items: await hubTiles(query, sliced),
    letters,
    page,
    pageCount: Math.max(Math.ceil(total / limit), 1),
    total,
  };
}

async function hubTiles<Entry>(
  query: CatalogueHubQuery<Entry>,
  slice: { cert: number; n: number; slug: string }[],
): Promise<Entry[]> {
  if (slice.length === 0) {
    return [];
  }

  const db = await getDb();
  const slugs = slice.map((row) => row.slug);
  const result = await db.execute({
    args: slugs,
    sql: `select ${query.slugExpr} as slug, ${query.select}
          from ${query.entity}
          where ${query.slugExpr} in (${slugs.map(() => "?").join(", ")})`,
  });

  const bySlug = new Map(typedRows<CatalogueHubRow>(result.rows).map((row) => [row.slug, row]));

  return slice.flatMap((row) => {
    const tile = bySlug.get(row.slug);

    return tile
      ? [query.mapRow({ ...tile, certified: Number(row.cert), track_count: Number(row.n) })]
      : [];
  });
}

export async function listHubThisMonth<Entry>(
  query: CatalogueHubQuery<Entry>,
  now = new Date(),
  limit = 12,
): Promise<Entry[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CATALOGUE_HUB_DEFAULT_LIMIT) {
    throw new Error("hub strip limit must be 1 through the tile page size");
  }
  const windowDay = new Date(now);
  windowDay.setUTCDate(windowDay.getUTCDate() - FRESH_WINDOW_DAYS);
  const lower = releaseWindowLowerBound(releaseTodayUtc(windowDay));
  const db = await getDb();
  const result = await db.execute({
    args: [lower, limit],
    sql: `select ${query.slugExpr} as slug,
                 ${query.alias}.renderable_track_count as n,
                 (${query.alias}.certified_finding_count > 0) as cert
          from ${query.entity}
          where ${entityGateWhere(query)}
            and ${query.alias}.latest_release_date >= ?
          order by +(-${query.alias}.renderable_track_count) asc, ${query.slugExpr} asc
          limit ?`,
  });
  return hubTiles(query, typedRows<{ cert: number; n: number; slug: string }>(result.rows));
}

export function letterPages(
  counts: { letter: string; n: number }[],
  pageSize: number,
): CatalogueHubLetter[] {
  const byLetter = new Map<string, number>();
  let rank = 0;

  for (const { letter, n } of counts) {
    const display = /^[a-z]$/.test(letter) ? letter : "#";

    if (!byLetter.has(display)) {
      byLetter.set(display, Math.floor(rank / pageSize) + 1);
    }

    rank += Number(n);
  }

  return [...byLetter].map(([letter, page]) => ({ letter, page }));
}

export type CatalogueBrowseRow = {
  certified: boolean;
  name: string;
  slug: string;

  trackCount: number;
};

export type CatalogueBrowsePage = {
  items: CatalogueBrowseRow[];
  page: number;
  pageCount: number;

  total: number;
};

export type CatalogueBrowseQuery = CatalogueEntityPageQuery;

export const CATALOGUE_BROWSE_PAGE_SIZE = 50;

export async function listCatalogueBrowsePage(
  query: CatalogueBrowseQuery,
  page: number,
): Promise<CatalogueBrowsePage> {
  const limit = CATALOGUE_BROWSE_PAGE_SIZE;
  const served = await unfilteredCatalogueEntityRows(
    query,
    page,
    limit,
    "browse",
    `${query.idExpr} as id, ${query.slugExpr} as slug, ${query.nameExpr} as name,
     ${query.alias}.renderable_track_count as track_count,
     (${query.alias}.certified_finding_count > 0) as certified`,
  );
  const items = (
    served.rows as unknown as {
      certified: number;
      id: string;
      name: string;
      slug: string;
      track_count: number;
    }[]
  )
    .sort(compareSlugThenId)
    .map((row) => ({
      certified: Number(row.certified) > 0,
      name: row.name,
      slug: row.slug,
      trackCount: Number(row.track_count),
    }));

  return {
    items,
    page,
    pageCount: Math.max(Math.ceil(served.total / limit), 1),
    total: served.total,
  };
}

export const LABELS_HUB_QUERY: CatalogueHubQuery<LabelHubEntry> = {
  alias: "labels",
  entity: "labels",
  floor: LABEL_INDEX_MIN_TRACKS,
  hub: "labels",
  idExpr: "labels.id",
  mapRow: (row) => ({
    certified: Boolean(row.certified),
    coverImageUrl: coverFromJson(row.cover_json),
    logoImageUrl: labelLogoUrl(row.image_key ?? null, row.image_updated_at ?? null),
    name: row.name,
    slug: row.slug,
    trackCount: Number(row.track_count),
  }),
  nameExpr: "labels.name",
  select: `labels.name as name, labels.image_key as image_key,
           labels.image_updated_at as image_updated_at,
           ${LABEL_CATALOGUE_COVER_JSON} as cover_json`,
  slugExpr: "labels.slug",
};

export function countIndexableLabels(): Promise<number> {
  return countIndexableHubEntities(LABELS_HUB_QUERY);
}

export function listLabelsHubPage(
  page: number,
  nameFilter?: string,
  order: HubOrder = "az",
): Promise<CatalogueHubNumberedPage<LabelHubEntry>> {
  return listHubPage(LABELS_HUB_QUERY, page, !nameFilter, nameFilter, order);
}

export function listLabelsThisMonth(now?: Date, limit?: number): Promise<LabelHubEntry[]> {
  return listHubThisMonth(LABELS_HUB_QUERY, now, limit);
}

const LABELS_BROWSE_QUERY: CatalogueBrowseQuery = {
  alias: LABELS_HUB_QUERY.alias,
  entity: LABELS_HUB_QUERY.entity,
  floor: LABELS_HUB_QUERY.floor,
  hub: LABELS_HUB_QUERY.hub,
  idExpr: LABELS_HUB_QUERY.idExpr,
  nameExpr: "labels.name",
  slugExpr: LABELS_HUB_QUERY.slugExpr,
};

export function listLabelsBrowsePage(page: number): Promise<CatalogueBrowsePage> {
  return listCatalogueBrowsePage(LABELS_BROWSE_QUERY, page);
}

export type CatalogueListPage<Entry> = {
  items: Entry[];
  page: number;
  pageCount: number;
  total: number;
};

export async function hubFindingCountsBySlug(
  query: Pick<CatalogueHubQuery<unknown>, "alias" | "entity" | "slugExpr">,
  slugs: string[],
): Promise<Map<string, number>> {
  if (slugs.length === 0) {
    return new Map();
  }

  const db = await getDb();
  const placeholders = slugs.map(() => "?").join(", ");
  const result = await db.execute({
    args: slugs,
    sql: `select ${query.slugExpr} as slug,
                 ${query.alias}.certified_finding_count as finding_count
          from ${query.entity}
          where ${query.slugExpr} in (${placeholders})`,
  });

  const map = new Map<string, number>();

  for (const row of typedRows<{ finding_count: number; slug: string }>(result.rows)) {
    map.set(row.slug, Number(row.finding_count));
  }

  return map;
}

export async function hubCountsBySlugs(
  query: Pick<CatalogueHubQuery<unknown>, "alias" | "entity" | "slugExpr">,
  slugs: string[],
): Promise<Map<string, { certified: boolean; findingCount: number; trackCount: number }>> {
  if (slugs.length === 0) {
    return new Map();
  }

  const db = await getDb();
  const placeholders = slugs.map(() => "?").join(", ");
  const result = await db.execute({
    args: slugs,
    sql: `select ${query.slugExpr} as slug,
                 ${query.alias}.certified_finding_count as finding_count,
                 ${query.alias}.renderable_track_count as track_count
          from ${query.entity}
          where ${query.slugExpr} in (${placeholders})`,
  });

  const map = new Map<string, { certified: boolean; findingCount: number; trackCount: number }>();

  for (const row of typedRows<{ finding_count: number; slug: string; track_count: number }>(
    result.rows,
  )) {
    const findingCount = Number(row.finding_count);
    map.set(row.slug, {
      certified: findingCount > 0,
      findingCount,
      trackCount: Number(row.track_count),
    });
  }

  return map;
}

export async function hubCountsBySlug(
  query: Pick<CatalogueHubQuery<unknown>, "alias" | "entity" | "slugExpr">,
  slug: string,
): Promise<{ certified: boolean; findingCount: number; trackCount: number }> {
  const db = await getDb();
  const result = await db.execute({
    args: [slug],
    sql: `select ${query.alias}.certified_finding_count as finding_count,
                 ${query.alias}.renderable_track_count as track_count
          from ${query.entity}
          where ${query.slugExpr} = ?`,
  });

  const row = typedRows<{ finding_count: number; track_count: number }>(result.rows)[0];
  const findingCount = Number(row?.finding_count ?? 0);

  return { certified: findingCount > 0, findingCount, trackCount: Number(row?.track_count ?? 0) };
}

export async function listLabelsApiPage(page: number): Promise<CatalogueListPage<LabelListItem>> {
  const hub = await listHubPage(LABELS_HUB_QUERY, page, false);
  const findingCounts = await hubFindingCountsBySlug(
    LABELS_HUB_QUERY,
    hub.items.map((item) => item.slug),
  );

  return {
    items: hub.items.map((item) => ({
      certified: item.certified,
      coverImageUrl: item.coverImageUrl,
      findingCount: findingCounts.get(item.slug) ?? 0,
      logoImageUrl: item.logoImageUrl,
      name: item.name,
      slug: item.slug,
      trackCount: item.trackCount,
    })),
    page: hub.page,
    pageCount: hub.pageCount,
    total: hub.total,
  };
}

async function labelCoverUrl(labelId: string): Promise<string | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [labelId],
    sql: `select ${LABEL_CATALOGUE_COVER_JSON} as cover_json from labels where labels.id = ? limit 1`,
  });

  return coverFromJson(typedRows<{ cover_json: string | null }>(result.rows)[0]?.cover_json);
}

export async function getLabelDetail(slug: string): Promise<LabelDetail | undefined> {
  const record = await getLabelBySlug(slug);

  if (!record) {
    return undefined;
  }

  const counts = await hubCountsBySlug(LABELS_HUB_QUERY, slug);
  const coverImageUrl = await labelCoverUrl(record.id);

  return {
    bio: record.bio,
    certified: counts.certified,
    coverImageUrl,
    discogsLabelId: record.discogsLabelId,
    findingCount: counts.findingCount,
    foundedLocation: record.foundedLocation,
    foundingDate: record.foundingDate,
    logoImageUrl: record.logoImageUrl,
    mbLabelId: record.mbLabelId,
    name: record.name,
    parentLabel: record.parentLabel,
    slug: record.slug,
    subLabels: record.subLabels && record.subLabels.length > 0 ? record.subLabels : undefined,
    trackCount: counts.trackCount,
  };
}

export const FINDING_LABEL_CENSUS_SQL = `select tracks.label as label, count(*) as n
      from findings cross join tracks on tracks.track_id = findings.track_id
      where tracks.label is not null and trim(tracks.label) <> ''
      group by tracks.label`;

export async function reconcileLabels(): Promise<number> {
  const db = await getDb();
  const result = await db.execute({ args: [], sql: FINDING_LABEL_CENSUS_SQL });

  const confirmedAliasSlugs = await confirmedAliasSlugSet();

  const bySlug = new Map<string, string>();

  for (const row of typedRows<LabelCountRow>(result.rows)) {
    const slug = labelSlug(row.label);

    if (slug && !confirmedAliasSlugs.has(slug) && !bySlug.has(slug)) {
      bySlug.set(slug, row.label.trim());
    }
  }

  let minted = 0;
  const now = new Date().toISOString();

  for (const [slug, name] of bySlug) {
    const labelId = `lbl_${randomUUID()}`;
    const [inserted] = await db.batch(
      [
        {
          args: [labelId, name, slug, now, now],
          sql: `insert into labels (id, name, slug, created_at, updated_at)
                values (?, ?, ?, ?, ?)
                on conflict (slug) do nothing`,
        },
        ...markDueWorkSourceMaintenanceStatements([{ subjectId: labelId, subjectType: "label" }], {
          onlyIfPreviousStatementChanged: true,
          producer: "label-reconcile-mint",
        }),
      ],
      "write",
    );

    minted += inserted?.rowsAffected ?? 0;
  }

  return minted;
}

export type LabelSeedItem = Omit<LabelAdminItem, "findingCount"> & {
  mbLabelId: null | string;
};

export type LabelsAdminPage = {
  items: LabelAdminItem[];
  page: number;
  pageCount: number;
  total: number;
};

function toLabelSeedItem(row: LabelRow): LabelSeedItem {
  const { findingCount: _countless, ...item } = toLabelItem(row, 0);

  return { ...item, mbLabelId: row.mb_label_id };
}

export async function listLabels(
  seedState?: LabelSeedState,
  client?: Pick<Client, "execute">,
): Promise<LabelSeedItem[]> {
  const db = client ?? (await getDb());
  const result = seedState
    ? await db.execute({
        args: [seedState],
        sql: `select ${LABEL_COLUMNS}
              from labels where seed_state = ? order by name collate nocase`,
      })
    : await db.execute({
        args: [],
        sql: `select ${LABEL_COLUMNS} from labels order by name collate nocase`,
      });

  return typedRows<LabelRow>(result.rows).map(toLabelSeedItem);
}

export async function getEnabledSeedLabel(
  slug: string,
  client?: Pick<Client, "execute">,
): Promise<LabelSeedItem | undefined> {
  const db = client ?? (await getDb());
  const result = await db.execute({
    args: [slug],
    sql: `select ${LABEL_COLUMNS}
          from labels where slug = ? and seed_state = 'enabled' limit 1`,
  });
  const row = typedRows<LabelRow>(result.rows)[0];

  return row ? toLabelSeedItem(row) : undefined;
}

const HUB_CERTIFIED = `sum(case when findings.log_id is not null then 1 else 0 end)`;

async function labelFindingCountsByIds(labelIds: string[]): Promise<Map<string, number>> {
  if (labelIds.length === 0) {
    return new Map();
  }

  const db = await getDb();
  const placeholders = labelIds.map(() => "?").join(", ");
  const result = await db.execute({
    args: labelIds,
    sql: `select tracks.label_id as label_id, ${HUB_CERTIFIED} as finding_count
          from tracks
          left join findings on findings.track_id = tracks.track_id
          where tracks.label_id in (${placeholders})
          group by tracks.label_id`,
  });

  const counts = new Map<string, number>();

  for (const row of typedRows<{ finding_count: number; label_id: string }>(result.rows)) {
    counts.set(row.label_id, Number(row.finding_count));
  }

  return counts;
}

export type LabelsAdminSection = LabelSeedState | "partial";

const LABEL_CARRIES_ARTIST_RULE = `exists (select 1 from artist_rules
                                            where artist_rules.label_id = labels.id)`;

export async function listLabelsPage(
  section: LabelsAdminSection,
  page: number,
): Promise<LabelsAdminPage> {
  const db = await getDb();
  const limit = LABELS_ADMIN_PAGE_SIZE;
  const safePage = Math.max(1, Math.floor(page));
  const offset = (safePage - 1) * limit;
  const seedState: LabelSeedState = section === "partial" ? "undecided" : section;
  const rules =
    section === "partial"
      ? ` and ${LABEL_CARRIES_ARTIST_RULE}`
      : section === "undecided"
        ? ` and not ${LABEL_CARRIES_ARTIST_RULE}`
        : "";

  const result = await db.execute({
    args: [seedState, limit, offset],
    sql: `select ${LABEL_COLUMNS}, count(*) over () as total_count
          from labels
          where seed_state = ?${rules}
          order by name collate nocase
          limit ? offset ?`,
  });

  const rows = typedRows<LabelRow & { total_count: number }>(result.rows);
  const total = Number(rows[0]?.total_count ?? 0);
  const counts = await labelFindingCountsByIds(rows.map((row) => row.id));

  return {
    items: rows.map((row) => toLabelItem(row, counts.get(row.id) ?? 0)),
    page: safePage,
    pageCount: Math.max(Math.ceil(total / limit), 1),
    total,
  };
}

export class LabelNotFoundError extends Error {}

export async function getLabelAdminItem(id: string): Promise<LabelAdminItem | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [id],
    sql: `select ${LABEL_COLUMNS} from labels where id = ? limit 1`,
  });
  const row = typedRows<LabelRow>(result.rows)[0];

  if (!row) {
    return undefined;
  }

  const counts = await labelFindingCountsByIds([row.id]);

  return toLabelItem(row, counts.get(row.id) ?? 0);
}

export async function updateLabelSeedState(
  id: string,
  seedState?: LabelSeedState,
  rewalk = false,
): Promise<LabelAdminItem> {
  const db = await getDb();
  const now = new Date().toISOString();
  const sourceVersion = `label-seed-state:${randomUUID()}`;
  const assignments: string[] = [];
  const args: string[] = [];

  if (seedState !== undefined) {
    assignments.push("seed_state = ?", "ruled_at = ?");
    args.push(seedState, now);
  }

  if (seedState === "enabled" || rewalk) {
    assignments.push("scope_changed_at = ?");
    args.push(now);
  }

  assignments.push("updated_at = ?");
  args.push(now, id);

  const statements: DueWorkStatement[] = [
    {
      args,
      sql: `update labels set ${assignments.join(", ")} where id = ?`,
    },
    ...markDueWorkSourceMaintenanceStatements(
      [
        { subjectId: id, subjectType: "label" },
        ...(seedState === undefined
          ? []
          : [
              {
                subjectId: DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
                subjectType: "track" as const,
              },
            ]),
      ],
      {
        markerVersion: sourceVersion,
        now,
        onlyIfPreviousStatementChanged: true,
        producer: "label-seed-state",
        publicProjectionImpact: {
          impact: seedState === undefined ? "neither" : "artist_qualification",
          justification:
            seedState === undefined
              ? "A bare re-walk does not write labels.seed_state."
              : "The supplied ruling writes labels.seed_state.",
        },
      },
    ),
  ];

  if (seedState !== undefined) {
    statements.push(
      restaleCatalogueRankByLabelStatement(id),
      ...markDueWorkSourceMaintenanceFromSelectStatements(
        "track",
        {
          args: [id],
          sql: `select track_id as subject_id from tracks where label_id = ?`,
        },
        {
          markerVersion: sourceVersion,
          now,
          producer: "label-seed-state",
          publicProjectionImpact: {
            impact: "artist_qualification",
            justification: "The bounded track selection belongs to a supplied seed-state ruling.",
          },
        },
      ),
    );
  }

  statements.push(
    markCrawlProjectionRepairsFromSelectStatement(
      "label",
      {
        args: [id, now],
        sql: `select slug as source_id from labels where id = ? and updated_at = ?`,
      },
      { now, sourceVersion },
    ),
  );

  await db.batch(statements, "write");

  const result = await db.execute({
    args: [id],
    sql: `select ${LABEL_COLUMNS} from labels where id = ? limit 1`,
  });
  const row = typedRows<LabelRow>(result.rows)[0];

  if (!row) {
    throw new LabelNotFoundError(`No label with id ${id}.`);
  }

  const counts = await labelFindingCountsByIds([row.id]);

  return toLabelItem(row, counts.get(row.id) ?? 0);
}

export async function fillEmptyLabelBio(
  slug: string,
  bio: string,
  promptVersion?: number | null,
  gateBypass?: readonly string[] | null,
): Promise<boolean> {
  const db = await getDb();
  const now = new Date().toISOString();
  const [bypassedAt, violations] = bioBypassColumns(gateBypass, now);
  const results = await db.batch(
    [
      ...markDueWorkSourceMaintenanceFromSelectStatements(
        "label",
        {
          args: [slug],
          sql: `select id as subject_id from labels
                where slug = ? and (bio is null or trim(bio) = '')`,
        },
        { producer: "label-bio-fill" },
      ),
      {
        args: [bio, promptVersion ?? null, bypassedAt, violations, now, slug],
        sql: `update labels
                set bio = ?, bio_prompt_version = ?, bio_status = 'resolved',
                    bio_gate_bypassed_at = ?, bio_voice_violations = ?, updated_at = ?
              where slug = ?
                and (bio is null or trim(bio) = '')`,
      },
    ],
    "write",
  );

  return (results.at(-1)?.rowsAffected ?? 0) > 0;
}

export type LabelBioWorkItem = { id: string; name: string; slug: string };

export async function listLabelsMissingBio(limit: number): Promise<LabelBioWorkItem[]> {
  const db = await getDb();

  if (await isDueWorkCutoverEnabled()) {
    const page = await readPromotedDueWorkPage(db, "label.bio", { limit });
    if (page.subjectIds.length === 0) {
      return [];
    }

    const result = await db.execute({
      args: page.subjectIds,
      sql: `select id, name, slug from labels
            where id in (${page.subjectIds.map(() => "?").join(", ")})`,
    });
    const hydratedById = new Map(
      typedRows<LabelBioWorkItem>(result.rows).map((row) => [row.id, row] as const),
    );
    return page.subjectIds.flatMap((id) => {
      const row = hydratedById.get(id);
      return row ? [row] : [];
    });
  }

  const result = await db.execute({
    args: [limit],
    sql: `select l.id, l.name, l.slug
          from labels l
          where (l.bio is null or trim(l.bio) = '')
            and ${hubInclusionWhere("l", LABEL_INDEX_MIN_TRACKS)}
          order by l.created_at asc
          limit ?`,
  });

  return typedRows<{ id: string; name: string; slug: string }>(result.rows).map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
  }));
}

export type LabelReviewRow = { anchorAt: string; labelId: string; name: string };

export const LABEL_REVIEW_QUEUE_LIMIT = 25;

export async function listLabelReviewRows(): Promise<LabelReviewRow[]> {
  const db = await getDb();
  const result = await db.execute({
    args: ["undecided", LABEL_REVIEW_QUEUE_LIMIT],
    sql: `select id, name, created_at
          from labels
          where seed_state = ?
          order by created_at asc
          limit ?`,
  });

  return typedRows<{ created_at: string; id: string; name: string }>(result.rows).map((row) => ({
    anchorAt: row.created_at,
    labelId: row.id,
    name: row.name,
  }));
}

async function confirmedAliasSlugSet(): Promise<Set<string>> {
  const db = await getDb();
  const result = await db.execute(
    `select alias_slug from label_aliases where status = 'confirmed'`,
  );

  return new Set(typedRows<{ alias_slug: string }>(result.rows).map((row) => row.alias_slug));
}

export async function getConfirmedAliasNames(labelId: string): Promise<string[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [labelId],
    sql: `select alias from label_aliases
          where label_id = ? and status = 'confirmed'
          order by alias collate nocase asc`,
  });

  return typedRows<{ alias: string }>(result.rows).map((row) => row.alias);
}

export async function listLabelAliasCandidates(): Promise<LabelAliasCandidate[]> {
  const db = await getDb();
  const result = await db.execute(
    `select la.id, la.alias, la.alias_slug, la.source, la.kind, la.created_at,
            labels.id as label_id, labels.name as label_name, labels.slug as label_slug
     from label_aliases la
     join labels on labels.id = la.label_id
     where la.status = 'candidate'
     order by la.created_at desc, la.alias collate nocase asc`,
  );

  return typedRows<{
    alias: string;
    alias_slug: string;
    created_at: string;
    id: string;
    kind: LabelAliasCandidate["kind"];
    label_id: string;
    label_name: string;
    label_slug: string;
    source: LabelAliasCandidate["source"];
  }>(result.rows).map((row) => ({
    alias: row.alias,
    aliasSlug: row.alias_slug,
    createdAt: row.created_at,
    id: row.id,
    kind: row.kind,
    labelId: row.label_id,
    labelName: row.label_name,
    labelSlug: row.label_slug,
    source: row.source,
  }));
}

export async function confirmLabelAlias(id: string): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute({
    args: [id],
    sql: `update label_aliases set status = 'confirmed' where id = ? and status <> 'confirmed'`,
  });

  return result.rowsAffected > 0;
}

export async function rejectLabelAlias(id: string): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute({
    args: [id],
    sql: `delete from label_aliases where id = ?`,
  });

  return result.rowsAffected > 0;
}

export async function resolveLabelAliasRedirect(slug: string): Promise<string | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [slug],
    sql: `select labels.slug as slug
          from label_aliases
          join labels on labels.id = label_aliases.label_id
          where label_aliases.alias_slug = ? and label_aliases.status = 'confirmed'
          limit 1`,
  });

  return typedRows<{ slug: string }>(result.rows)[0]?.slug;
}

export class LabelMergeConflictError extends Error {}

export class LabelMergeSameRowError extends Error {}

type LabelMergeRow = {
  discogs_label_id: null | number;
  founded_location: null | string;
  founding_date: null | string;
  id: string;
  image_key: null | string;
  image_state: "none" | "pending" | "resolved";
  lineage_state: "none" | "pending" | "resolved";
  mb_label_id: null | string;
  name: string;
  parent_label_id: null | string;
  ruled_at: null | string;
  scope_changed_at: null | string;
  seed_state: LabelSeedState;
  slug: string;
};

async function getLabelMergeRow(slug: string): Promise<LabelMergeRow | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [slug],
    sql: `select id, slug, name, seed_state, ruled_at, scope_changed_at, mb_label_id, discogs_label_id,
                 image_key, image_state, founding_date, founded_location, parent_label_id, lineage_state
          from labels where slug = ? limit 1`,
  });

  return typedRows<LabelMergeRow>(result.rows)[0];
}

function mergeLabelRuling(
  loser: LabelMergeRow,
  canonical: LabelMergeRow,
  losingSlug: string,
  canonicalSlug: string,
): { ruledAt: null | string; seedState: LabelSeedState } {
  if (loser.ruled_at && canonical.ruled_at && loser.seed_state !== canonical.seed_state) {
    throw new LabelMergeConflictError(
      `Both labels carry an operator ruling and they disagree: ${canonicalSlug} is ${canonical.seed_state} (ruled ${canonical.ruled_at}) and ${losingSlug} is ${loser.seed_state} (ruled ${loser.ruled_at}). Re-rule one to match, then merge.`,
    );
  }
  if (loser.ruled_at && (!canonical.ruled_at || loser.ruled_at > canonical.ruled_at)) {
    return { ruledAt: loser.ruled_at, seedState: loser.seed_state };
  }
  return { ruledAt: canonical.ruled_at, seedState: canonical.seed_state };
}

export async function mergeLabel(
  losingSlug: string,
  canonicalSlug: string,
): Promise<MergeLabelResult> {
  const db = await getDb();
  const [loser, canonical] = await Promise.all([
    getLabelMergeRow(losingSlug),
    getLabelMergeRow(canonicalSlug),
  ]);

  if (!loser) {
    throw new LabelNotFoundError(`No label with slug ${losingSlug}.`);
  }

  if (!canonical) {
    throw new LabelNotFoundError(`No label with slug ${canonicalSlug}.`);
  }

  if (loser.id === canonical.id) {
    throw new LabelMergeSameRowError(`${losingSlug} and ${canonicalSlug} are the same label.`);
  }

  const { ruledAt, seedState } = mergeLabelRuling(loser, canonical, losingSlug, canonicalSlug);

  const scopeChangedAt =
    canonical.scope_changed_at == null ||
    (loser.scope_changed_at != null && loser.scope_changed_at > canonical.scope_changed_at)
      ? loser.scope_changed_at
      : canonical.scope_changed_at;

  const reconciled: string[] = [];
  const take = <T extends number | string>(
    field: string,
    canonValue: null | T,
    loserValue: null | T,
  ): null | T => {
    if (canonValue == null && loserValue != null) {
      reconciled.push(field);

      return loserValue;
    }

    return canonValue;
  };

  const mbLabelId = take("mbLabelId", canonical.mb_label_id, loser.mb_label_id);
  const discogsLabelId = take("discogsLabelId", canonical.discogs_label_id, loser.discogs_label_id);
  const foundingDate = take("foundingDate", canonical.founding_date, loser.founding_date);
  const foundedLocation = take(
    "foundedLocation",
    canonical.founded_location,
    loser.founded_location,
  );

  const imageKey = take("imageKey", canonical.image_key, loser.image_key);
  const imageState =
    canonical.image_key != null
      ? canonical.image_state
      : loser.image_key != null
        ? loser.image_state
        : canonical.image_state;

  const canonParent = canonical.parent_label_id === loser.id ? null : canonical.parent_label_id;
  let parentLabelId: null | string = canonParent;

  if (parentLabelId == null && loser.parent_label_id != null) {
    const loserParent = loser.parent_label_id === canonical.id ? null : loser.parent_label_id;

    if (loserParent != null) {
      parentLabelId = loserParent;
      reconciled.push("parentLabelId");
    }
  }

  let lineageState = canonical.lineage_state;

  if (canonical.lineage_state === "pending" && loser.lineage_state !== "pending") {
    lineageState = loser.lineage_state;
    reconciled.push("lineageState");
  }

  const now = new Date().toISOString();
  const sourceVersion = `label-merge:${randomUUID()}`;

  const [loserCounts] = toHubCountMoveGroups(
    typedRows<HubCountCensusRow>(
      (
        await db.execute({
          args: [loser.id],
          sql: `select null as from_id, count(*) as renderable,
                       sum(case when is_catalogue = 0 then 1 else 0 end) as certified
                from tracks where label_id = ?`,
        })
      ).rows,
    ),
  );
  const canonicalCredit: HubCountDelta = {
    certified: loserCounts?.certified ?? 0,
    renderable: loserCounts?.renderable ?? 0,
  };

  const statements: Array<{ args: Array<null | number | string>; sql: string }> = [
    { args: [loser.id], sql: `delete from labels where id = ?` },

    { args: [canonical.id, loser.id], sql: `update tracks set label_id = ? where label_id = ?` },

    {
      args: [canonical.id, now, loser.id, canonical.id],
      sql: `update labels set parent_label_id = ?, updated_at = ? where parent_label_id = ? and id <> ?`,
    },

    {
      args: [canonical.id, loser.id],
      sql: `update or ignore label_aliases set label_id = ? where label_id = ?`,
    },

    { args: [loser.id], sql: `delete from label_aliases where label_id = ?` },

    {
      args: [
        mbLabelId,
        discogsLabelId,
        imageKey,
        imageState,
        foundingDate,
        foundedLocation,
        parentLabelId,
        lineageState,
        seedState,
        ruledAt,
        scopeChangedAt,
        now,
        canonical.id,
      ],
      sql: `update labels
              set mb_label_id = ?, discogs_label_id = ?, image_key = ?, image_state = ?,
                  founding_date = ?, founded_location = ?, parent_label_id = ?, lineage_state = ?,
                  seed_state = ?, ruled_at = ?, scope_changed_at = ?, updated_at = ?
            where id = ?`,
    },

    {
      args: [`lba_${randomUUID()}`, canonical.id, loser.name, loser.slug, now],
      sql: `insert into label_aliases (id, label_id, alias, alias_slug, source, kind, status, created_at)
            values (?, ?, ?, ?, 'operator', 'name', 'confirmed', ?)
            on conflict (label_id, alias_slug, source) do nothing`,
    },

    hubCountDeltaStatement("labels", canonical.id, canonicalCredit),

    { args: [loser.id], sql: `delete from artist_rules where label_id = ?` },

    {
      args: [loser.id, loser.slug],
      sql: `delete from due_work where subject_type = 'label' and subject_id in (?, ?)`,
    },
  ];

  const trackMaintenance = markDueWorkSourceMaintenanceFromSelectStatements(
    "track",
    {
      args: [loser.id],
      sql: `select track_id as subject_id from tracks where label_id = ?`,
    },
    { markerVersion: sourceVersion, now, producer: "label-merge" },
  );
  const crawlRuleMaintenance = markCrawlProjectionRepairsFromSelectStatement(
    "artist",
    {
      args: [loser.id],
      sql: `select distinct artist_mbid as source_id from artist_rules where label_id = ?`,
    },
    { now, sourceVersion },
  );
  const results = await db.batch(
    [
      ...trackMaintenance,
      crawlRuleMaintenance,
      ...statements,
      ...markDueWorkSourceMaintenanceStatements(
        [
          { subjectId: canonical.id, subjectType: "label" },
          { subjectId: loser.id, subjectType: "label" },
        ],
        { markerVersion: sourceVersion, now, producer: "label-merge" },
      ),
      markCrawlProjectionRepairStatement("label", canonical.slug, {
        now,
        sourceVersion,
      }),
      markCrawlProjectionRepairStatement("label", loser.slug, {
        now,
        sourceVersion,
      }),
    ],
    "write",
  );
  const sourceResults = results.slice(
    trackMaintenance.length + 1,
    trackMaintenance.length + 1 + statements.length,
  );

  return {
    aliasWritten: { alias: loser.name, aliasSlug: loser.slug },
    canonicalName: canonical.name,
    canonicalSlug: canonical.slug,
    droppedRules: sourceResults[8]?.rowsAffected ?? 0,
    losingName: loser.name,
    losingSlug: loser.slug,
    reconciled,
    repointed: {
      aliases: sourceResults[3]?.rowsAffected ?? 0,
      childLabels: sourceResults[2]?.rowsAffected ?? 0,
      tracks: sourceResults[1]?.rowsAffected ?? 0,
    },
    seedState,
  };
}
