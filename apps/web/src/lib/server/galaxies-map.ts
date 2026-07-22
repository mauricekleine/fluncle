// The galaxy map's backing functions (docs/agents/cluster-engine.md) — the `artists.ts`
// twin, consumed by BOTH the oRPC handlers (`./orpc/galaxies.ts`, `./orpc/admin-galaxies.ts`)
// and the public route loaders (Slice 4). The filename dodged the then-existing
// `lib/galaxies.ts` (the four vibe-quadrant constants, since retired).
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
import { cosineSimilarity, readEmbeddingBlob } from "./embedding";
import {
  type BoardTrackListItem,
  getFindingsByGalaxyRanked,
  getGalaxyAuditionMembers,
  toPublicTrackListItem,
} from "./tracks";

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

/**
 * The naming view's per-galaxy shape (Slice 3): the full admin row plus a capped,
 * core-first sample of its member findings so the operator can SEE the covers and
 * AUDITION them (via `/api/preview`) before naming the cluster. `members` are ranked
 * by centroid-distance ascending (the core of the galaxy first), the same order the
 * public `get_galaxy` uses; `memberCount` on the admin row stays the true (uncapped)
 * total. `members` ride the LEAN board projection (`getGalaxyAuditionMembers`): the
 * naming audition renders only a cover + title/artists + Log ID, so a member never
 * carries the graph/discovery fields (compile-enforced by `BoardTrackListItem`).
 */
export type GalaxyAdminWithMembers = GalaxyAdminItem & { members: BoardTrackListItem[] };

const GALAXY_COLUMNS =
  "id, handle, name, slug, centroid_json, retired_at, split_requested_at, created_at, updated_at";

/**
 * The galaxy thin-content floor (browse-by-feel RFC, mirroring the `/artist` gate): a
 * named galaxy below this many members renders `noindex, follow` and stays out of the
 * sitemap. It still resolves (200) and is reachable — just not indexed while thin.
 */
export const GALAXY_INDEX_MIN_FINDINGS = 4;

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
    "select galaxy_id, count(*) as c from findings where galaxy_id is not null group by galaxy_id",
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
 * The naming view's read (Slice 3): the FULL map (named + unnamed + retired) with each
 * galaxy's capped, core-first member sample attached. The naming view partitions this
 * into the naming queue (unnamed), the named map, and the retired tail client-side.
 * `memberCap` bounds the covers shown per galaxy (the audition needs a representative
 * handful, not the whole cluster); the row's `memberCount` stays the uncapped total.
 */
export async function listGalaxiesAdminWithMembers(
  memberCap: number,
): Promise<GalaxyAdminWithMembers[]> {
  const galaxies = await listGalaxiesAdmin();

  // One ranked read per galaxy (k is ~9, so a bounded fan-out, not an N+1 concern):
  // core-first, capped, from the offset-0 head, hydrated LEAN (the audition shows a cover +
  // identity, never the fat read's graph/JSON columns). A retired galaxy has no members, so
  // its ranked read is a cheap empty.
  return Promise.all(
    galaxies.map(async (galaxy) => ({
      ...galaxy,
      members: await getGalaxyAuditionMembers(galaxy.id, galaxy.centroid, memberCap, 0),
    })),
  );
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

// ── The public launch gate (browse-by-feel RFC, decision 5 — ratified) ─────────
//
// The whole lens ships dark until the operator has named the ENTIRE initial map in
// one sitting: NOTHING public renders a galaxy until every non-retired galaxy is
// named. This is a RUNTIME check, not a build flag — so this code can merge while
// the operator is still naming, and every public surface (the `/galaxies` lens, the
// `list_galaxies`/`get_galaxy` API + CLI, the sitemap, the `/log` prose clause + the
// OG card line) lights up the moment the LAST name lands. A partial map — one or more
// non-retired galaxies still unnamed — reads exactly like the pre-launch dark state.
// Machine handles never render publicly regardless (they are not a name).

/**
 * Is the sonic-galaxy map FULLY NAMED — every non-retired galaxy carrying a `name` +
 * `slug`? The single runtime gate behind every public galaxy surface. False when the
 * map is empty (nothing to show) or any non-retired galaxy is still unnamed (a partial
 * map stays dark). Retired galaxies are excluded — an emptied cluster never blocks the
 * launch. One `COUNT` query.
 */
export async function isGalaxyMapFullyNamed(): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute(
    `select
       count(*) as total,
       sum(case when name is null or slug is null then 1 else 0 end) as unnamed
     from galaxies where retired_at is null`,
  );
  const row = typedRow<{ total: number; unnamed: number | null }>(result.rows);

  if (!row) {
    return false;
  }

  const total = Number(row.total);
  const unnamed = Number(row.unnamed ?? 0);

  return total > 0 && unnamed === 0;
}

/**
 * The PUBLIC named map — `listNamedGalaxies`, but held behind the launch gate: an
 * empty list until the whole map is named. Backs the public `list_galaxies` op (+ the
 * CLI) and the sitemap. `listNamedGalaxies` stays the raw reader (the newsletter's
 * section matcher reads it un-gated via `listGalaxyNames`).
 */
export async function listPublicGalaxies(): Promise<GalaxyListItem[]> {
  return (await isGalaxyMapFullyNamed()) ? listNamedGalaxies() : [];
}

/**
 * The PUBLIC by-slug read — `getNamedGalaxyBySlug` behind the launch gate: a
 * `GalaxyNotFoundError` (→ 404) while the map is only partially named, so no single
 * galaxy leaks before the whole map ships. Backs the public `get_galaxy` op.
 */
export async function getPublicGalaxyBySlug(
  slug: string,
  limit: number,
  offset: number,
): Promise<{ findings: TrackListItem[]; galaxy: GalaxyListItem }> {
  if (!(await isGalaxyMapFullyNamed())) {
    throw new GalaxyNotFoundError(`No galaxy with slug "${slug}"`);
  }

  return getNamedGalaxyBySlug(slug, limit, offset);
}

/**
 * One named galaxy's full lens page (the `/galaxies/<slug>` route loader): the galaxy
 * itself, its findings (core-first, paginated), and the adjacency strip — the other
 * named galaxies ranked by centroid cosine ("Close in sound" applied to galaxies
 * themselves). Returns `null` (→ `notFound()`) when the map is not yet fully named OR
 * the slug names no named galaxy. The findings are public-stripped.
 */
export async function getGalaxyLensPage(
  slug: string,
  limit: number,
  offset: number,
): Promise<{
  adjacent: GalaxyListItem[];
  findings: TrackListItem[];
  galaxy: GalaxyListItem;
} | null> {
  if (!(await isGalaxyMapFullyNamed())) {
    return null;
  }

  const named = await loadNamedGalaxyRows();
  const target = named.rows.find((row) => row.slug === slug);

  if (!target || !target.name || !target.slug) {
    return null;
  }

  const targetCentroid = parseCentroid(target.centroid_json);
  const findings = await getFindingsByGalaxyRanked(target.id, targetCentroid, limit, offset);
  const adjacent = rankAdjacent(target, targetCentroid, named);

  return {
    adjacent,
    findings: findings.map((finding) => toPublicTrackListItem(finding)),
    galaxy: {
      memberCount: named.counts.get(target.id) ?? 0,
      name: target.name,
      slug: target.slug,
    },
  };
}

/** One galaxy pane on the `/galaxies` index: the public item plus a core-first cover sample. */
export type GalaxyPane = GalaxyListItem & { covers: string[] };

/**
 * The `/galaxies` INDEX loader — every named galaxy as a cover-led pane, gated on the
 * fully-named map (an empty list keeps the index dark pre-launch). Each pane carries a
 * capped, core-first sample of member cover URLs (`albumImageUrl`) so the index reads
 * as a map of places, not a list of names. Ordered by member count descending, then
 * name (the `listNamedGalaxies` order).
 */
export async function listGalaxyPanes(coverCap: number): Promise<GalaxyPane[]> {
  if (!(await isGalaxyMapFullyNamed())) {
    return [];
  }

  const named = await loadNamedGalaxyRows();
  const panes = await Promise.all(
    named.rows.map(async (row) => {
      // Named rows are guaranteed name+slug here (loadNamedGalaxyRows filters), but the
      // column types are nullable — narrow so the pane's fields are non-null strings.
      const name = row.name;
      const slug = row.slug;

      if (!name || !slug) {
        return undefined;
      }

      const members = await getFindingsByGalaxyRanked(
        row.id,
        parseCentroid(row.centroid_json),
        coverCap,
        0,
      );

      return {
        covers: members.flatMap((member) => (member.albumImageUrl ? [member.albumImageUrl] : [])),
        memberCount: named.counts.get(row.id) ?? 0,
        name,
        slug,
      };
    }),
  );

  return panes
    .flatMap((pane) => (pane ? [pane] : []))
    .sort((a, b) => b.memberCount - a.memberCount || a.name.localeCompare(b.name));
}

/** The named, non-retired galaxy rows + the shared derived-count map (one read each). */
async function loadNamedGalaxyRows(): Promise<{ counts: Map<string, number>; rows: GalaxyRow[] }> {
  const db = await getDb();
  const [result, counts] = await Promise.all([
    db.execute(
      `select ${GALAXY_COLUMNS} from galaxies where name is not null and slug is not null and retired_at is null`,
    ),
    memberCounts(db),
  ]);

  return { counts, rows: typedRows<GalaxyRow>(result.rows) };
}

/** The four nearest OTHER named galaxies by centroid cosine — the adjacency strip. */
function rankAdjacent(
  target: GalaxyRow,
  targetCentroid: number[],
  named: { counts: Map<string, number>; rows: GalaxyRow[] },
): GalaxyListItem[] {
  return named.rows
    .filter((row) => row.id !== target.id && row.name && row.slug)
    .map((row) => ({
      memberCount: named.counts.get(row.id) ?? 0,
      name: row.name ?? "",
      score: cosineSimilarity(targetCentroid, parseCentroid(row.centroid_json)),
      slug: row.slug ?? "",
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map(({ memberCount, name, slug }) => ({ memberCount, name, slug }));
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
  clusters: Array<{
    centroid: number[];
    clearSplitRequest?: boolean;
    id: string | null;
    retire?: boolean;
  }>,
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

    // Consuming a split: upsert the parent's centroid AND clear its split flag in one
    // statement, so the next tick never re-runs the same split. Otherwise a plain
    // centroid upsert (the every-night mean refresh) leaves the flag untouched.
    if (cluster.clearSplitRequest) {
      statements.push({
        args: [centroidJson, now, cluster.id],
        sql: "update galaxies set centroid_json = ?, split_requested_at = null, updated_at = ? where id = ?",
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
  let where = "findings.log_id is not null and tracks.embedding_blob is not null";

  if (after) {
    where += " and tracks.track_id > ?";
    args.push(after);
  }

  args.push(limit + 1);
  const result = await db.execute({
    args,
    sql: `select tracks.track_id, findings.galaxy_id, tracks.embedding_blob
          from findings join tracks on tracks.track_id = findings.track_id
          where ${where} order by tracks.track_id asc limit ?`,
  });

  const rows = typedRows<{
    embedding_blob: unknown;
    galaxy_id: string | null;
    track_id: string;
  }>(result.rows);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const embeddings: TrackEmbedding[] = [];

  for (const row of page) {
    const embedding = readEmbeddingBlob(row.embedding_blob);

    if (embedding && embedding.length > 0) {
      embeddings.push({ embedding, galaxyId: row.galaxy_id, trackId: row.track_id });
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
