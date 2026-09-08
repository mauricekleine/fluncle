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

/** The public aggregate/artist reader flag. Only the exact string `true` opens the cutover. */
export const PUBLIC_PROJECTION_CUTOVER_ENABLED_KEY = "public_projection_cutover_enabled";

/** The schema version written beside a published default-hub anchor document. */
export const PUBLIC_ANCHOR_FORMAT_VERSION = 1;

/**
 * The order-change ledger: one `settings` row per release-hub order epoch a subject-level public
 * repair produced, keyed by the zero-padded epoch so the range read walks the primary key in epoch
 * order. Anchor maintenance consumes the ledger to amend the current document page-locally; an
 * epoch without a ledger row is an unrepresented order change and forces the full rebuild.
 */
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
  /** The subject's release date before the change; meaningful for `delete` and `move`. */
  from: null | string;
  id: string;
  /**
   * `insert`/`delete`/`move` name the run(s) whose row set changed; `noop` recorded an epoch bump
   * with no membership change; `unknown` could not recover the old position and is unamendable.
   */
  kind: "delete" | "insert" | "move" | "noop" | "unknown";
  /** The subject's release date after the change; meaningful for `insert` and `move`. */
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

/** Missing, malformed, or unreadable settings always retain the authoritative legacy reads. */
export async function isPublicProjectionCutoverEnabled(): Promise<boolean> {
  try {
    return (await getSetting(PUBLIC_PROJECTION_CUTOVER_ENABLED_KEY)) === "true";
  } catch {
    return false;
  }
}

/** Client-injected form used by projection readers and real-libSQL integration tests. */
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

/** Return the projected whole-archive total only when its complete clean-through proof is usable. */
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

/** Read one exact literal bucket family, retaining an empty usable projection as an empty array. */
export async function readProjectedAggregateBuckets(
  client: PublicProjectionReadClient,
  kind: "key" | "release_date_bucket",
): Promise<ProjectedAggregateBucket[] | undefined> {
  if (!(await isPublicProjectionCutoverEnabledFor(client))) {
    return undefined;
  }

  try {
    const order = kind === "release_date_bucket" ? "desc" : "asc";
    const result = await client.execute({
      args: [kind],
      sql: `select counts.bucket, counts.track_count
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

/** Read the exact projected qualified set, or run the caller's unchanged legacy set SQL. */
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
    } catch {
      // The source query below is the compatibility path for every projection read failure.
    }
  }

  const legacy = await client.execute(
    `select artist_id from (${legacyQualifiedArtistsSql}) order by artist_id`,
  );
  return legacy.rows.flatMap((row) => (typeof row.artist_id === "string" ? [row.artist_id] : []));
}

/**
 * Leaf metadata predicates over a `hub_page_anchors` row aliased `shard`. Every JSON call sits
 * behind `json_valid` so a corpus fingerprint from an older shard never raises inside the read.
 */
export const ANCHOR_LEAF_META_VALID_SQL = `coalesce(case when json_valid(shard.fingerprint) then
  (json_type(shard.fingerprint) = 'object'
    and json_extract(shard.fingerprint, '$.v') = 1
    and json_type(shard.fingerprint, '$.n') = 'integer'
    and json_type(shard.fingerprint, '$.nn') = 'integer'
    and json_type(shard.fingerprint, '$.base') = 'integer'
    and json_type(shard.fingerprint, '$.after') in ('null', 'object')) end, 0)`;

export const ANCHOR_LEAF_ROWS_SQL = `case when ${ANCHOR_LEAF_META_VALID_SQL}
  then json_extract(shard.fingerprint, '$.n') end`;

/** The leaf-run summary of one generation, evaluated inside SQL as a single JSON scalar. */
export const ANCHOR_LEAF_SUMMARY_SQL = `json_object(
  'leaves', count(*),
  'valid', coalesce(sum(case when ${ANCHOR_LEAF_META_VALID_SQL} then 1 else 0 end), 0),
  'covered', coalesce(sum(${ANCHOR_LEAF_ROWS_SQL}), 0))`;

/** The generation-prefixed shard range of the validity row aliased `validity`. */
export const ANCHOR_SHARD_RANGE_SQL = `shard.hub = validity.hub
  and shard.clause_hash >= validity.clause_hash || ':' || validity.generation || ':'
  and shard.clause_hash < validity.clause_hash || ':' || validity.generation || ':\uffff'`;

export type ProjectedAnchorDocumentHead = {
  /** Rows the valid leaf runs cover together. */
  covered: number;
  generation: string;
  /** Shards under the generation prefix. */
  leaves: number;
  total: number;
  /** Shards carrying valid leaf metadata. */
  valid: number;
};

/** A document whose every shard is a self-describing run. */
export function isLeafAnchorDocument(head: ProjectedAnchorDocumentHead): boolean {
  return head.leaves > 0 && head.valid === head.leaves;
}

/** A leaf document is usable when its runs cover exactly the projected total. */
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

/**
 * One snapshot of the current document's identity and shape: the state, repair, address, format,
 * order epoch, and generation predicates plus a bounded leaf summary that never leaves SQL.
 */
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

/**
 * The one run holding the page that starts at absolute position `pageStart`, located by a running
 * prefix count over the generation's leaf metadata. Only that run's row leaves SQL.
 */
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
  /** Undefined when the requested page lies past the projected total. */
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

/**
 * Resolve where one projected numbered page starts. A leaf document answers from the single run
 * holding the page; an older whole-document format answers from its complete boundary set. Every
 * unusable or failing case returns `undefined` so the caller keeps its legacy source query.
 */
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
        requireCutover: false,
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

/**
 * Whether the current generation's document is usable, proven inside SQL without concatenating the
 * document: a leaf document proves its run coverage from metadata alone, while an older format
 * still parses whole.
 */
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

/**
 * Read a complete, current default-hub anchor document whole. The state, repair, address, format,
 * order epoch, and generation predicates are one snapshot; malformed or incomplete JSON is unusable.
 * For a leaf document the returned anchors are the runs' stored boundary rows, whose page numbers
 * are exact only until page-local maintenance amends an earlier run; page serving resolves through
 * `readProjectedTrackHubPageStart` instead.
 */
export async function readProjectedTrackHubAnchors(
  client: PublicProjectionReadClient,
  address: PublicProjectionAnchorAddress,
  pageSize: number,
): Promise<ProjectedTrackHubAnchors | undefined> {
  return readProjectedTrackHubAnchorsSnapshot(client, address, pageSize, {
    allowLegacyDocument: true,
    requireCutover: true,
  });
}

/** The exact runtime validator without the flag prerequisite, used by the atomic open gate. */
export async function readCurrentProjectedTrackHubAnchors(
  client: PublicProjectionReadClient,
  address: PublicProjectionAnchorAddress,
  pageSize: number,
): Promise<ProjectedTrackHubAnchors | undefined> {
  return readProjectedTrackHubAnchorsSnapshot(client, address, pageSize, {
    allowLegacyDocument: false,
    requireCutover: false,
  });
}

export type StoredTrackHubAnchorsForAudit = ProjectedTrackHubAnchors & {
  /** Whether the stored generation is a leaf document, whose served boundaries need a source walk. */
  leaf: boolean;
};

/** Shadow-only exact document reader; content and epoch agreement are reported separately. */
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
  options: { allowLegacyDocument: boolean; requireCutover: boolean },
): Promise<ProjectedTrackHubAnchors | undefined> {
  if (options.requireCutover && !(await isPublicProjectionCutoverEnabledFor(client))) {
    return undefined;
  }

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
