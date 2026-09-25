import { $ } from "bun";
import { createClient, type Client, type Row } from "@libsql/client/web";

const CATALOGUE_PRUNE_DB_CONCURRENCY = 1;

export async function getDb(): Promise<Client> {
  let url = process.env.TURSO_DATABASE_URL;
  let authToken = process.env.TURSO_AUTH_TOKEN;

  let item = process.env.FLUNCLE_TURSO_OP_ITEM;
  if (item && !item.startsWith("op://")) {
    item = `op://${item}`;
  }
  if ((!url || !authToken) && item) {
    url = (await $`op read ${`${item}/TURSO_DATABASE_URL`}`.text()).trim();
    authToken = (await $`op read ${`${item}/TURSO_AUTH_TOKEN`}`.text()).trim();
  }
  if (!url) {
    throw new Error(
      "No prod creds. Export TURSO_DATABASE_URL/TURSO_AUTH_TOKEN, or set FLUNCLE_TURSO_OP_ITEM to the 1Password item (op must be unlocked).",
    );
  }
  return createClient(
    authToken
      ? { authToken, concurrency: CATALOGUE_PRUNE_DB_CONCURRENCY, url }
      : { concurrency: CATALOGUE_PRUNE_DB_CONCURRENCY, url },
  );
}

export const slugify = (s: string | null | undefined): string =>
  (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

export type Catalogue = {
  db: Client;
  enabledSlugs: Set<string>;
  disabledSlugs: Set<string>;
  labels: { id: string; slug: string; name: string; seed_state: string }[];
  tracks: {
    track_id: string;
    label: string | null;
    title: string | null;
    album_id: string | null;
  }[];
  trackById: Map<
    string,
    { track_id: string; label: string | null; title: string | null; album_id: string | null }
  >;
  edges: { artist_id: string; track_id: string }[];
  findingTrackIds: Set<string>;
  artists: { id: string; name: string; slug: string; spotify_url: string | null }[];
  artistById: Map<string, { id: string; name: string; slug: string; spotify_url: string | null }>;
  albumName: Map<string, string>;

  trackEnabled: (t: { label: string | null }) => boolean;

  trackDisabled: (t: { label: string | null }) => boolean;
};

export function rowString(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new TypeError(`Expected ${column} to be a string`);
  }

  return value;
}

function rowNullableString(row: Row, column: string): string | null {
  const value = row[column];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new TypeError(`Expected ${column} to be a string or null`);
  }

  return value;
}

export async function loadCatalogue(): Promise<Catalogue> {
  const db = await getDb();
  const rows = async (sql: string): Promise<Row[]> => (await db.execute(sql)).rows;
  const labels = (await rows(`select id, slug, name, seed_state from labels`)).map((row) => ({
    id: rowString(row, "id"),
    name: rowString(row, "name"),
    seed_state: rowString(row, "seed_state"),
    slug: rowString(row, "slug"),
  }));
  const enabledSlugs = new Set(labels.filter((l) => l.seed_state === "enabled").map((l) => l.slug));
  const disabledSlugs = new Set(
    labels.filter((l) => l.seed_state === "disabled").map((l) => l.slug),
  );
  const tracks = (await rows(`select track_id, label, title, album_id from tracks`)).map((row) => ({
    album_id: rowNullableString(row, "album_id"),
    label: rowNullableString(row, "label"),
    title: rowNullableString(row, "title"),
    track_id: rowString(row, "track_id"),
  }));
  const trackById = new Map(tracks.map((t) => [t.track_id, t]));
  const edges = (await rows(`select artist_id, track_id from track_artists`)).map((row) => ({
    artist_id: rowString(row, "artist_id"),
    track_id: rowString(row, "track_id"),
  }));
  const findingTrackIds = new Set(
    (await rows(`select track_id from findings`)).map((row) => rowString(row, "track_id")),
  );
  const artists = (await rows(`select id, name, slug, spotify_url from artists`)).map((row) => ({
    id: rowString(row, "id"),
    name: rowString(row, "name"),
    slug: rowString(row, "slug"),
    spotify_url: rowNullableString(row, "spotify_url"),
  }));
  const artistById = new Map(artists.map((a) => [a.id, a]));
  const albumName = new Map(
    (await rows(`select id, name from albums`)).map((row) => [
      rowString(row, "id"),
      rowString(row, "name"),
    ]),
  );
  return {
    albumName,
    artistById,
    artists,
    db,
    disabledSlugs,
    edges,
    enabledSlugs,
    findingTrackIds,
    labels,
    trackById,
    trackDisabled: (t) => Boolean(t.label && disabledSlugs.has(slugify(t.label))),
    trackEnabled: (t) => Boolean(t.label && enabledSlugs.has(slugify(t.label))),
    tracks,
  };
}

export type ArtistAgg = {
  hasFinding: boolean;
  enabled: number;
  disabled: number;
  off: number;
  total: number;
};

export function aggregateArtists(cat: Catalogue): Map<string, ArtistAgg> {
  const agg = new Map<string, ArtistAgg>();
  for (const e of cat.edges) {
    const t = cat.trackById.get(e.track_id);
    if (!t) {
      continue;
    }
    let a = agg.get(e.artist_id);
    if (!a) {
      agg.set(e.artist_id, (a = { disabled: 0, enabled: 0, hasFinding: false, off: 0, total: 0 }));
    }
    a.total++;
    if (cat.findingTrackIds.has(e.track_id)) {
      a.hasFinding = true;
    }
    if (cat.trackEnabled(t)) {
      a.enabled++;
    } else {
      a.off++;
      if (cat.trackDisabled(t)) {
        a.disabled++;
      }
    }
  }
  return agg;
}

export function safePurgeArtists(cat: Catalogue, agg = aggregateArtists(cat)): Set<string> {
  const out = new Set<string>();
  for (const [id, a] of agg) {
    if (!a.hasFinding && a.enabled === 0 && a.disabled > 0) {
      out.add(id);
    }
  }
  return out;
}

export type NamedArtistResolution = {
  found: { id: string; name: string; slug: string }[];
  unknownSlugs: string[];
  withFindings: { id: string; name: string; slug: string; trackIds: string[] }[];
};

export function resolveNamedArtists(cat: Catalogue, slugs: string[]): NamedArtistResolution {
  const bySlug = new Map(cat.artists.map((a) => [a.slug, a]));
  const found: NamedArtistResolution["found"] = [];
  const unknownSlugs: string[] = [];

  for (const slug of slugs) {
    const artist = bySlug.get(slug);
    if (artist) {
      found.push({ id: artist.id, name: artist.name, slug: artist.slug });
    } else {
      unknownSlugs.push(slug);
    }
  }

  const findingTracksByArtist = new Map<string, string[]>();
  const ids = new Set(found.map((a) => a.id));
  for (const e of cat.edges) {
    if (ids.has(e.artist_id) && cat.findingTrackIds.has(e.track_id)) {
      getOrSet(findingTracksByArtist, e.artist_id, () => [] as string[]).push(e.track_id);
    }
  }

  return {
    found,
    unknownSlugs,
    withFindings: found
      .filter((a) => findingTracksByArtist.has(a.id))
      .map((a) => ({ ...a, trackIds: findingTracksByArtist.get(a.id) ?? [] })),
  };
}

export function trackArtistIndex(cat: Catalogue): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const e of cat.edges) {
    getOrSet(index, e.track_id, () => new Set<string>()).add(e.artist_id);
  }

  return index;
}

export function tracksCreditedOnlyTo(
  cat: Catalogue,
  artistIds: ReadonlySet<string>,
  index = trackArtistIndex(cat),
): Set<string> {
  const out = new Set<string>();
  for (const [trackId, credited] of index) {
    if (!cat.findingTrackIds.has(trackId) && [...credited].every((a) => artistIds.has(a))) {
      out.add(trackId);
    }
  }

  return out;
}

export function orphanAlbums(cat: Catalogue, trackIds: ReadonlySet<string>): Set<string> {
  const albumTracks = new Map<string, string[]>();
  for (const t of cat.tracks) {
    if (t.album_id) {
      getOrSet(albumTracks, t.album_id, () => [] as string[]).push(t.track_id);
    }
  }
  const out = new Set<string>();
  for (const [albumId, tids] of albumTracks) {
    if (tids.every((tid) => trackIds.has(tid))) {
      out.add(albumId);
    }
  }

  return out;
}

export function labelsByArtist(
  cat: Catalogue,
  artistIds: ReadonlySet<string>,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const e of cat.edges) {
    if (!artistIds.has(e.artist_id)) {
      continue;
    }
    const t = cat.trackById.get(e.track_id);
    if (t?.label) {
      getOrSet(out, e.artist_id, () => new Set<string>()).add(t.label);
    }
  }

  return out;
}

export function getOrSet<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  let v = map.get(key);
  if (v === undefined) {
    v = make();
    map.set(key, v);
  }
  return v;
}

export function chunk<T>(a: T[], n = 200): T[][] {
  const o: T[][] = [];
  for (let i = 0; i < a.length; i += n) {
    o.push(a.slice(i, i + n));
  }
  return o;
}

export const orphanEdgeWhere = (alias: string): string =>
  `not exists (select 1 from tracks t where t.track_id = ${alias}.track_id)`;

export const ORPHAN_EDGE_COUNT_SQL = `select count(*) as n from track_artists ta where ${orphanEdgeWhere("ta")}`;

export const ORPHAN_EDGE_BY_ARTIST_SQL = `select ta.artist_id as artist_id,
       coalesce(a.name, '(artist row gone)') as name,
       coalesce(a.slug, '') as slug,
       count(*) as edges
  from track_artists ta
  left join artists a on a.id = ta.artist_id
 where ${orphanEdgeWhere("ta")}
 group by ta.artist_id
 order by edges desc, name`;

export const ORPHAN_EDGE_ROWS_SQL = `select ta.* from track_artists ta where ${orphanEdgeWhere("ta")}`;

export const ORPHAN_EDGE_DELETE_SQL = `delete from track_artists where ${orphanEdgeWhere("track_artists")}`;

export async function deleteTracksWithEdges(
  db: Client,
  trackIds: string[],
): Promise<{ edges: number; tracks: number }> {
  let edges = 0;
  let tracks = 0;
  for (const c of chunk(trackIds)) {
    const holes = c.map(() => "?").join(",");
    const [edgeResult, , trackResult] = await db.batch(
      [
        { args: c, sql: `delete from track_artists where track_id in (${holes})` },
        { args: c, sql: `delete from track_embeddings where track_id in (${holes})` },
        { args: c, sql: `delete from tracks where track_id in (${holes})` },
      ],
      "write",
    );
    edges += Number(edgeResult?.rowsAffected ?? 0);
    tracks += Number(trackResult?.rowsAffected ?? 0);
  }
  return { edges, tracks };
}

export const ENTANGLEMENT_TABLES = [
  "mixtape_tracks",
  "user_saved_findings",
  "social_posts",
  "social_metrics",
  "frontier_edition_tracks",
  "user_galaxy_collections",
  "user_rec_seeds",
  "note_rejections",
  "observation_rejections",
];

export const CASCADE_TRACK_TABLES = ["cost_events"];

export async function countTrackRefs(
  db: Client,
  table: string,
  trackIds: ReadonlySet<string>,
): Promise<number> {
  const result = await db.execute(`select track_id from ${table}`);

  return result.rows.filter((r) => typeof r.track_id === "string" && trackIds.has(r.track_id))
    .length;
}

export async function entanglementHits(
  db: Client,
  trackIds: ReadonlySet<string>,
): Promise<{ hits: number; table: string }[]> {
  const out: { hits: number; table: string }[] = [];
  for (const table of ENTANGLEMENT_TABLES) {
    const hits = await countTrackRefs(db, table, trackIds);
    if (hits > 0) {
      out.push({ hits, table });
    }
  }

  return out;
}

export async function selectAllIn(
  db: Client,
  table: string,
  col: string,
  ids: string[],
): Promise<Row[]> {
  const out: Row[] = [];
  for (const c of chunk(ids)) {
    const result = await db.execute({
      args: c,
      sql: `select * from ${table} where ${col} in (${c.map(() => "?").join(",")})`,
    });
    out.push(...result.rows);
  }

  return out;
}

export async function deleteIn(
  db: Client,
  table: string,
  col: string,
  ids: string[],
): Promise<number> {
  let n = 0;
  for (const c of chunk(ids)) {
    const result = await db.execute({
      args: c,
      sql: `delete from ${table} where ${col} in (${c.map(() => "?").join(",")})`,
    });
    n += Number(result.rowsAffected);
  }

  return n;
}

export type ArtistCascadeRollback = {
  albums: Row[];
  artist_aliases: Row[];
  artist_socials: Row[];
  artists: Row[];
  at: string;
  cost_events: Row[];
  track_artists: Row[];
  tracks: Row[];
};

export async function captureArtistCascadeRollback(
  db: Client,
  artistIds: string[],
  trackIds: string[],
  albumIds: string[],
): Promise<ArtistCascadeRollback> {
  const seenEdges = new Set<string>();
  const track_artists = [
    ...(await selectAllIn(db, "track_artists", "artist_id", artistIds)),
    ...(await selectAllIn(db, "track_artists", "track_id", trackIds)),
  ].filter((row) => {
    const key = JSON.stringify([row.artist_id, row.track_id]);
    if (seenEdges.has(key)) {
      return false;
    }
    seenEdges.add(key);

    return true;
  });

  return {
    albums: await selectAllIn(db, "albums", "id", albumIds),
    artist_aliases: await selectAllIn(db, "artist_aliases", "artist_id", artistIds),
    artist_socials: await selectAllIn(db, "artist_socials", "artist_id", artistIds),
    artists: await selectAllIn(db, "artists", "id", artistIds),
    at: new Date().toISOString(),
    cost_events: await selectAllIn(db, "cost_events", "track_id", trackIds),
    track_artists,
    tracks: await selectAllIn(db, "tracks", "track_id", trackIds),
  };
}

export async function deleteArtistCascade(
  db: Client,
  artistIds: string[],
  trackIds: string[],
  albumIds: string[],
): Promise<void> {
  const del = async (table: string, col: string, ids: string[]) => {
    console.log(`  deleted ${table}.${col}: ${await deleteIn(db, table, col, ids)}`);
  };
  await del("cost_events", "track_id", trackIds);
  await del("artist_socials", "artist_id", artistIds);
  await del("artist_aliases", "artist_id", artistIds);
  await del("artist_centroids", "artist_id", artistIds);
  await del("artist_similar", "artist_id", artistIds);
  await del("artist_similar", "neighbour_artist_id", artistIds);
  await del("track_artists", "artist_id", artistIds);
  const removed = await deleteTracksWithEdges(db, trackIds);
  console.log(`  deleted track_artists.track_id: ${removed.edges}`);
  console.log(`  deleted tracks.track_id: ${removed.tracks}`);
  await del("albums", "id", albumIds);
  await del("artists", "id", artistIds);
}
