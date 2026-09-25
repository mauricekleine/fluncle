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

export class GalaxyNotFoundError extends Error {}

export type GalaxyAdminWithMembers = GalaxyAdminItem & { members: BoardTrackListItem[] };

const GALAXY_COLUMNS =
  "id, handle, name, slug, centroid_json, retired_at, split_requested_at, created_at, updated_at";

export { GALAXY_INDEX_MIN_FINDINGS } from "../galaxies";

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

function toAdminItem(row: GalaxyRow, memberCount: number): GalaxyAdminItem {
  return {
    centroid: parseCentroid(row.centroid_json),
    createdAt: row.created_at,
    handle: row.handle,
    id: row.id,
    memberCount,
    name: row.name,
    retiredAt: row.retired_at,

    silhouette: null,
    slug: row.slug,
    splitRequestedAt: row.split_requested_at,
    updatedAt: row.updated_at,
  };
}

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

export async function listGalaxiesAdmin(): Promise<GalaxyAdminItem[]> {
  const db = await getDb();
  const [result, counts] = await Promise.all([
    db.execute(`select ${GALAXY_COLUMNS} from galaxies order by created_at asc, id asc`),
    memberCounts(db),
  ]);

  return typedRows<GalaxyRow>(result.rows).map((row) => toAdminItem(row, counts.get(row.id) ?? 0));
}

export async function listGalaxiesAdminWithMembers(
  memberCap: number,
): Promise<GalaxyAdminWithMembers[]> {
  const galaxies = await listGalaxiesAdmin();

  return Promise.all(
    galaxies.map(async (galaxy) => ({
      ...galaxy,
      members: await getGalaxyAuditionMembers(galaxy.id, galaxy.centroid, memberCap, 0),
    })),
  );
}

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

export async function listGalaxyNames(): Promise<string[]> {
  return (await listNamedGalaxies()).map((galaxy) => galaxy.name);
}

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

export async function listPublicGalaxies(): Promise<GalaxyListItem[]> {
  return (await isGalaxyMapFullyNamed()) ? listNamedGalaxies() : [];
}

export async function countPublicIndexableGalaxies(minFindings: number): Promise<number> {
  const db = await getDb();
  const result = await db.execute({
    args: [minFindings],
    sql: `select count(*) as n
          from galaxies as galaxy
          where galaxy.name is not null
            and galaxy.slug is not null
            and galaxy.retired_at is null
            and exists (
              select 1 from galaxies as active
              where active.retired_at is null
            )
            and not exists (
              select 1 from galaxies as unnamed
              where unnamed.retired_at is null
                and (unnamed.name is null or unnamed.slug is null)
            )
            and (
              select count(*) from findings as member indexed by findings_galaxy_id_idx
              where member.galaxy_id = galaxy.id
            ) >= ?`,
  });
  const row = typedRow<{ n: number }>(result.rows);

  return Number(row?.n ?? 0);
}

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

export async function getGalaxyLensPage(
  slug: string,
  limit: number,
  offset: number,
): Promise<{
  adjacent: GalaxyListItem[];
  findings: TrackListItem[];
  galaxy: GalaxyListItem;
} | null> {
  const named = await loadNamedGalaxyRows();

  if (!named.fullyNamed) {
    return null;
  }

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

export type GalaxyPane = GalaxyListItem & { covers: string[] };

export async function listGalaxyPanes(coverCap: number): Promise<GalaxyPane[]> {
  const named = await loadNamedGalaxyRows();

  if (!named.fullyNamed) {
    return [];
  }

  const panes = await Promise.all(
    named.rows.map(async (row) => {
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

async function loadNamedGalaxyRows(): Promise<{
  counts: Map<string, number>;
  fullyNamed: boolean;
  rows: GalaxyRow[];
}> {
  const db = await getDb();
  const [result, counts, gate] = await Promise.all([
    db.execute(
      `select ${GALAXY_COLUMNS} from galaxies where name is not null and slug is not null and retired_at is null`,
    ),
    memberCounts(db),
    db.execute(
      `select
         count(*) as total,
         sum(case when name is null or slug is null then 1 else 0 end) as unnamed
       from galaxies where retired_at is null`,
    ),
  ]);
  const gateRow = typedRow<{ total: number; unnamed: number | null }>(gate.rows);
  const fullyNamed =
    gateRow !== undefined && Number(gateRow.total) > 0 && Number(gateRow.unnamed ?? 0) === 0;

  return { counts, fullyNamed, rows: typedRows<GalaxyRow>(result.rows) };
}

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

function mintHandle(id: string, taken: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 10000; attempt += 1) {
    const candidate = galaxySlug(id, attempt);

    if (!taken.has(candidate)) {
      return candidate;
    }
  }

  return galaxySlug(id, Date.now());
}

export async function listTrackEmbeddingsPage(
  cursor: string | undefined,
  limit: number,
): Promise<{ embeddings: TrackEmbedding[]; nextCursor: string | null }> {
  const db = await getDb();
  const after = decodeCursor(cursor);
  const args: Array<number | string> = [];

  let where = "findings.log_id is not null";

  if (after) {
    where += " and tracks.track_id > ?";
    args.push(after);
  }

  args.push(limit + 1);
  const result = await db.execute({
    args,
    sql: `select emb.embedding_blob,
                 tracks.track_id,
                 findings.galaxy_id
          from findings
          join tracks on tracks.track_id = findings.track_id
          join track_embeddings emb on emb.track_id = tracks.track_id
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

function encodeCursor(trackId: string): string {
  return Buffer.from(trackId, "utf8").toString("base64url");
}

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
