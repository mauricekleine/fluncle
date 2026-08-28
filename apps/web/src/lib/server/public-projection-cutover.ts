import { type Client } from "@libsql/client";

import { type HubPageAnchor } from "./hub-page-anchors";
import { getSetting } from "./settings";

/** The public aggregate/artist reader flag. Only the exact string `true` opens the cutover. */
export const PUBLIC_PROJECTION_CUTOVER_ENABLED_KEY = "public_projection_cutover_enabled";

/** The schema version written beside a published default-hub anchor document. */
export const PUBLIC_ANCHOR_FORMAT_VERSION = 1;

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
 * Read a complete, current default-hub anchor document. The state, repair, address, format, order
 * epoch, and generation predicates are one snapshot; malformed or incomplete JSON is unusable.
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
    const result = await client.execute({
      args: [address.hub, address.clauseHash, PUBLIC_ANCHOR_FORMAT_VERSION],
      sql: `select aggregate.default_track_total as total, validity.generation
        from public_aggregate_state as aggregate
        join hub_page_anchor_validity as validity
          on validity.hub = ? and validity.clause_hash = ?
         and validity.anchor_format_version = ?
         and validity.order_epoch = aggregate.release_hub_order_epoch
         and validity.generation = aggregate.generation
        where aggregate.scope = 'tracks' and aggregate.generation <> '' and ${AGGREGATE_READY}
        limit 1`,
    });
    const row = result.rows[0];
    const total = nonNegativeInteger(row?.total);
    const generation = row?.generation;
    if (total === undefined || typeof generation !== "string") {
      return undefined;
    }
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
    return completeAnchorDocument(anchors, pageSize, total) ? { anchors, total } : undefined;
  } catch {
    return undefined;
  }
}
