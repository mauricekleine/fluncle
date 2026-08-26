import { type Client, type InStatement, type InValue, type ResultSet } from "@libsql/client";
import { createHash } from "node:crypto";

export const CRAWL_DUE_LIVE_GENERATION = "live";
export const CRAWL_REARM_TAIL_CURSOR = -1;
export const CRAWL_STALE_ARTIST_REARM_LIMIT = 10;
export const MAX_CRAWL_DUE_CHUNK_SIZE = 500;

const MAX_FAILURES = 5;
const RETRY_BASE_MS = 15 * 60 * 1000;
const RETRY_MAX_MS = 24 * 60 * 60 * 1000;
const STALE_ALLOWED_ARTIST_MS = 24 * 60 * 60 * 1000;

export type CrawlDueClient = Pick<Client, "batch" | "execute">;
export type CrawlDueStatement = Exclude<InStatement, string>;
export type CrawlDueState = "leased" | "ready" | "repair" | "scheduled";
export type CrawlDueNodeKind = "artist" | "label" | "release";

export type CrawlDueProjection = {
  createdAt: string;
  demandRank: number;
  generation?: string;
  hop: number;
  labelSlug: null | string;
  nextDueAt: null | string;
  nodeId: string;
  nodeKind: CrawlDueNodeKind;
  parentId: null | string;
  sourceVersion: string;
  state: "ready" | "scheduled";
  storableRank: null | number;
};

export type CrawlDueRow = Omit<CrawlDueProjection, "generation" | "state"> & {
  claimExpiresAt: null | string;
  claimPosition: null | number;
  claimToken: null | string;
  claimedBy: null | string;
  generation: string;
  state: CrawlDueState;
  updatedAt: string;
};

export type CrawlDueClaim = {
  artistsRearmed: number;
  claimExpiresAt: string;
  claimToken: string;
  hasMore: boolean;
  items: CrawlDueRow[];
  promoted: number;
  reaped: number;
};

export type CrawlDueDriftAudit = {
  matched: boolean;
  projectedCount: number;
  projectedDigest: string;
  repairNodeIds: string[];
  sourceCount: number;
  sourceDigest: string;
};

export type CrawlDueRebuildCheckpoint = {
  completedAt: null | string;
  cursor: null | string;
  generation: string;
  projectedCount: number;
  projectedDigest: null | string;
  scannedCount: number;
  sourceDigest: null | string;
  startedAt: string;
  state: "complete" | "running";
  updatedAt: string;
};

type CrawlSourceSqlRow = {
  attempted_at: null | string;
  created_at: string;
  demand_rank: number;
  done_at: null | string;
  external_id: string;
  failures: number;
  hop: number;
  id: string;
  kind: string;
  label_enabled: number;
  label_slug: null | string;
  outstanding_allow: number;
  parent_allowed: number;
  parent_id: null | string;
  self_allowed: number;
  source: string;
  state: string;
  updated_at: string;
};

type CrawlDueSqlRow = {
  claim_expires_at: null | string;
  claim_position: null | number;
  claim_token: null | string;
  claimed_by: null | string;
  created_at: string;
  demand_rank: number;
  generation: string;
  hop: number;
  label_slug: null | string;
  next_due_at: null | string;
  node_id: string;
  node_kind: string;
  parent_id: null | string;
  source_version: string;
  state: string;
  storable_rank: null | number;
  updated_at: string;
};

type CrawlRepairMarker = {
  createdAt: string;
  sourceEpoch: number;
  sourceId: string;
  sourceType: "artist" | "label";
  sourceVersion: string;
  updatedAt: string;
};

const CRAWL_DUE_COLUMNS = `claim_expires_at, claim_position, claim_token, claimed_by,
  created_at, demand_rank, generation, hop, label_slug, next_due_at, node_id, node_kind,
  parent_id, source_version, state, storable_rank, updated_at`;

const CRAWL_SOURCE_COLUMNS = `cf.attempted_at, cf.created_at, cf.demand_rank, cf.done_at,
  cf.external_id, cf.failures, cf.hop, cf.id, cf.kind, cf.label_slug, cf.parent_id,
  cf.source, cf.state, cf.updated_at,
  case when provenance_label.seed_state = 'enabled' then 1 else 0 end as label_enabled,
  exists (
    select 1 from artist_rules parent_rule
    where cf.parent_id = 'musicbrainz:artist:' || parent_rule.artist_mbid
      and parent_rule.verdict = 'allow'
  ) as parent_allowed,
  exists (
    select 1 from artist_rules self_rule
    where self_rule.artist_mbid = cf.external_id and self_rule.verdict = 'allow'
  ) as self_allowed,
  exists (
    select 1 from artist_rules outstanding_rule
    where outstanding_rule.artist_mbid = cf.external_id
      and outstanding_rule.verdict = 'allow' and outstanding_rule.rearmed_at is null
  ) as outstanding_allow`;

function assertNonEmpty(value: string, name: string): void {
  if (!value.trim()) {
    throw new Error(`${name} must not be empty`);
  }
}

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CRAWL_DUE_CHUNK_SIZE) {
    throw new Error(
      `crawl due-work limit must be an integer from 1 through ${MAX_CRAWL_DUE_CHUNK_SIZE}`,
    );
  }
}

function iso(value: Date | string, name: string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`${name} must be a valid timestamp`);
  }
  return date.toISOString();
}

function nowIso(now: (() => Date) | undefined): string {
  return (now ?? (() => new Date()))().toISOString();
}

function digestValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function addMs(value: string, milliseconds: number): string | undefined {
  const stamp = new Date(value).getTime();
  return Number.isFinite(stamp) ? new Date(stamp + milliseconds).toISOString() : undefined;
}

function crawlSourceVersion(row: CrawlSourceSqlRow): string {
  return digestValue([
    row.id,
    row.kind,
    row.source,
    row.external_id,
    row.state,
    Number(row.failures),
    row.attempted_at,
    row.done_at,
    Number(row.hop),
    Number(row.demand_rank),
    row.created_at,
    row.updated_at,
    row.label_slug,
    row.parent_id,
    Number(row.label_enabled),
    Number(row.parent_allowed),
    Number(row.self_allowed),
    Number(row.outstanding_allow),
  ]);
}

function projectCrawlSource(row: CrawlSourceSqlRow): CrawlDueProjection | null {
  if (row.kind !== "artist" && row.kind !== "label" && row.kind !== "release") {
    throw new Error(`invalid crawl frontier kind: ${row.kind}`);
  }

  let nextDueAt: null | string = null;
  let state: "ready" | "scheduled";

  if (row.state === "pending") {
    state = "ready";
  } else if (row.state === "failed" && Number(row.failures) < MAX_FAILURES) {
    if (row.attempted_at === null) {
      return null;
    }
    const retryAt = addMs(
      row.attempted_at,
      Math.min(RETRY_BASE_MS * 2 ** Number(row.failures), RETRY_MAX_MS),
    );
    if (retryAt === undefined) {
      return null;
    }
    state = "scheduled";
    nextDueAt = retryAt;
  } else if (
    row.state === "done" &&
    row.kind === "artist" &&
    row.source === "musicbrainz" &&
    row.done_at !== null &&
    Number(row.self_allowed) === 1 &&
    Number(row.outstanding_allow) === 0
  ) {
    const staleAt = addMs(row.done_at, STALE_ALLOWED_ARTIST_MS);
    if (staleAt === undefined) {
      return null;
    }
    state = "scheduled";
    nextDueAt = staleAt;
  } else {
    return null;
  }

  return {
    createdAt: row.created_at,
    demandRank: Number(row.demand_rank),
    hop: Number(row.hop),
    labelSlug: row.label_slug,
    nextDueAt,
    nodeId: row.id,
    nodeKind: row.kind,
    parentId: row.parent_id,
    sourceVersion: crawlSourceVersion(row),
    state,
    storableRank:
      row.kind === "release"
        ? Number(row.label_enabled) === 1 || Number(row.parent_allowed) === 1
          ? 0
          : 1
        : null,
  };
}

function crawlDueRow(row: CrawlDueSqlRow): CrawlDueRow {
  if (row.node_kind !== "artist" && row.node_kind !== "label" && row.node_kind !== "release") {
    throw new Error(`invalid crawl due-work kind: ${row.node_kind}`);
  }
  if (
    row.state !== "leased" &&
    row.state !== "ready" &&
    row.state !== "repair" &&
    row.state !== "scheduled"
  ) {
    throw new Error(`invalid crawl due-work state: ${row.state}`);
  }

  return {
    claimExpiresAt: row.claim_expires_at,
    claimPosition: row.claim_position === null ? null : Number(row.claim_position),
    claimToken: row.claim_token,
    claimedBy: row.claimed_by,
    createdAt: row.created_at,
    demandRank: Number(row.demand_rank),
    generation: row.generation,
    hop: Number(row.hop),
    labelSlug: row.label_slug,
    nextDueAt: row.next_due_at,
    nodeId: row.node_id,
    nodeKind: row.node_kind,
    parentId: row.parent_id,
    sourceVersion: row.source_version,
    state: row.state,
    storableRank: row.storable_rank === null ? null : Number(row.storable_rank),
    updatedAt: row.updated_at,
  };
}

function crawlDueRows(result: ResultSet): CrawlDueRow[] {
  return (result.rows as unknown as CrawlDueSqlRow[]).map(crawlDueRow);
}

function projectionArgs(
  projection: CrawlDueProjection,
  generation: string,
  updatedAt: string,
): (null | number | string)[] {
  return [
    projection.nodeId,
    projection.nodeKind,
    projection.state,
    projection.hop,
    projection.demandRank,
    projection.createdAt,
    projection.storableRank,
    projection.nextDueAt,
    projection.labelSlug,
    projection.parentId,
    generation,
    projection.sourceVersion,
    updatedAt,
  ];
}

export function upsertCrawlDueProjectionStatement(
  projection: CrawlDueProjection,
  options: { generation?: string; now?: Date | string } = {},
): CrawlDueStatement {
  const updatedAt = iso(options.now ?? new Date(), "crawl due-work update time");
  const generation = options.generation ?? projection.generation ?? CRAWL_DUE_LIVE_GENERATION;
  assertNonEmpty(projection.nodeId, "crawl node id");
  assertNonEmpty(projection.sourceVersion, "crawl source version");

  return {
    args: projectionArgs(projection, generation, updatedAt),
    sql: `insert into crawl_due_work
      (node_id, node_kind, state, hop, demand_rank, created_at, storable_rank, next_due_at,
       label_slug, parent_id, generation, source_version, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(node_id) do update set
        node_kind = excluded.node_kind,
        state = excluded.state,
        hop = excluded.hop,
        demand_rank = excluded.demand_rank,
        created_at = excluded.created_at,
        storable_rank = excluded.storable_rank,
        next_due_at = excluded.next_due_at,
        label_slug = excluded.label_slug,
        parent_id = excluded.parent_id,
        generation = excluded.generation,
        source_version = excluded.source_version,
        claim_expires_at = null,
        claim_position = null,
        claim_token = null,
        claimed_by = null,
        updated_at = excluded.updated_at`,
  };
}

export function markCrawlProjectionRepairStatement(
  sourceType: "artist" | "label",
  sourceId: string,
  options: {
    now?: Date | string;
    onlyIfPreviousStatementChanged?: boolean;
    sourceEpoch?: number;
    sourceVersion: string;
  },
): CrawlDueStatement {
  assertNonEmpty(sourceId, "crawl repair source id");
  assertNonEmpty(options.sourceVersion, "crawl repair source version");
  const sourceEpoch = options.sourceEpoch ?? 1;
  if (!Number.isSafeInteger(sourceEpoch) || sourceEpoch < 0) {
    throw new Error("crawl repair source epoch must be a non-negative integer");
  }
  const updatedAt = iso(options.now ?? new Date(), "crawl repair update time");
  const condition = options.onlyIfPreviousStatementChanged === true ? "where changes() > 0" : "";

  return {
    args: [sourceType, sourceId, sourceEpoch, options.sourceVersion, updatedAt, updatedAt],
    sql: `insert into crawl_projection_repairs
      (source_type, source_id, source_epoch, source_version, created_at, updated_at)
      select ?, ?, ?, ?, ?, ? ${condition}
      on conflict(source_type, source_id) do update set
        source_epoch = max(crawl_projection_repairs.source_epoch + 1, excluded.source_epoch),
        source_version = excluded.source_version,
        updated_at = excluded.updated_at`,
  };
}

/** Mark the bounded source identities returned as `source_id` without enumerating statements. */
export function markCrawlProjectionRepairsFromSelectStatement(
  sourceType: "artist" | "label",
  selection: { args?: InValue[]; sql: string },
  options: {
    now?: Date | string;
    onlyIfPreviousStatementChanged?: boolean;
    sourceVersion: string;
  },
): CrawlDueStatement {
  assertNonEmpty(selection.sql, "crawl repair source selection");
  assertNonEmpty(options.sourceVersion, "crawl repair source version");
  const updatedAt = iso(options.now ?? new Date(), "crawl repair update time");
  const condition = options.onlyIfPreviousStatementChanged === true ? "and changes() > 0" : "";
  return {
    args: [...(selection.args ?? []), sourceType, options.sourceVersion, updatedAt, updatedAt],
    sql: `with source as (${selection.sql})
      insert into crawl_projection_repairs
        (source_type, source_id, source_epoch, source_version, created_at, updated_at)
      select distinct ?, source.source_id, 1, ?, ?, ? from source
      where source.source_id is not null and trim(source.source_id) <> '' ${condition}
      on conflict(source_type, source_id) do update set
        source_epoch = crawl_projection_repairs.source_epoch + 1,
        source_version = excluded.source_version,
        updated_at = excluded.updated_at`,
  };
}

/** Mark one frontier node from a source write without having to precompute its projection facts. */
export function markCrawlNodeRepairStatement(
  nodeId: string,
  sourceVersion: string,
  options: {
    now?: Date | string;
    onlyIfPreviousStatementChanged?: boolean;
    projectionMarker?: {
      sourceEpoch: number;
      sourceId: string;
      sourceType: "artist" | "label";
      sourceVersion: string;
    };
  } = {},
): CrawlDueStatement {
  assertNonEmpty(nodeId, "crawl node id");
  assertNonEmpty(sourceVersion, "crawl repair source version");
  const updatedAt = iso(options.now ?? new Date(), "crawl repair update time");
  const condition = options.onlyIfPreviousStatementChanged === true ? "and changes() > 0" : "";
  const markerCondition =
    options.projectionMarker === undefined
      ? ""
      : `and exists (
          select 1 from crawl_projection_repairs
          where source_type = ?6 and source_id = ?7 and source_epoch = ?8 and source_version = ?9
        )`;

  return {
    args: [
      sourceVersion,
      updatedAt,
      nodeId,
      nodeId,
      nodeId,
      ...(options.projectionMarker === undefined
        ? []
        : [
            options.projectionMarker.sourceType,
            options.projectionMarker.sourceId,
            options.projectionMarker.sourceEpoch,
            options.projectionMarker.sourceVersion,
          ]),
    ],
    sql: `insert into crawl_due_work
      (node_id, node_kind, state, hop, demand_rank, created_at, storable_rank, next_due_at,
       label_slug, parent_id, generation, source_version, updated_at)
      select id, kind, 'repair', hop, demand_rank, created_at,
             case when kind = 'release' then 1 else null end,
             null, label_slug, parent_id, '${CRAWL_DUE_LIVE_GENERATION}', ?1, ?2
      from crawl_frontier where id = ?3 ${condition} ${markerCondition}
      union all
      select node_id, node_kind, 'repair', hop, demand_rank, created_at, storable_rank,
             null, label_slug, parent_id, '${CRAWL_DUE_LIVE_GENERATION}', ?1, ?2
      from crawl_due_work
      where node_id = ?4 and not exists (select 1 from crawl_frontier where id = ?5)
        ${condition} ${markerCondition}
      on conflict(node_id) do update set
        state = 'repair', next_due_at = null, generation = '${CRAWL_DUE_LIVE_GENERATION}',
        source_version = excluded.source_version, claim_expires_at = null,
        claim_position = null, claim_token = null, claimed_by = null,
        updated_at = excluded.updated_at`,
  };
}

/**
 * Mark the exact bounded id set whose source rows received one transaction timestamp. Primary-key
 * probes plus the timestamp guard avoid a post-commit frontier scan and exclude a raced no-op row.
 */
export function markCrawlNodeRepairsByUpdatedAtStatement(
  nodeIds: readonly string[],
  sourceVersion: string,
  updatedAt: Date | string,
): CrawlDueStatement {
  if (nodeIds.length === 0 || nodeIds.length > MAX_CRAWL_DUE_CHUNK_SIZE) {
    throw new Error(
      `crawl repair id batches must contain 1 through ${MAX_CRAWL_DUE_CHUNK_SIZE} nodes`,
    );
  }
  assertNonEmpty(sourceVersion, "crawl repair source version");
  const uniqueIds = [...new Set(nodeIds)];
  for (const nodeId of uniqueIds) {
    assertNonEmpty(nodeId, "crawl node id");
  }
  const now = iso(updatedAt, "crawl repair update time");
  const placeholders = uniqueIds.map(() => "?").join(", ");
  return {
    args: [sourceVersion, now, ...uniqueIds, now],
    sql: `insert into crawl_due_work
      (node_id, node_kind, state, hop, demand_rank, created_at, storable_rank, next_due_at,
       label_slug, parent_id, generation, source_version, updated_at)
      select id, kind, 'repair', hop, demand_rank, created_at,
             case when kind = 'release' then 1 else null end,
             null, label_slug, parent_id, '${CRAWL_DUE_LIVE_GENERATION}', ?1, ?2
      from crawl_frontier
      where id in (${placeholders}) and updated_at = ?${uniqueIds.length + 3}
      on conflict(node_id) do update set
        state = 'repair', next_due_at = null, generation = '${CRAWL_DUE_LIVE_GENERATION}',
        source_version = excluded.source_version, claim_expires_at = null,
        claim_position = null, claim_token = null, claimed_by = null,
        updated_at = excluded.updated_at`,
  };
}

async function readCrawlSourceChunk(
  client: CrawlDueClient,
  options: { after?: string; limit: number },
): Promise<CrawlSourceSqlRow[]> {
  const result = await client.execute({
    args: [options.after ?? "", options.limit],
    sql: `select ${CRAWL_SOURCE_COLUMNS}
      from crawl_frontier cf
      left join labels provenance_label on provenance_label.slug = cf.label_slug
      where cf.id > ?
      order by cf.id
      limit ?`,
  });
  return result.rows as unknown as CrawlSourceSqlRow[];
}

async function readCrawlSourceNode(
  client: CrawlDueClient,
  nodeId: string,
): Promise<CrawlSourceSqlRow | undefined> {
  const result = await client.execute({
    args: [nodeId],
    sql: `select ${CRAWL_SOURCE_COLUMNS}
      from crawl_frontier cf
      left join labels provenance_label on provenance_label.slug = cf.label_slug
      where cf.id = ? limit 1`,
  });
  return result.rows[0] as unknown as CrawlSourceSqlRow | undefined;
}

/** Re-evaluate one physical marker from authoritative frontier, label, and artist-rule state. */
export async function repairCrawlDueNode(
  client: CrawlDueClient,
  nodeId: string,
  options: { now?: () => Date } = {},
): Promise<boolean> {
  const markerResult = await client.execute({
    args: [nodeId],
    sql: `select ${CRAWL_DUE_COLUMNS} from crawl_due_work
      where node_id = ? and state = 'repair' limit 1`,
  });
  const markerRow = markerResult.rows[0] as unknown as CrawlDueSqlRow | undefined;
  if (markerRow === undefined) {
    return false;
  }
  const marker = crawlDueRow(markerRow);
  const source = await readCrawlSourceNode(client, nodeId);
  const projection = source === undefined ? null : projectCrawlSource(source);
  const updatedAt = nowIso(options.now);
  const statement: CrawlDueStatement =
    projection === null
      ? {
          args: [nodeId, marker.sourceVersion],
          sql: `delete from crawl_due_work
            where node_id = ? and state = 'repair' and source_version = ?`,
        }
      : {
          args: [
            ...projectionArgs(projection, CRAWL_DUE_LIVE_GENERATION, updatedAt),
            marker.sourceVersion,
          ],
          sql: `insert into crawl_due_work
            (node_id, node_kind, state, hop, demand_rank, created_at, storable_rank, next_due_at,
             label_slug, parent_id, generation, source_version, updated_at)
            select ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            where exists (
              select 1 from crawl_due_work
              where node_id = ?1 and state = 'repair' and source_version = ?14
            )
            on conflict(node_id) do update set
              node_kind = excluded.node_kind, state = excluded.state, hop = excluded.hop,
              demand_rank = excluded.demand_rank, created_at = excluded.created_at,
              storable_rank = excluded.storable_rank, next_due_at = excluded.next_due_at,
              label_slug = excluded.label_slug, parent_id = excluded.parent_id,
              generation = excluded.generation, source_version = excluded.source_version,
              claim_expires_at = null, claim_position = null, claim_token = null,
              claimed_by = null, updated_at = excluded.updated_at`,
        };
  const result = await client.execute(statement);
  return result.rowsAffected > 0;
}

export async function repairCrawlDueNodes(
  client: CrawlDueClient,
  options: { limit?: number; now?: () => Date } = {},
): Promise<{ hasMore: boolean; repaired: number; scanned: number }> {
  const limit = options.limit ?? 100;
  assertLimit(limit);
  if ((await firstCrawlRepairMarker(client)) !== undefined) {
    return { hasMore: true, repaired: 0, scanned: 0 };
  }
  const result = await client.execute({
    args: [limit + 1],
    sql: `select node_id from crawl_due_work indexed by crawl_due_work_repair_idx
      where state = 'repair' order by node_id limit ?`,
  });
  const ids = (result.rows as unknown as { node_id: string }[]).map((row) => row.node_id);
  let repaired = 0;
  for (const nodeId of ids.slice(0, limit)) {
    repaired += (await repairCrawlDueNode(client, nodeId, options)) ? 1 : 0;
  }
  return { hasMore: ids.length > limit, repaired, scanned: Math.min(ids.length, limit) };
}

async function firstCrawlRepairMarker(
  client: CrawlDueClient,
): Promise<CrawlRepairMarker | undefined> {
  const result = await client.execute(`select source_type, source_id, source_epoch, source_version,
      created_at, updated_at
    from crawl_projection_repairs indexed by crawl_projection_repairs_order_idx
    order by source_epoch, source_type, source_id limit 1`);
  const row = result.rows[0] as
    | {
        created_at: string;
        source_epoch: number;
        source_id: string;
        source_type: string;
        source_version: string;
        updated_at: string;
      }
    | undefined;
  if (row === undefined) {
    return undefined;
  }
  if (row.source_type !== "artist" && row.source_type !== "label") {
    throw new Error(`invalid crawl repair source type: ${row.source_type}`);
  }
  return {
    createdAt: row.created_at,
    sourceEpoch: Number(row.source_epoch),
    sourceId: row.source_id,
    sourceType: row.source_type,
    sourceVersion: row.source_version,
    updatedAt: row.updated_at,
  };
}

/**
 * Expand one source marker into a bounded physical repair page. Rows already marked `repair` are
 * the durable cursor: they remain excluded until the source marker is cleared, then the direct
 * repair pass consumes them. No unbounded source walk or extra cursor column is needed.
 */
export async function fanOutCrawlProjectionRepairs(
  client: CrawlDueClient,
  options: { limit?: number } = {},
): Promise<{ complete: boolean; expanded: number; marker?: CrawlRepairMarker }> {
  const limit = options.limit ?? 100;
  assertLimit(limit);
  const marker = await firstCrawlRepairMarker(client);
  if (marker === undefined) {
    return { complete: true, expanded: 0 };
  }

  const targetArtistNode = `musicbrainz:artist:${marker.sourceId}`;
  const selected =
    marker.sourceType === "label"
      ? await client.execute({
          args: [marker.sourceId, limit],
          sql: `select node_id from crawl_due_work indexed by crawl_due_work_label_slug_node_id_idx
            where label_slug = ? and state <> 'repair' limit ?`,
        })
      : await client.execute({
          args: [targetArtistNode, targetArtistNode, limit],
          sql: `select node_id from crawl_due_work
            where node_id = ? and state <> 'repair'
            union all
            select node_id from crawl_due_work indexed by crawl_due_work_parent_id_node_id_idx
            where parent_id = ? and state <> 'repair' and node_id <> ?1
            limit ?`,
        });
  const ids = [
    ...new Set((selected.rows as unknown as { node_id: string }[]).map((row) => row.node_id)),
  ].slice(0, limit);
  const writes: CrawlDueStatement[] = ids.map((nodeId) => ({
    args: [
      marker.sourceVersion,
      marker.updatedAt,
      nodeId,
      marker.sourceType,
      marker.sourceId,
      marker.sourceEpoch,
      marker.sourceVersion,
    ],
    sql: `update crawl_due_work
      set state = 'repair', next_due_at = null, claim_expires_at = null,
          claim_position = null, claim_token = null, claimed_by = null,
          generation = '${CRAWL_DUE_LIVE_GENERATION}', source_version = ?, updated_at = ?
      where node_id = ? and exists (
        select 1 from crawl_projection_repairs
        where source_type = ? and source_id = ? and source_epoch = ? and source_version = ?
      )`,
  }));

  if (marker.sourceType === "artist") {
    writes.push(
      markCrawlNodeRepairStatement(targetArtistNode, marker.sourceVersion, {
        now: marker.updatedAt,
        projectionMarker: marker,
      }),
    );
  }

  const noRemaining =
    marker.sourceType === "label"
      ? `not exists (
          select 1 from crawl_due_work indexed by crawl_due_work_label_slug_node_id_idx
          where label_slug = ?5 and state <> 'repair'
        )`
      : `not exists (
          select 1 from crawl_due_work where node_id = ?8 and state <> 'repair'
        ) and not exists (
          select 1 from crawl_due_work indexed by crawl_due_work_parent_id_node_id_idx
          where parent_id = ?8 and state <> 'repair'
        )`;
  writes.push({
    args:
      marker.sourceType === "label"
        ? [
            marker.sourceType,
            marker.sourceId,
            marker.sourceEpoch,
            marker.sourceVersion,
            marker.sourceId,
          ]
        : [
            marker.sourceType,
            marker.sourceId,
            marker.sourceEpoch,
            marker.sourceVersion,
            "",
            "",
            "",
            targetArtistNode,
          ],
    sql: `delete from crawl_projection_repairs
      where source_type = ?1 and source_id = ?2 and source_epoch = ?3 and source_version = ?4
        and ${noRemaining}`,
  });
  const results = await client.batch(writes, "write");
  const cleared = (results.at(-1)?.rowsAffected ?? 0) > 0;
  return { complete: cleared, expanded: ids.length, marker };
}

export function crawlReleaseReadyQuery(limit: number): CrawlDueStatement {
  assertLimit(limit);
  return {
    args: [limit],
    sql: `select ${CRAWL_DUE_COLUMNS}
      from crawl_due_work indexed by crawl_due_work_release_ready_idx
      where state = 'ready' and node_kind = 'release'
      order by storable_rank, hop, demand_rank, created_at, node_id
      limit ?`,
  };
}

export function crawlGeneralReadyQuery(
  limit: number,
  excludedNodeIds: readonly string[] = [],
): CrawlDueStatement {
  assertLimit(limit);
  if (excludedNodeIds.length > MAX_CRAWL_DUE_CHUNK_SIZE) {
    throw new Error(`crawl exclusion page may contain at most ${MAX_CRAWL_DUE_CHUNK_SIZE} ids`);
  }
  const exclusion =
    excludedNodeIds.length === 0
      ? ""
      : ` and node_id not in (${excludedNodeIds.map(() => "?").join(", ")})`;
  return {
    args: [...excludedNodeIds, limit],
    sql: `select ${CRAWL_DUE_COLUMNS}
      from crawl_due_work indexed by crawl_due_work_ready_idx
      where state = 'ready'${exclusion}
      order by hop, demand_rank, created_at, node_id
      limit ?`,
  };
}

/** Promote a bounded due-time page and perform the stale allowed-artist tail re-arm atomically. */
export type CrawlDuePromotion = {
  artistsRearmed: number;
  promoted: number;
};

export async function promoteCrawlDueWork(
  client: CrawlDueClient,
  options: { limit?: number; now?: () => Date } = {},
): Promise<CrawlDuePromotion> {
  const limit = options.limit ?? 100;
  assertLimit(limit);
  const now = nowIso(options.now);
  const staleSelection = `select due.node_id
    from crawl_due_work as due indexed by crawl_due_work_scheduled_idx
    join crawl_frontier as source on source.id = due.node_id
    where due.state = 'scheduled' and due.next_due_at <= ?
      and source.state = 'done' and source.kind = 'artist' and source.source = 'musicbrainz'
    order by due.next_due_at, due.node_id limit ?`;
  const results = await client.batch(
    [
      {
        args: [CRAWL_REARM_TAIL_CURSOR, now, now, CRAWL_STALE_ARTIST_REARM_LIMIT],
        sql: `update crawl_frontier
          set state = 'pending', cursor = ?, updated_at = ?
          where id in (${staleSelection}) and state = 'done'`,
      },
      {
        args: [now, now, CRAWL_STALE_ARTIST_REARM_LIMIT],
        sql: `update crawl_due_work
          set state = 'ready', next_due_at = null, updated_at = ?
          where node_id in (
            select due.node_id
            from crawl_due_work as due indexed by crawl_due_work_scheduled_idx
            join crawl_frontier as source on source.id = due.node_id
            where due.state = 'scheduled' and due.next_due_at <= ?
              and source.state = 'pending' and source.kind = 'artist'
              and source.source = 'musicbrainz' and source.cursor = ${CRAWL_REARM_TAIL_CURSOR}
              and source.updated_at = ?1
            order by due.next_due_at, due.node_id limit ?
          )`,
      },
      {
        args: [now, now, limit],
        sql: `update crawl_due_work
          set state = 'ready', next_due_at = null, updated_at = ?
          where node_id in (
            select due.node_id
            from crawl_due_work as due indexed by crawl_due_work_scheduled_idx
            join crawl_frontier as source on source.id = due.node_id
            where due.state = 'scheduled' and due.next_due_at <= ? and source.state = 'failed'
            order by due.next_due_at, due.node_id limit ?
          )`,
      },
    ],
    "write",
  );
  return {
    artistsRearmed: results[0]?.rowsAffected ?? 0,
    promoted: (results[1]?.rowsAffected ?? 0) + (results[2]?.rowsAffected ?? 0),
  };
}

export async function reapExpiredCrawlDueLeases(
  client: CrawlDueClient,
  options: { limit?: number; now?: () => Date } = {},
): Promise<number> {
  const limit = options.limit ?? 100;
  assertLimit(limit);
  const now = nowIso(options.now);
  const result = await client.execute({
    args: [now, now, limit],
    sql: `update crawl_due_work
      set state = 'ready', claim_expires_at = null, claim_position = null,
          claim_token = null, claimed_by = null, updated_at = ?
      where node_id in (
        select node_id from crawl_due_work indexed by crawl_due_work_lease_idx
        where state = 'leased' and claim_expires_at <= ?
        order by claim_expires_at, node_id limit ?
      )`,
  });
  return result.rowsAffected;
}

export function crawlClaimStatement(options: {
  claimExpiresAt: string;
  claimedBy: string;
  claimToken: string;
  limit: number;
  now: string;
}): CrawlDueStatement {
  const releaseShare = Math.ceil(options.limit / 2);
  return {
    args: [
      releaseShare,
      options.limit,
      options.claimToken,
      options.claimExpiresAt,
      options.claimedBy,
      options.now,
      options.claimedBy,
      options.claimToken,
    ],
    sql: `with release_ordered as materialized (
        select node_id, storable_rank, hop, demand_rank, created_at
        from crawl_due_work indexed by crawl_due_work_release_ready_idx
        where state = 'ready' and node_kind = 'release'
        order by storable_rank, hop, demand_rank, created_at, node_id
        limit ?1
      ),
      release_lane as materialized (
        select current.node_id,
               (select count(*) from release_ordered previous
                where previous.storable_rank < current.storable_rank
                   or (previous.storable_rank = current.storable_rank
                     and previous.hop < current.hop)
                   or (previous.storable_rank = current.storable_rank
                     and previous.hop = current.hop
                     and previous.demand_rank < current.demand_rank)
                   or (previous.storable_rank = current.storable_rank
                     and previous.hop = current.hop
                     and previous.demand_rank = current.demand_rank
                     and previous.created_at < current.created_at)
                   or (previous.storable_rank = current.storable_rank
                     and previous.hop = current.hop
                     and previous.demand_rank = current.demand_rank
                     and previous.created_at = current.created_at
                     and previous.node_id < current.node_id)) as position
        from release_ordered current
      ),
      general_ordered as materialized (
        select node_id, hop, demand_rank, created_at
        from crawl_due_work indexed by crawl_due_work_ready_idx
        where state = 'ready'
          and not exists (select 1 from release_lane where release_lane.node_id = crawl_due_work.node_id)
        order by hop, demand_rank, created_at, node_id
        limit (?2 - (select count(*) from release_lane))
      ),
      candidates as materialized (
        select node_id, position from release_lane
        union all
        select current.node_id,
               (select count(*) from release_lane)
                 + (select count(*) from general_ordered previous
                    where previous.hop < current.hop
                       or (previous.hop = current.hop
                         and previous.demand_rank < current.demand_rank)
                       or (previous.hop = current.hop
                         and previous.demand_rank = current.demand_rank
                         and previous.created_at < current.created_at)
                       or (previous.hop = current.hop
                         and previous.demand_rank = current.demand_rank
                         and previous.created_at = current.created_at
                         and previous.node_id < current.node_id)) as position
        from general_ordered current
      )
      update crawl_due_work
      set state = 'leased', next_due_at = null, claim_token = ?3, claim_expires_at = ?4,
          claimed_by = ?5,
          claim_position = (select position from candidates where candidates.node_id = crawl_due_work.node_id),
          updated_at = ?6
      where node_id in (select node_id from candidates)
        and not exists (
          select 1 from crawl_due_work existing_claim
          where existing_claim.state = 'leased' and existing_claim.claimed_by = ?7
            and existing_claim.claim_token = ?8
        )`,
  };
}

export async function claimCrawlDueWork(
  client: CrawlDueClient,
  options: {
    claimedBy: string;
    leaseMs: number;
    limit?: number;
    maintenanceLimit?: number;
    now?: () => Date;
    token?: string;
  },
): Promise<CrawlDueClaim> {
  const limit = options.limit ?? 10;
  const maintenanceLimit = options.maintenanceLimit ?? MAX_CRAWL_DUE_CHUNK_SIZE;
  assertLimit(limit);
  assertLimit(maintenanceLimit);
  assertNonEmpty(options.claimedBy, "crawl claim owner");
  if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs < 1) {
    throw new Error("crawl lease must be a positive integer number of milliseconds");
  }
  const now = nowIso(options.now);
  const claimExpiresAt = new Date(new Date(now).getTime() + options.leaseMs).toISOString();
  const claimToken = options.token ?? crypto.randomUUID();
  assertNonEmpty(claimToken, "crawl claim token");

  const promotion = await promoteCrawlDueWork(client, {
    limit: maintenanceLimit,
    now: () => new Date(now),
  });
  const reaped = await reapExpiredCrawlDueLeases(client, {
    limit: maintenanceLimit,
    now: () => new Date(now),
  });
  const results = await client.batch(
    [
      crawlClaimStatement({
        claimExpiresAt,
        claimToken,
        claimedBy: options.claimedBy,
        limit,
        now,
      }),
      {
        args: [options.claimedBy, claimToken],
        sql: `select ${CRAWL_DUE_COLUMNS}
          from crawl_due_work indexed by crawl_due_work_claim_position_idx
          where state = 'leased' and claimed_by = ? and claim_token = ?
          order by claim_position`,
      },
      {
        args: [],
        sql: `select node_id from crawl_due_work indexed by crawl_due_work_ready_idx
          where state = 'ready' order by hop, demand_rank, created_at, node_id limit 1`,
      },
    ],
    "write",
  );
  const items = results[1] === undefined ? [] : crawlDueRows(results[1]);
  return {
    artistsRearmed: promotion.artistsRearmed,
    claimExpiresAt: items[0]?.claimExpiresAt ?? claimExpiresAt,
    claimToken,
    hasMore: (results[2]?.rows.length ?? 0) > 0,
    items,
    promoted: promotion.promoted,
    reaped,
  };
}

export async function completeCrawlDueClaim(
  client: CrawlDueClient,
  nodeId: string,
  claimToken: string,
): Promise<boolean> {
  const result = await client.execute({
    args: [nodeId, claimToken],
    sql: `delete from crawl_due_work
      where node_id = ? and state = 'leased' and claim_token = ?`,
  });
  return result.rowsAffected > 0;
}

export async function readProjectedCrawlSelection(
  client: CrawlDueClient,
  options: { limit: number; now?: () => Date },
): Promise<string[]> {
  assertLimit(options.limit);
  await promoteCrawlDueWork(client, { limit: MAX_CRAWL_DUE_CHUNK_SIZE, now: options.now });
  const releaseLimit = Math.ceil(options.limit / 2);
  const releases = crawlDueRows(await client.execute(crawlReleaseReadyQuery(releaseLimit)));
  const remaining = options.limit - releases.length;
  const rest =
    remaining === 0
      ? []
      : crawlDueRows(
          await client.execute(
            crawlGeneralReadyQuery(
              remaining,
              releases.map((row) => row.nodeId),
            ),
          ),
        );
  return [...releases, ...rest].map((row) => row.nodeId);
}

/** The legacy source-table answer, retained only for shadow comparison before cutover. */
export async function readLegacyCrawlSelection(
  client: CrawlDueClient,
  options: { limit: number; now?: () => Date },
): Promise<string[]> {
  assertLimit(options.limit);
  const now = nowIso(options.now);
  const cutoffs = [1, 2, 3, 4].map((failures) =>
    new Date(
      new Date(now).getTime() - Math.min(RETRY_BASE_MS * 2 ** failures, RETRY_MAX_MS),
    ).toISOString(),
  );
  const staleCutoff = new Date(new Date(now).getTime() - STALE_ALLOWED_ARTIST_MS).toISOString();
  const eligible = `(cf.state = 'pending'
      or (cf.state = 'failed' and cf.failures < ?
        and cf.attempted_at <= case cf.failures when 1 then ? when 2 then ? when 3 then ? else ? end)
      or (cf.state = 'done' and cf.kind = 'artist' and cf.source = 'musicbrainz'
        and cf.done_at is not null and cf.done_at <= ?
        and exists (select 1 from artist_rules ar
          where ar.artist_mbid = cf.external_id and ar.verdict = 'allow')
        and not exists (select 1 from artist_rules ar
          where ar.artist_mbid = cf.external_id and ar.verdict = 'allow' and ar.rearmed_at is null)
      ))`;
  const releaseLimit = Math.ceil(options.limit / 2);
  const sharedArgs = [MAX_FAILURES, ...cutoffs, staleCutoff];
  const releaseResult = await client.execute({
    args: [...sharedArgs, releaseLimit],
    sql: `select cf.id
      from crawl_frontier cf
      left join labels l on l.slug = cf.label_slug
      where cf.kind = 'release' and ${eligible}
      order by case
          when l.seed_state = 'enabled' then 0
          when exists (select 1 from artist_rules ar
            where cf.parent_id = 'musicbrainz:artist:' || ar.artist_mbid and ar.verdict = 'allow') then 0
          else 1 end,
        cf.hop, cf.demand_rank, cf.created_at, cf.id
      limit ?`,
  });
  const releaseIds = (releaseResult.rows as unknown as { id: string }[]).map((row) => row.id);
  const remaining = options.limit - releaseIds.length;
  if (remaining === 0) {
    return releaseIds;
  }
  const exclusion =
    releaseIds.length === 0 ? "" : ` and cf.id not in (${releaseIds.map(() => "?").join(", ")})`;
  const general = await client.execute({
    args: [...sharedArgs, ...releaseIds, remaining],
    sql: `select cf.id from crawl_frontier cf
      where ${eligible}${exclusion}
      order by cf.hop, cf.demand_rank, cf.created_at, cf.id limit ?`,
  });
  return [...releaseIds, ...(general.rows as unknown as { id: string }[]).map((row) => row.id)];
}

export async function shadowCrawlDueWork(
  client: CrawlDueClient,
  options: { limit: number; now?: () => Date },
): Promise<{
  legacyIds: string[];
  matched: boolean;
  missingIds: string[];
  orderMismatch: boolean;
  projectedIds: string[];
  unexpectedIds: string[];
}> {
  const legacyIds = await readLegacyCrawlSelection(client, options);
  const projectedIds = await readProjectedCrawlSelection(client, options);
  const legacySet = new Set(legacyIds);
  const projectedSet = new Set(projectedIds);
  const missingIds = legacyIds.filter((id) => !projectedSet.has(id));
  const unexpectedIds = projectedIds.filter((id) => !legacySet.has(id));
  const orderMismatch =
    missingIds.length === 0 &&
    unexpectedIds.length === 0 &&
    legacyIds.some((id, index) => projectedIds[index] !== id);
  return {
    legacyIds,
    matched: missingIds.length === 0 && unexpectedIds.length === 0 && !orderMismatch,
    missingIds,
    orderMismatch,
    projectedIds,
    unexpectedIds,
  };
}

function rebuildRow(row: Record<string, unknown>): CrawlDueRebuildCheckpoint {
  const state = row["state"];
  if (state !== "running" && state !== "complete") {
    throw new Error(`invalid crawl rebuild state: ${String(state)}`);
  }
  return {
    completedAt: (row["completed_at"] as null | string) ?? null,
    cursor: (row["cursor"] as null | string) ?? null,
    generation: String(row["generation"]),
    projectedCount: Number(row["projected_count"]),
    projectedDigest: (row["projected_digest"] as null | string) ?? null,
    scannedCount: Number(row["scanned_count"]),
    sourceDigest: (row["source_digest"] as null | string) ?? null,
    startedAt: String(row["started_at"]),
    state,
    updatedAt: String(row["updated_at"]),
  };
}

export async function readCrawlDueRebuild(
  client: CrawlDueClient,
): Promise<CrawlDueRebuildCheckpoint | undefined> {
  const result = await client.execute(
    `select completed_at, cursor, generation, projected_count, projected_digest,
       scanned_count, source_digest, started_at, state, updated_at
     from crawl_due_work_rebuilds where scope = 'frontier'`,
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row === undefined ? undefined : rebuildRow(row);
}

export async function startCrawlDueRebuild(
  client: CrawlDueClient,
  options: { generation?: string; newGeneration?: boolean; now?: () => Date } = {},
): Promise<CrawlDueRebuildCheckpoint> {
  const now = nowIso(options.now);
  const generation = options.generation ?? crypto.randomUUID();
  if (generation === CRAWL_DUE_LIVE_GENERATION) {
    throw new Error("crawl rebuild generation 'live' is reserved for transactional repair");
  }
  const results = await client.batch(
    [
      {
        args: [generation, now, now, options.newGeneration === true ? 1 : 0],
        sql: `insert into crawl_due_work_rebuilds
          (scope, generation, cursor, scanned_count, projected_count, state,
           started_at, updated_at, completed_at, source_digest, projected_digest)
          values ('frontier', ?, null, 0, 0, 'running', ?, ?, null, null, null)
          on conflict(scope) do update set
            generation = excluded.generation, cursor = null, scanned_count = 0,
            projected_count = 0, state = 'running', started_at = excluded.started_at,
            updated_at = excluded.updated_at, completed_at = null,
            source_digest = null, projected_digest = null
          where ? = 1`,
      },
      {
        args: [],
        sql: `select completed_at, cursor, generation, projected_count, projected_digest,
           scanned_count, source_digest, started_at, state, updated_at
         from crawl_due_work_rebuilds where scope = 'frontier'`,
      },
    ],
    "write",
  );
  const row = results[1]?.rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) {
    throw new Error("crawl due-work rebuild checkpoint was not created");
  }
  return rebuildRow(row);
}

function canonicalCrawlProjection(row: CrawlDueProjection | CrawlDueRow): unknown[] {
  return [
    row.nodeId,
    row.nodeKind,
    row.state === "leased" ? "ready" : row.state,
    row.hop,
    row.demandRank,
    row.createdAt,
    row.storableRank,
    row.nextDueAt,
    row.labelSlug,
    row.parentId,
    row.sourceVersion,
  ];
}

function crawlProjectionEqual(expected: CrawlDueProjection, actual: CrawlDueRow): boolean {
  return (
    JSON.stringify(canonicalCrawlProjection(expected)) ===
    JSON.stringify(canonicalCrawlProjection(actual))
  );
}

async function* expectedCrawlProjections(
  client: CrawlDueClient,
): AsyncGenerator<CrawlDueProjection> {
  let after = "";
  while (true) {
    const rows = await readCrawlSourceChunk(client, {
      after,
      limit: MAX_CRAWL_DUE_CHUNK_SIZE,
    });
    if (rows.length === 0) {
      return;
    }
    for (const row of rows) {
      const projection = projectCrawlSource(row);
      if (projection !== null) {
        yield projection;
      }
    }
    const terminal = rows.at(-1)?.id;
    if (terminal === undefined || rows.length < MAX_CRAWL_DUE_CHUNK_SIZE) {
      return;
    }
    after = terminal;
  }
}

async function* actualCrawlProjections(client: CrawlDueClient): AsyncGenerator<CrawlDueRow> {
  let after = "";
  while (true) {
    const result = await client.execute({
      args: [after, MAX_CRAWL_DUE_CHUNK_SIZE],
      sql: `select ${CRAWL_DUE_COLUMNS} from crawl_due_work
        where node_id > ? order by node_id limit ?`,
    });
    const rows = crawlDueRows(result);
    if (rows.length === 0) {
      return;
    }
    for (const row of rows) {
      yield row;
    }
    const terminal = rows.at(-1)?.nodeId;
    if (terminal === undefined || rows.length < MAX_CRAWL_DUE_CHUNK_SIZE) {
      return;
    }
    after = terminal;
  }
}

async function nextValue<T>(iterator: AsyncIterator<T>): Promise<T | undefined> {
  const result = await iterator.next();
  return result.done ? undefined : result.value;
}

export async function auditCrawlDueWork(
  client: CrawlDueClient,
  options: { repairLimit?: number; sourceVersion?: string } = {},
): Promise<CrawlDueDriftAudit> {
  const repairLimit = options.repairLimit ?? 0;
  if (
    !Number.isSafeInteger(repairLimit) ||
    repairLimit < 0 ||
    repairLimit > MAX_CRAWL_DUE_CHUNK_SIZE
  ) {
    throw new Error(`crawl audit repair limit must be from 0 through ${MAX_CRAWL_DUE_CHUNK_SIZE}`);
  }
  const sourceHash = createHash("sha256");
  const projectedHash = createHash("sha256");
  const expected = expectedCrawlProjections(client)[Symbol.asyncIterator]();
  const actual = actualCrawlProjections(client)[Symbol.asyncIterator]();
  let left = await nextValue(expected);
  let right = await nextValue(actual);
  let sourceCount = 0;
  let projectedCount = 0;
  const repairNodeIds: string[] = [];

  while (left !== undefined || right !== undefined) {
    if (right === undefined || (left !== undefined && left.nodeId < right.nodeId)) {
      const expectedRow = left;
      if (expectedRow === undefined) {
        throw new Error("crawl audit lost its expected row");
      }
      sourceHash.update(`${JSON.stringify(canonicalCrawlProjection(expectedRow))}\n`);
      sourceCount += 1;
      if (repairNodeIds.length < repairLimit) {
        repairNodeIds.push(expectedRow.nodeId);
      }
      left = await nextValue(expected);
      continue;
    }
    if (left === undefined || right.nodeId < left.nodeId) {
      projectedHash.update(`${JSON.stringify(canonicalCrawlProjection(right))}\n`);
      projectedCount += 1;
      if (repairNodeIds.length < repairLimit) {
        repairNodeIds.push(right.nodeId);
      }
      right = await nextValue(actual);
      continue;
    }

    sourceHash.update(`${JSON.stringify(canonicalCrawlProjection(left))}\n`);
    projectedHash.update(`${JSON.stringify(canonicalCrawlProjection(right))}\n`);
    sourceCount += 1;
    projectedCount += 1;
    if (!crawlProjectionEqual(left, right) && repairNodeIds.length < repairLimit) {
      repairNodeIds.push(left.nodeId);
    }
    left = await nextValue(expected);
    right = await nextValue(actual);
  }

  if (repairNodeIds.length > 0) {
    const sourceVersion = options.sourceVersion ?? `audit:${crypto.randomUUID()}`;
    const updatedAt = new Date().toISOString();
    await client.batch(
      repairNodeIds.map((nodeId) =>
        markCrawlNodeRepairStatement(nodeId, sourceVersion, { now: updatedAt }),
      ),
      "write",
    );
  }
  const sourceDigest = sourceHash.digest("hex");
  const projectedDigest = projectedHash.digest("hex");
  return {
    matched: sourceDigest === projectedDigest && sourceCount === projectedCount,
    projectedCount,
    projectedDigest,
    repairNodeIds,
    sourceCount,
    sourceDigest,
  };
}

export async function runCrawlDueRebuildChunk(
  client: CrawlDueClient,
  options: {
    generation?: string;
    limit?: number;
    newGeneration?: boolean;
    now?: () => Date;
  } = {},
): Promise<{
  checkpoint: CrawlDueRebuildCheckpoint;
  complete: boolean;
  projected: number;
  scanned: number;
}> {
  const limit = options.limit ?? 100;
  assertLimit(limit);
  const checkpoint = await startCrawlDueRebuild(client, options);
  if (checkpoint.state === "complete") {
    return { checkpoint, complete: true, projected: 0, scanned: 0 };
  }
  const rows = await readCrawlSourceChunk(client, { after: checkpoint.cursor ?? "", limit });
  const projections = rows.flatMap((row) => {
    const projection = projectCrawlSource(row);
    return projection === null ? [] : [projection];
  });
  const updatedAt = nowIso(options.now);
  const nextCursor = rows.at(-1)?.id ?? checkpoint.cursor;
  const guardArgs = [checkpoint.generation, checkpoint.cursor];
  const guard = `scope = 'frontier' and generation = ? and state = 'running' and cursor is ?`;
  const writes: CrawlDueStatement[] = projections.map((projection) => ({
    args: [
      ...projectionArgs(projection, checkpoint.generation, updatedAt),
      ...guardArgs,
      checkpoint.startedAt,
    ],
    sql: `insert into crawl_due_work
      (node_id, node_kind, state, hop, demand_rank, created_at, storable_rank, next_due_at,
       label_slug, parent_id, generation, source_version, updated_at)
      select ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      where exists (select 1 from crawl_due_work_rebuilds where ${guard})
      on conflict(node_id) do update set
        node_kind = excluded.node_kind, state = excluded.state, hop = excluded.hop,
        demand_rank = excluded.demand_rank, created_at = excluded.created_at,
        storable_rank = excluded.storable_rank, next_due_at = excluded.next_due_at,
        label_slug = excluded.label_slug, parent_id = excluded.parent_id,
        generation = excluded.generation, source_version = excluded.source_version,
        claim_expires_at = null, claim_position = null, claim_token = null,
        claimed_by = null, updated_at = excluded.updated_at
      where crawl_due_work.state <> 'repair'
        and (crawl_due_work.generation <> '${CRAWL_DUE_LIVE_GENERATION}'
          or crawl_due_work.updated_at < ?)`,
  }));
  writes.push({
    args: [nextCursor, rows.length, projections.length, updatedAt, ...guardArgs],
    sql: `update crawl_due_work_rebuilds
      set cursor = ?, scanned_count = scanned_count + ?,
          projected_count = projected_count + ?, updated_at = ?
      where ${guard}`,
  });
  await client.batch(writes, "write");

  if (rows.length < limit) {
    await client.execute({
      args: [checkpoint.generation, checkpoint.startedAt],
      sql: `delete from crawl_due_work
        where generation <> ? and state <> 'repair'
          and (generation <> '${CRAWL_DUE_LIVE_GENERATION}' or updated_at < ?)`,
    });
    const audit = await auditCrawlDueWork(client);
    await client.execute({
      args: [
        updatedAt,
        updatedAt,
        audit.sourceDigest,
        audit.projectedDigest,
        audit.projectedCount,
        checkpoint.generation,
      ],
      sql: `update crawl_due_work_rebuilds
        set state = 'complete', completed_at = ?, updated_at = ?, source_digest = ?,
            projected_digest = ?, projected_count = ?
        where scope = 'frontier' and generation = ? and state = 'running'`,
    });
  }
  const current = await readCrawlDueRebuild(client);
  if (current === undefined) {
    throw new Error("crawl due-work rebuild checkpoint disappeared");
  }
  return {
    checkpoint: current,
    complete: current.state === "complete",
    projected: projections.length,
    scanned: rows.length,
  };
}

export async function rebuildCrawlDueWork(
  client: CrawlDueClient,
  options: {
    generation?: string;
    limit?: number;
    maxChunks?: number;
    newGeneration?: boolean;
    now?: () => Date;
  } = {},
): Promise<CrawlDueRebuildCheckpoint> {
  const maxChunks = options.maxChunks ?? 10_000;
  if (!Number.isSafeInteger(maxChunks) || maxChunks < 1) {
    throw new Error("crawl rebuild maxChunks must be a positive integer");
  }
  for (let chunk = 0; chunk < maxChunks; chunk += 1) {
    const result = await runCrawlDueRebuildChunk(client, {
      ...options,
      newGeneration: chunk === 0 ? options.newGeneration : false,
    });
    if (result.complete) {
      return result.checkpoint;
    }
  }
  throw new Error(`crawl due-work rebuild exceeded its ${maxChunks}-chunk safety bound`);
}
