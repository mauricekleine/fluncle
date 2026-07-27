// Shared helpers for the catalogue off-genre pruning scripts.
//
// CREDENTIALS (public-repo safe — no vault path is hardcoded):
//   - If TURSO_DATABASE_URL / TURSO_AUTH_TOKEN are in the environment, they are used directly.
//   - Otherwise, set FLUNCLE_TURSO_OP_ITEM to the 1Password item that holds the prod Turso
//     credentials (e.g. `op://<vault>/<item>`) and this reads them via `op` at run time.
//     This mirrors apps/web/scripts/db-pull-prod.ts. `op` must be unlocked (biometric).
//
// RUN FROM THE REPO ROOT (`@libsql/client` is hoisted to the root node_modules), e.g.
//   FLUNCLE_TURSO_OP_ITEM='op://<vault>/<item>' \
//     bun run packages/skills/fluncle-catalogue-prune/scripts/scan.ts
import { $ } from "bun";
import { createClient, type Client } from "@libsql/client/web";

export async function getDb(): Promise<Client> {
  let url = process.env.TURSO_DATABASE_URL;
  let authToken = process.env.TURSO_AUTH_TOKEN;
  // Accept the item with or without the `op://` scheme — shells often export the bare path.
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
  return createClient(authToken ? { authToken, url } : { url });
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
  /** True when the track's label is an enabled (approved DnB seed) label. */
  trackEnabled: (t: { label: string | null }) => boolean;
  /** True when the track's label is an operator-DISABLED label. */
  trackDisabled: (t: { label: string | null }) => boolean;
};

/** Load the whole catalogue into memory once. Everything the scripts need derives from this. */
export async function loadCatalogue(): Promise<Catalogue> {
  const db = await getDb();
  const rows = async (sql: string) => (await db.execute(sql)).rows as any[];
  const labels = (await rows(
    `select id, slug, name, seed_state from labels`,
  )) as Catalogue["labels"];
  const enabledSlugs = new Set(labels.filter((l) => l.seed_state === "enabled").map((l) => l.slug));
  const disabledSlugs = new Set(
    labels.filter((l) => l.seed_state === "disabled").map((l) => l.slug),
  );
  const tracks = (await rows(
    `select track_id, label, title, album_id from tracks`,
  )) as Catalogue["tracks"];
  const trackById = new Map(tracks.map((t) => [t.track_id, t]));
  const edges = (await rows(`select artist_id, track_id from track_artists`)) as Catalogue["edges"];
  const findingTrackIds = new Set(
    (await rows(`select track_id from findings`)).map((f) => f.track_id),
  );
  const artists = (await rows(
    `select id, name, slug, spotify_url from artists`,
  )) as Catalogue["artists"];
  const artistById = new Map(artists.map((a) => [a.id, a]));
  const albumName = new Map(
    (await rows(`select id, name from albums`)).map((a) => [a.id, a.name as string]),
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

/** Per-artist rollup used by the buckets + purge. `disabled` = tracks on operator-DISABLED labels. */
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

/**
 * A SAFE-PURGE artist: no finding, no enabled-label track, AND at least one track on a label the
 * operator has EXPLICITLY DISABLED. That last clause is the safety: it means the operator has ruled
 * this artist's presence off-genre — so a metadata gap can't get an artist deleted. An artist whose
 * only tracks are on UNDECIDED or NO-label rows is NOT swept in (they surface for a label ruling
 * instead). An artist with even one enabled-label track is PROTECTED. Deleting a safe-purge artist
 * removes their page + the tracks credited ONLY to them; shared/collab tracks survive.
 */
export function safePurgeArtists(cat: Catalogue, agg = aggregateArtists(cat)): Set<string> {
  const out = new Set<string>();
  for (const [id, a] of agg) {
    if (!a.hasFinding && a.enabled === 0 && a.disabled > 0) {
      out.add(id);
    }
  }
  return out;
}

/** Get a map entry, creating it with `make()` if absent. Avoids non-null assertions. */
export function getOrSet<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  let v = map.get(key);
  if (v === undefined) {
    v = make();
    map.set(key, v);
  }
  return v;
}

/** chunk an array for batched SQL (SQLite IN() limit is ~999). */
export function chunk<T>(a: T[], n = 200): T[][] {
  const o: T[][] = [];
  for (let i = 0; i < a.length; i += n) {
    o.push(a.slice(i, i + n));
  }
  return o;
}

// ── track_artists: the edges die WITH their tracks ──────────────────────────────
//
// `track_artists` is the only table that references `tracks.track_id` and is not either
// protected by the purge's entanglement guard or swept by the artist cascade. Deleting a track
// without its edge leaves an ORPHANED EDGE: a row pointing at a track that no longer exists.
// Production carried 62 of them across 36 artists (measured 2026-07-26), left by out-of-band
// track deletion before this shape existed.
//
// Keying the edge delete by `artist_id` is NOT enough on its own. It only covers the artists
// this run happens to be deleting, so any edge written by another path — the crawler running
// while a purge is mid-flight is the live one — survives its track. So the delete is keyed by
// `track_id`, over the SAME id set as the track delete, and both statements ride ONE
// `batch(…, "write")` transaction: either the track and its edges go together or neither does.
// There is no window in which the track is gone and the edge remains.

/** The orphan predicate: an edge whose `track_id` has no `tracks` row. */
export const orphanEdgeWhere = (alias: string): string =>
  `not exists (select 1 from tracks t where t.track_id = ${alias}.track_id)`;

/** Count every orphaned `track_artists` edge. */
export const ORPHAN_EDGE_COUNT_SQL = `select count(*) as n from track_artists ta where ${orphanEdgeWhere("ta")}`;

/** Orphaned edges grouped by artist — the per-artist breakdown the cleanup dry-run prints. */
export const ORPHAN_EDGE_BY_ARTIST_SQL = `select ta.artist_id as artist_id,
       coalesce(a.name, '(artist row gone)') as name,
       coalesce(a.slug, '') as slug,
       count(*) as edges
  from track_artists ta
  left join artists a on a.id = ta.artist_id
 where ${orphanEdgeWhere("ta")}
 group by ta.artist_id
 order by edges desc, name`;

/** The full orphaned rows, captured for the rollback before they are deleted. */
export const ORPHAN_EDGE_ROWS_SQL = `select ta.* from track_artists ta where ${orphanEdgeWhere("ta")}`;

/**
 * Delete every orphaned edge. Unaliased on purpose — `delete from <table> as <alias>` is
 * accepted by SQLite but not by every libSQL path, and the predicate reads the same either way.
 */
export const ORPHAN_EDGE_DELETE_SQL = `delete from track_artists where ${orphanEdgeWhere("track_artists")}`;

/**
 * Delete tracks AND their `track_artists` edges, chunk by chunk, each chunk atomic.
 *
 * Edges first, tracks second, inside one `batch(…, "write")` — see the note above. Returns the
 * rows removed from each table so the caller can report both.
 */
export async function deleteTracksWithEdges(
  db: Client,
  trackIds: string[],
): Promise<{ edges: number; tracks: number }> {
  let edges = 0;
  let tracks = 0;
  for (const c of chunk(trackIds)) {
    const holes = c.map(() => "?").join(",");
    const [edgeResult, trackResult] = await db.batch(
      [
        { args: c, sql: `delete from track_artists where track_id in (${holes})` },
        { args: c, sql: `delete from tracks where track_id in (${holes})` },
      ],
      "write",
    );
    edges += Number(edgeResult?.rowsAffected ?? 0);
    tracks += Number(trackResult?.rowsAffected ?? 0);
  }
  return { edges, tracks };
}
