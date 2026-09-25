import { type Client } from "@libsql/client";

import {
  type HubAnchorLeaf,
  type HubPageAnchor,
  type HubProjectedPageStart,
  hubLeafPageStart,
  nearestHubPageAnchor,
  parseHubAnchorLeafMeta,
} from "./hub-page-anchors";
import { getSetting } from "./settings";
import { upcomingAfterTodaySql } from "./release-day";

export const PUBLIC_PROJECTION_CUTOVER_ENABLED_KEY = "public_projection_cutover_enabled";

export const PUBLIC_ANCHOR_FORMAT_VERSION = 1;

export const PUBLIC_ANCHOR_ORDER_CHANGE_PREFIX = "projection_public_anchor_order_change_v1:";

export const PUBLIC_ANCHOR_ORDER_CHANGE_EPOCH_WIDTH = 12;

export function publicAnchorOrderChangeKey(epoch: number): string {
  return `${PUBLIC_ANCHOR_ORDER_CHANGE_PREFIX}${String(epoch).padStart(
    PUBLIC_ANCHOR_ORDER_CHANGE_EPOCH_WIDTH,
    "0",
  )}`;
}

export type PublicAnchorOrderChange = {
  epoch: number;

  from: null | string;
  id: string;

  kind: "delete" | "insert" | "move" | "noop" | "unknown";

  to: null | string;
};

export function parsePublicAnchorOrderChange(value: unknown): PublicAnchorOrderChange | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    const epoch = record["epoch"];
    const from = record["from"];
    const id = record["id"];
    const kind = record["kind"];
    const to = record["to"];
    if (
      record["v"] !== 1 ||
      typeof epoch !== "number" ||
      !Number.isSafeInteger(epoch) ||
      epoch < 0 ||
      typeof id !== "string" ||
      id.length === 0 ||
      (from !== null && typeof from !== "string") ||
      (to !== null && typeof to !== "string") ||
      (kind !== "delete" &&
        kind !== "insert" &&
        kind !== "move" &&
        kind !== "noop" &&
        kind !== "unknown")
    ) {
      return undefined;
    }
    return { epoch, from, id, kind, to };
  } catch {
    return undefined;
  }
}

export type PublicProjectionReadClient = Pick<Client, "execute">;

export type PublicProjectionAnchorAddress = {
  clauseHash: string;
  hub: string;
};

export type ProjectedAggregateBucket = {
  bucket: string;
  count: number;
};

export type ProjectedTrackHubAnchors = {
  anchors: HubPageAnchor[];
  total: number;
};

export async function isPublicProjectionCutoverEnabled(): Promise<boolean> {
  try {
    return (await getSetting(PUBLIC_PROJECTION_CUTOVER_ENABLED_KEY)) === "true";
  } catch {
    return false;
  }
}

export async function isPublicProjectionCutoverEnabledFor(
  client: PublicProjectionReadClient,
): Promise<boolean> {
  try {
    const result = await client.execute({
      args: [PUBLIC_PROJECTION_CUTOVER_ENABLED_KEY],
      sql: `select value from settings where key = ? limit 1`,
    });
    return result.rows[0]?.value === "true";
  } catch {
    return false;
  }
}

function nonNegativeInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

export function parseAnchorDocument(value: unknown): HubPageAnchor[] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return undefined;
    }

    const anchors: HubPageAnchor[] = [];
    const ids = new Set<string>();
    for (const candidate of parsed) {
      if (typeof candidate !== "object" || candidate === null) {
        return undefined;
      }
      const record = candidate as Record<string, unknown>;
      const id = record["id"];
      const key = record["key"];
      const page = Number(record["page"]);
      if (
        typeof id !== "string" ||
        id.length === 0 ||
        ids.has(id) ||
        (key !== null && typeof key !== "string") ||
        !Number.isSafeInteger(page) ||
        page < 2
      ) {
        return undefined;
      }
      ids.add(id);
      anchors.push({ id, key, page });
    }
    return anchors;
  } catch {
    return undefined;
  }
}

export function completeAnchorDocument(
  anchors: readonly HubPageAnchor[],
  pageSize: number,
  total: number,
): boolean {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    return false;
  }
  const expected = Math.floor(total / pageSize);
  return (
    anchors.length === expected &&
    new Set(anchors.map((anchor) => anchor.id)).size === anchors.length &&
    anchors.every((anchor, index) => anchor.page === index + 2)
  );
}

const AGGREGATE_READY = `aggregate.state = 'complete'
  and aggregate.aggregate_epoch = aggregate.source_epoch
  and not exists (
    select 1 from projection_repairs indexed by projection_repairs_order_idx
    where projection = 'public_aggregates'
  )`;

const ARTIST_READY = `artist_state.state = 'complete'
  and artist_state.projection_epoch = artist_state.source_epoch
  and not exists (
    select 1 from projection_repairs indexed by projection_repairs_order_idx
    where projection = 'artist_qualification'
  )`;

export async function readProjectedDefaultTrackTotal(
  client: PublicProjectionReadClient,
): Promise<number | undefined> {
  if (!(await isPublicProjectionCutoverEnabledFor(client))) {
    return undefined;
  }

  try {
    const result = await client.execute(`select aggregate.default_track_total as total
      from public_aggregate_state as aggregate
      where aggregate.scope = 'tracks' and ${AGGREGATE_READY}
      limit 1`);
    return nonNegativeInteger(result.rows[0]?.total);
  } catch {
    return undefined;
  }
}

export async function readProjectedAggregateBuckets(
  client: PublicProjectionReadClient,
  kind: "key" | "release_date_bucket",
  today?: string,
): Promise<ProjectedAggregateBucket[] | undefined> {
  if (!(await isPublicProjectionCutoverEnabledFor(client))) {
    return undefined;
  }

  try {
    const order = kind === "release_date_bucket" ? "desc" : "asc";
    const futureAdjustment =
      kind === "release_date_bucket" && today !== undefined
        ? ` - (select count(*) from tracks indexed by tracks_release_date_track_id_idx
            where ${upcomingAfterTodaySql("tracks.release_date")}
              and tracks.release_date >= counts.bucket
              and tracks.release_date < counts.bucket || '~')`
        : "";
    const result = await client.execute({
      args: today !== undefined && kind === "release_date_bucket" ? [today, kind] : [kind],
      sql: `select counts.bucket, counts.track_count${futureAdjustment} as track_count
        from public_aggregate_state as aggregate
        left join public_aggregate_counts as counts
          on counts.aggregate_kind = ?
        where aggregate.scope = 'tracks' and ${AGGREGATE_READY}
        order by counts.bucket ${order}`,
    });
    if (result.rows.length === 0) {
      return undefined;
    }
    const buckets: ProjectedAggregateBucket[] = [];
    for (const row of result.rows) {
      if (row.bucket === null) {
        continue;
      }
      const count = nonNegativeInteger(row.track_count);
      if (typeof row.bucket !== "string" || count === undefined) {
        return undefined;
      }
      buckets.push({ bucket: row.bucket, count });
    }
    return buckets;
  } catch {
    return undefined;
  }
}

export async function readQualifiedArtistIds(
  client: PublicProjectionReadClient,
  legacyQualifiedArtistsSql: string,
): Promise<string[]> {
  if (await isPublicProjectionCutoverEnabledFor(client)) {
    try {
      const result = await client.execute(`select qualification.artist_id
        from artist_qualification_state as artist_state
        left join artist_qualification as qualification
          indexed by artist_qualification_qualified_idx
          on qualification.is_qualified = 1
        where artist_state.scope = 'artists' and ${ARTIST_READY}
        order by qualification.artist_id`);
      if (result.rows.length > 0) {
        const artistIds: string[] = [];
        for (const row of result.rows) {
          if (row.artist_id === null) {
            continue;
          }
          if (typeof row.artist_id !== "string") {
            throw new Error("malformed projected artist id");
          }
          artistIds.push(row.artist_id);
        }
        return artistIds;
      }
    } catch {}
  }

  const legacy = await client.execute(
    `select artist_id from (${legacyQualifiedArtistsSql}) order by artist_id`,
  );
  return legacy.rows.flatMap((row) => (typeof row.artist_id === "string" ? [row.artist_id] : []));
}

export const ANCHOR_LEAF_META_VALID_SQL = `coalesce(case when json_valid(shard.fingerprint) then
  (json_type(shard.fingerprint) = 'object'
    and json_extract(shard.fingerprint, '$.v') = 1
    and json_type(shard.fingerprint, '$.n') = 'integer'
    and json_type(shard.fingerprint, '$.nn') = 'integer'
    and json_type(shard.fingerprint, '$.base') = 'integer'
    and json_type(shard.fingerprint, '$.after') in ('null', 'object')) end, 0)`;

export const ANCHOR_LEAF_ROWS_SQL = `case when ${ANCHOR_LEAF_META_VALID_SQL}
  then json_extract(shard.fingerprint, '$.n') end`;

export const ANCHOR_LEAF_SUMMARY_SQL = `json_object(
  'leaves', count(*),
  'valid', coalesce(sum(case when ${ANCHOR_LEAF_META_VALID_SQL} then 1 else 0 end), 0),
  'covered', coalesce(sum(${ANCHOR_LEAF_ROWS_SQL}), 0))`;

export const ANCHOR_SHARD_RANGE_SQL = `shard.hub = validity.hub
  and shard.clause_hash >= validity.clause_hash || ':' || validity.generation || ':'
  and shard.clause_hash < validity.clause_hash || ':' || validity.generation || ':\uffff'`;

export type ProjectedAnchorDocumentHead = {
  covered: number;
  generation: string;

  leaves: number;
  total: number;

  valid: number;
};

export function isLeafAnchorDocument(head: ProjectedAnchorDocumentHead): boolean {
  return head.leaves > 0 && head.valid === head.leaves;
}

export function isUsableLeafAnchorDocument(head: ProjectedAnchorDocumentHead): boolean {
  return isLeafAnchorDocument(head) && head.covered === head.total;
}

function parseAnchorDocumentHead(row: unknown): ProjectedAnchorDocumentHead | undefined {
  const record = row as Record<string, unknown> | undefined;
  const total = nonNegativeInteger(record?.["total"]);
  const generation = record?.["generation"];
  const summary = record?.["summary"];
  if (total === undefined || typeof generation !== "string" || typeof summary !== "string") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(summary) as Record<string, unknown>;
    const leaves = nonNegativeInteger(parsed["leaves"]);
    const valid = nonNegativeInteger(parsed["valid"]);
    const covered = nonNegativeInteger(parsed["covered"]);
    if (leaves === undefined || valid === undefined || covered === undefined) {
      return undefined;
    }
    return { covered, generation, leaves, total, valid };
  } catch {
    return undefined;
  }
}

export async function readProjectedAnchorDocumentHead(
  client: PublicProjectionReadClient,
  address: PublicProjectionAnchorAddress,
): Promise<ProjectedAnchorDocumentHead | undefined> {
  const result = await client.execute({
    args: [address.hub, address.clauseHash, PUBLIC_ANCHOR_FORMAT_VERSION],
    sql: `select aggregate.default_track_total as total, validity.generation,
        (select ${ANCHOR_LEAF_SUMMARY_SQL} from hub_page_anchors shard
          where ${ANCHOR_SHARD_RANGE_SQL}) as summary
      from public_aggregate_state as aggregate
      join hub_page_anchor_validity as validity
        on validity.hub = ? and validity.clause_hash = ?
       and validity.anchor_format_version = ?
       and validity.order_epoch = aggregate.release_hub_order_epoch
       and validity.generation = aggregate.generation
      where aggregate.scope = 'tracks' and aggregate.generation <> '' and ${AGGREGATE_READY}
      limit 1`,
  });
  return parseAnchorDocumentHead(result.rows[0]);
}

export async function readProjectedAnchorLeafForPageStart(
  client: PublicProjectionReadClient,
  address: PublicProjectionAnchorAddress,
  generation: string,
  pageStart: number,
): Promise<HubAnchorLeaf | undefined> {
  const prefix = `${address.clauseHash}:${generation}:`;
  const result = await client.execute({
    args: [address.hub, prefix, `${prefix}\uffff`, pageStart, pageStart],
    sql: `with leaves as (
        select shard.clause_hash, shard.anchors_json, shard.fingerprint,
          ${ANCHOR_LEAF_ROWS_SQL} as n,
          coalesce(sum(${ANCHOR_LEAF_ROWS_SQL}) over (
            order by shard.clause_hash rows between unbounded preceding and 1 preceding), 0) as prefix
        from hub_page_anchors shard
        where shard.hub = ? and shard.clause_hash >= ? and shard.clause_hash < ?)
      select anchors_json, fingerprint, prefix from leaves
      where prefix <= ? and ? < prefix + n
      order by clause_hash limit 1`,
  });
  const row = result.rows[0];
  const anchors = parseAnchorDocument(row?.anchors_json);
  const meta = parseHubAnchorLeafMeta(row?.fingerprint);
  const leafPrefix = nonNegativeInteger(row?.prefix);
  if (anchors === undefined || meta === undefined || leafPrefix === undefined) {
    return undefined;
  }
  return { anchors, meta, prefix: leafPrefix };
}

export type ProjectedTrackHubPageStart = {
  start: HubProjectedPageStart | undefined;
  total: number;
};

const ORDER_HEAD: HubProjectedPageStart = { after: null, offset: 0, phase: "non_null" };

function pageStartFromAnchors(
  page: number,
  pageSize: number,
  anchors: HubPageAnchor[],
): HubProjectedPageStart | undefined {
  if (page === 1) {
    return ORDER_HEAD;
  }
  const anchor = nearestHubPageAnchor(page, anchors);
  if (anchor === undefined) {
    return undefined;
  }
  return {
    after: { id: anchor.id, key: anchor.key },
    offset: (page - anchor.page) * pageSize,
    phase: anchor.key === null ? "null" : "non_null",
  };
}

export async function readProjectedTrackHubPageStart(
  client: PublicProjectionReadClient,
  address: PublicProjectionAnchorAddress,
  pageSize: number,
  page: number,
): Promise<ProjectedTrackHubPageStart | undefined> {
  if (!(await isPublicProjectionCutoverEnabledFor(client))) {
    return undefined;
  }
  try {
    const head = await readProjectedAnchorDocumentHead(client, address);
    if (head === undefined) {
      return undefined;
    }
    if (!isLeafAnchorDocument(head)) {
      const document = await readProjectedTrackHubAnchorsSnapshot(client, address, pageSize, {
        allowLegacyDocument: true,
      });
      if (document === undefined) {
        return undefined;
      }
      const pageStart = (page - 1) * pageSize;
      if (page > 1 && pageStart >= document.total) {
        return { start: undefined, total: document.total };
      }
      return {
        start: pageStartFromAnchors(page, pageSize, document.anchors),
        total: document.total,
      };
    }
    if (!isUsableLeafAnchorDocument(head)) {
      return undefined;
    }
    if (page === 1) {
      return { start: ORDER_HEAD, total: head.total };
    }
    const pageStart = (page - 1) * pageSize;
    if (pageStart >= head.total) {
      return { start: undefined, total: head.total };
    }
    const leaf = await readProjectedAnchorLeafForPageStart(
      client,
      address,
      head.generation,
      pageStart,
    );
    if (leaf === undefined) {
      return undefined;
    }
    const start = hubLeafPageStart(pageStart, leaf, pageSize);
    return start === undefined ? undefined : { start, total: head.total };
  } catch {
    return undefined;
  }
}

export async function isCurrentProjectedTrackHubAnchorDocumentUsable(
  client: PublicProjectionReadClient,
  address: PublicProjectionAnchorAddress,
  pageSize: number,
): Promise<boolean> {
  try {
    const head = await readProjectedAnchorDocumentHead(client, address);
    if (head === undefined) {
      return false;
    }
    if (isLeafAnchorDocument(head)) {
      return isUsableLeafAnchorDocument(head);
    }
    return (await readCurrentProjectedTrackHubAnchors(client, address, pageSize)) !== undefined;
  } catch {
    return false;
  }
}

export async function readCurrentProjectedTrackHubAnchors(
  client: PublicProjectionReadClient,
  address: PublicProjectionAnchorAddress,
  pageSize: number,
): Promise<ProjectedTrackHubAnchors | undefined> {
  return readProjectedTrackHubAnchorsSnapshot(client, address, pageSize, {
    allowLegacyDocument: false,
  });
}

export type StoredTrackHubAnchorsForAudit = ProjectedTrackHubAnchors & {
  leaf: boolean;
};

export async function readStoredTrackHubAnchorsForAudit(
  client: PublicProjectionReadClient,
  address: PublicProjectionAnchorAddress,
  pageSize: number,
): Promise<StoredTrackHubAnchorsForAudit | undefined> {
  try {
    const result = await client.execute({
      args: [address.hub, address.clauseHash, PUBLIC_ANCHOR_FORMAT_VERSION],
      sql: `select aggregate.default_track_total as total, validity.generation,
          (select ${ANCHOR_LEAF_SUMMARY_SQL} from hub_page_anchors shard
            where ${ANCHOR_SHARD_RANGE_SQL}) as summary
        from public_aggregate_state aggregate
        join hub_page_anchor_validity validity
          on validity.hub = ? and validity.clause_hash = ? and validity.anchor_format_version = ?
        where aggregate.scope = 'tracks' limit 1`,
    });
    const head = parseAnchorDocumentHead(result.rows[0]);
    if (head === undefined) {
      return undefined;
    }
    const prefix = `${address.clauseHash}:${head.generation}:`;
    const documents = await client.execute({
      args: [address.hub, address.clauseHash, prefix, `${prefix}\uffff`],
      sql: `select anchors_json, clause_hash from hub_page_anchors
        where hub = ? and (clause_hash = ? or (clause_hash >= ? and clause_hash < ?))
        order by clause_hash`,
    });
    const shards = documents.rows.filter((row) => row.clause_hash !== address.clauseHash);
    const selected = shards.length > 0 ? shards : documents.rows;
    const anchors: HubPageAnchor[] = [];
    for (const document of selected) {
      const parsed = parseAnchorDocument(document.anchors_json);
      if (parsed === undefined) {
        return undefined;
      }
      anchors.push(...parsed);
    }
    if (isLeafAnchorDocument(head)) {
      return isUsableLeafAnchorDocument(head)
        ? { anchors, leaf: true, total: head.total }
        : undefined;
    }
    return completeAnchorDocument(anchors, pageSize, head.total)
      ? { anchors, leaf: false, total: head.total }
      : undefined;
  } catch {
    return undefined;
  }
}

async function readProjectedTrackHubAnchorsSnapshot(
  client: PublicProjectionReadClient,
  address: PublicProjectionAnchorAddress,
  pageSize: number,
  options: { allowLegacyDocument: boolean },
): Promise<ProjectedTrackHubAnchors | undefined> {
  try {
    const head = await readProjectedAnchorDocumentHead(client, address);
    if (head === undefined) {
      return undefined;
    }
    const { generation, total } = head;
    const prefix = `${address.clauseHash}:${generation}:`;
    const documents = await client.execute(
      options.allowLegacyDocument
        ? {
            args: [address.hub, address.clauseHash, prefix, `${prefix}\uffff`],
            sql: `select anchors_json, clause_hash from hub_page_anchors
              where hub = ? and (clause_hash = ? or (clause_hash >= ? and clause_hash < ?))
              order by clause_hash`,
          }
        : {
            args: [address.hub, prefix, `${prefix}\uffff`],
            sql: `select anchors_json, clause_hash from hub_page_anchors
              where hub = ? and clause_hash >= ? and clause_hash < ? order by clause_hash`,
          },
    );
    const shardRows = documents.rows.filter(
      (candidate) => candidate.clause_hash !== address.clauseHash,
    );
    const selected =
      shardRows.length > 0 ? shardRows : options.allowLegacyDocument ? documents.rows : [];
    if (selected.length === 0) {
      return undefined;
    }
    const anchors: HubPageAnchor[] = [];
    for (const document of selected) {
      const parsed = parseAnchorDocument(document.anchors_json);
      if (parsed === undefined) {
        return undefined;
      }
      anchors.push(...parsed);
    }
    if (isLeafAnchorDocument(head)) {
      return isUsableLeafAnchorDocument(head) ? { anchors, total } : undefined;
    }
    return completeAnchorDocument(anchors, pageSize, total) ? { anchors, total } : undefined;
  } catch {
    return undefined;
  }
}
