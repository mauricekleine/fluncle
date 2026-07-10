// The galaxy map's backing functions (browse-by-feel RFC) — the `artists.ts` twin,
// consumed by BOTH the oRPC handlers (`./orpc/galaxies.ts`, `./orpc/admin-galaxies.ts`)
// and the public route loaders (Slice 4). The filename dodges the existing
// `lib/galaxies.ts` (the four vibe-quadrant constants, which Unit E retires).
//
// Identity is minted HERE, server-side: a new cluster's stable `id` (`gal_<uuid>`,
// never recycled) and its permanent machine `handle` (`galaxySlug(id, attempt)`,
// collision-salted) are stamped inside `updateGalaxyMap` — the box never mints
// identity, because `galaxy-slug.ts` is a workspace package the standalone baked
// sweep scripts can't import. Member counts are DERIVED (`COUNT(*) GROUP BY
// galaxy_id`), never stored — the denormalization-drift class is deleted outright.

import { randomUUID } from "node:crypto";
import {
  type GalaxyAdminItem,
  type GalaxyListItem,
  type TrackEmbedding,
  type TrackListItem,
} from "@fluncle/contracts";
import { galaxySlug } from "@fluncle/contracts/util/galaxy-slug";
import { getDb, typedRow, typedRows } from "./db";
import { getFindingsByGalaxyRanked, toPublicTrackListItem } from "./tracks";

// A row from the `galaxies` table (snake_case columns).
type GalaxyRow = {
  centroid_json: string;
  created_at: string;
  handle: string;
  id: string;
  name: string | null;
  retired_at: string | null;
  slug: string | null;
  split_requested_at: string | null;
  updated_at: string;
};

/** A galaxy row with its derived member count, the shape both cron + admin read. */
export class GalaxyNotFoundError extends Error {}

const GALAXY_COLUMNS =
  "id, handle, name, slug, centroid_json, retired_at, split_requested_at, created_at, updated_at";

/** Parse a stored centroid (JSON float array); a malformed value degrades to `[]`. */
function parseCentroid(json: string): number[] {
  try {
    const raw = JSON.parse(json) as unknown;

    return Array.isArray(raw)
      ? raw.filter((value): value is number => typeof value === "number")
      : [];
  } catch {
    return [];
  }
}

/** Map a galaxy row + its derived member count to the full admin DTO. */
function toAdminItem(row: GalaxyRow, memberCount: number): GalaxyAdminItem {
  return {
    centroid: parseCentroid(row.centroid_json),
    createdAt: row.created_at,
    handle: row.handle,
    id: row.id,
    memberCount,
    name: row.name,
    retiredAt: row.retired_at,
    // The per-cluster coherence evidence (mean silhouette) is display-only and O(N²);
    // the cluster engine (Slice 2) computes it for the naming view (Slice 3). Null here.
    silhouette: null,
    slug: row.slug,
    splitRequestedAt: row.split_requested_at,
    updatedAt: row.updated_at,
  };
}

/** The derived member count per galaxy — `COUNT(*) GROUP BY galaxy_id`, one query. */
async function memberCounts(db: Awaited<ReturnType<typeof getDb>>): Promise<Map<string, number>> {
  const result = await db.execute(
    "select galaxy_id, count(*) as c from tracks where galaxy_id is not null group by galaxy_id",
  );
  const counts = new Map<string, number>();

  for (const row of typedRows<{ c: number; galaxy_id: string }>(result.rows)) {
    counts.set(row.galaxy_id, Number(row.c));
  }

  return counts;
}

/**
 * The FULL galaxy map — named, unnamed, and retired, each with its centroid + derived
 * member count. Serves `list_galaxies_admin` (the naming view + the cron's map read).
 * Ordered oldest-first (stable) so the cron sees a deterministic map.
 */
export async function listGalaxiesAdmin(): Promise<GalaxyAdminItem[]> {
  const db = await getDb();
  const [result, counts] = await Promise.all([
    db.execute(`select ${GALAXY_COLUMNS} from galaxies order by created_at asc, id asc`),
    memberCounts(db),
  ]);

  return typedRows<GalaxyRow>(result.rows).map((row) => toAdminItem(row, counts.get(row.id) ?? 0));
}

/**
 * The named map — every operator-NAMED, non-retired galaxy with its derived member
 * count. Serves the public `list_galaxies`. Ordered by member count descending
 * (the most-represented galaxies first), then name.
 */
export async function listNamedGalaxies(): Promise<GalaxyListItem[]> {
  const db = await getDb();
  const [result, counts] = await Promise.all([
    db.execute(
      "select id, name, slug from galaxies where name is not null and slug is not null and retired_at is null",
    ),
    memberCounts(db),
  ]);

  return typedRows<{ id: string; name: string; slug: string }>(result.rows)
    .map((row) => ({ memberCount: counts.get(row.id) ?? 0, name: row.name, slug: row.slug }))
    .sort((a, b) => b.memberCount - a.memberCount || a.name.localeCompare(b.name));
}

/**
 * The named galaxies' display names in the public list order — the newsletter section
 * matcher (`lib/editions.ts`) ranks an edition's authored galaxy labels against these
 * live names instead of the four dead vibe constants. Empty until the first galaxy is
 * named (Slice 3), in which case the matcher keeps authored order — benign by design.
 */
export async function listGalaxyNames(): Promise<string[]> {
  return (await listNamedGalaxies()).map((galaxy) => galaxy.name);
}

/**
 * One named galaxy by slug + its findings, ordered core-first and paginated. A slug
 * that names no galaxy, or an unnamed/retired one, throws `GalaxyNotFoundError` (the
 * handler maps it to a 404, so list + get agree on which galaxies exist). The findings
 * are public-stripped.
 */
export async function getNamedGalaxyBySlug(
  slug: string,
  limit: number,
  offset: number,
): Promise<{ findings: TrackListItem[]; galaxy: GalaxyListItem }> {
  const db = await getDb();
  const result = await db.execute({
    args: [slug],
    sql: `select ${GALAXY_COLUMNS} from galaxies
          where slug = ? and name is not null and retired_at is null limit 1`,
  });
  const row = typedRow<GalaxyRow>(result.rows);

  if (!row || !row.name || !row.slug) {
    throw new GalaxyNotFoundError(`No galaxy with slug "${slug}"`);
  }

  const counts = await memberCounts(db);
  const findings = await getFindingsByGalaxyRanked(
    row.id,
    parseCentroid(row.centroid_json),
    limit,
    offset,
  );

  return {
    findings: findings.map((finding) => toPublicTrackListItem(finding)),
    galaxy: { memberCount: counts.get(row.id) ?? 0, name: row.name, slug: row.slug },
  };
}

/**
 * The operator's editorial write on one galaxy (`update_galaxy`): set `name` + `slug`
 * (naming mints the public URL), rename, and/or request a split (`requestSplit` stamps
 * `split_requested_at`; the nightly tick consumes it). At least one of the three must
 * be present. Returns the updated admin row. Throws `GalaxyNotFoundError` for an
 * unknown id.
 */
export async function updateGalaxyFields(
  id: string,
  fields: { name?: string; requestSplit?: boolean; slug?: string },
): Promise<GalaxyAdminItem> {
  const db = await getDb();
  const now = new Date().toISOString();
  const sets: string[] = [];
  const args: Array<string | null> = [];

  if (fields.name !== undefined) {
    const trimmed = fields.name.trim();
    sets.push("name = ?");
    args.push(trimmed || null);
  }

  if (fields.slug !== undefined) {
    const trimmed = fields.slug.trim();
    sets.push("slug = ?");
    args.push(trimmed || null);
  }

  if (fields.requestSplit) {
    sets.push("split_requested_at = ?");
    args.push(now);
  }

  if (sets.length === 0) {
    throw new Error("update_galaxy needs at least one of name, slug, requestSplit");
  }

  sets.push("updated_at = ?");
  args.push(now);
  args.push(id);

  await db.execute({ args, sql: `update galaxies set ${sets.join(", ")} where id = ?` });

  const item = await getGalaxyAdminById(id);

  if (!item) {
    throw new GalaxyNotFoundError(`No galaxy with id "${id}"`);
  }

  return item;
}

/** One galaxy's full admin row by id (with derived member count), or undefined. */
async function getGalaxyAdminById(id: string): Promise<GalaxyAdminItem | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [id],
    sql: `select ${GALAXY_COLUMNS} from galaxies where id = ? limit 1`,
  });
  const row = typedRow<GalaxyRow>(result.rows);

  if (!row) {
    return undefined;
  }

  const counts = await memberCounts(db);

  return toAdminItem(row, counts.get(row.id) ?? 0);
}

/**
 * The cron's transactional map write (`update_galaxy_map`). One `db.batch(_, "write")`
 * (libSQL's one-implicit-transaction batch, the `push.ts` precedent), so a crash can
 * never half-apply the map. Each cluster row either upserts an existing centroid,
 * retires it (`retire: true`), or — for `id: null` — mints a NEW cluster: a stable
 * `gal_<uuid>` id + a collision-salted `galaxySlug(id, attempt)` handle, stamped
 * server-side. Returns the full resulting map (with the minted ids) so the box can
 * then write per-finding assignments that point at real ids.
 */
export async function updateGalaxyMap(
  clusters: Array<{ centroid: number[]; id: string | null; retire?: boolean }>,
): Promise<GalaxyAdminItem[]> {
  const db = await getDb();
  const now = new Date().toISOString();

  // The handles already taken — seed the collision-salt loop so a fresh mint never
  // clashes with a stored handle OR another cluster minted in this same batch.
  const takenResult = await db.execute("select handle from galaxies");
  const takenHandles = new Set(
    typedRows<{ handle: string }>(takenResult.rows).map((row) => row.handle),
  );

  const statements: Array<{ args: Array<number | string | null>; sql: string }> = [];

  for (const cluster of clusters) {
    const centroidJson = JSON.stringify(cluster.centroid);

    if (cluster.id === null) {
      const id = `gal_${randomUUID()}`;
      const handle = mintHandle(id, takenHandles);
      takenHandles.add(handle);
      statements.push({
        args: [id, handle, centroidJson, now, now],
        sql: `insert into galaxies (id, handle, centroid_json, created_at, updated_at)
              values (?, ?, ?, ?, ?)`,
      });
      continue;
    }

    if (cluster.retire) {
      statements.push({
        args: [now, now, cluster.id],
        sql: "update galaxies set retired_at = ?, updated_at = ? where id = ?",
      });
      continue;
    }

    statements.push({
      args: [centroidJson, now, cluster.id],
      sql: "update galaxies set centroid_json = ?, updated_at = ? where id = ?",
    });
  }

  if (statements.length > 0) {
    await db.batch(statements, "write");
  }

  return listGalaxiesAdmin();
}

/**
 * Mint a permanent, unique machine handle for a new galaxy: `galaxySlug(id, attempt)`,
 * salted-re-rolled on collision against the taken set (the plan-handle precedent).
 */
function mintHandle(id: string, taken: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 10000; attempt += 1) {
    const candidate = galaxySlug(id, attempt);

    if (!taken.has(candidate)) {
      return candidate;
    }
  }

  // Unreachable at any realistic galaxy count (the pool is ~3k combinations and
  // `galaxySlug` appends a numeric suffix past exhaustion), but never return a clash.
  return galaxySlug(id, Date.now());
}

/**
 * A cursor page of the embedded corpus (`list_track_embeddings`) — the cluster
 * engine's input. Keyed on a stable `track_id` (the `list_tracks_admin` cursor
 * precedent): limit/offset over a table the embed cron mutates every 5 minutes would
 * skip/duplicate rows. Only coordinate-bearing, embedded findings are returned.
 */
export async function listTrackEmbeddingsPage(
  cursor: string | undefined,
  limit: number,
): Promise<{ embeddings: TrackEmbedding[]; nextCursor: string | null }> {
  const db = await getDb();
  const after = decodeCursor(cursor);
  const args: Array<number | string> = [];
  let where = "log_id is not null and embedding_json is not null";

  if (after) {
    where += " and track_id > ?";
    args.push(after);
  }

  args.push(limit + 1);
  const result = await db.execute({
    args,
    sql: `select track_id, embedding_json from tracks
          where ${where} order by track_id asc limit ?`,
  });

  const rows = typedRows<{ embedding_json: string; track_id: string }>(result.rows);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const embeddings: TrackEmbedding[] = [];

  for (const row of page) {
    const embedding = parseCentroid(row.embedding_json);

    if (embedding.length > 0) {
      embeddings.push({ embedding, trackId: row.track_id });
    }
  }

  const lastId = page.at(-1)?.track_id;

  return {
    embeddings,
    nextCursor: hasMore && lastId ? encodeCursor(lastId) : null,
  };
}

/** Encode a `track_id` cursor (opaque base64url, the `encodeTrackCursor` habit). */
function encodeCursor(trackId: string): string {
  return Buffer.from(trackId, "utf8").toString("base64url");
}

/** Decode a `track_id` cursor; a malformed value degrades to undefined (page from top). */
function decodeCursor(cursor: string | undefined): string | undefined {
  if (!cursor) {
    return undefined;
  }

  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");

    return decoded || undefined;
  } catch {
    return undefined;
  }
}
