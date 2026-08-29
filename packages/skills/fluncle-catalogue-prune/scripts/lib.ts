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

/** The pruning helper performs its remote maintenance work serially. */
const CATALOGUE_PRUNE_DB_CONCURRENCY = 1;

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

/**
 * The NAMED-ARTIST variant of the same question, for the targeted namesake purge.
 *
 * `safePurgeArtists` derives its set from label rulings; this one takes the set the OPERATOR
 * typed. Same downstream cascade, different way of arriving at the artist ids — which is the
 * whole point of the targeted tool: when a label ruling is RIGHT and the tracks under it belong
 * to a same-named impostor, no label-level signal can express "these specific artists".
 *
 * Returns the resolved artists plus the two refusals the caller must abort on: slugs with no
 * `artists` row, and named artists carrying a `findings` track (Maurice's real work — untouchable,
 * and a hard abort rather than a skip, because a findings hit means the operator's list is wrong).
 */
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

/** `track_id` → the set of artist ids credited on it. The shared-credit index. */
export function trackArtistIndex(cat: Catalogue): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const e of cat.edges) {
    getOrSet(index, e.track_id, () => new Set<string>()).add(e.artist_id);
  }

  return index;
}

/**
 * THE SHARED-CREDIT SURVIVAL RULE. A track is deletable only when EVERY artist credited on it is
 * in `artistIds` — one collaborator outside the set and the track survives, because deleting it
 * would silently strip a track from an artist nobody ruled on. Findings are excluded by
 * construction, belt-and-braces, in both purge paths.
 *
 * A track with no `track_artists` edge at all is never deletable: it is not reachable from any
 * artist, so an artist-driven purge has no claim on it.
 */
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

/** Albums losing their LAST track — every track on them is in `trackIds`, so the album goes too. */
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

/** Per-artist: the distinct raw `tracks.label` strings the artist's tracks sit on. The eyeball. */
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
 *
 * The `track_embeddings` row goes first for the same reason the edges do. It carries a real
 * `on delete cascade` foreign key (the only one in the track schema), so this delete is belt AND
 * braces: the cascade fires only when `PRAGMA foreign_keys` is on, and a leftover vector is not
 * merely untidy — it is a vector the ranking can still reach for a track that no longer exists.
 */
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

// ── The artist cascade, shared by both purge paths ──────────────────────────────
//
// `purge.ts` (label-driven) and `purge-artists.ts` (operator-named) arrive at their artist set
// differently and delete IDENTICALLY. That sameness is safety, not tidiness: the guard list, the
// rollback shape, and the FK-safe delete order are the parts a second tool would get subtly wrong.
// They live here once so there is exactly one cascade in this skill.

/**
 * THE ENTANGLEMENT GUARD's tables. A deletable track appearing in any of them is a REAL object a
 * human put it in — a mixtape, a listener's save, a published post, a frontier edition. That is a
 * surprise the operator resolves by hand; a purge aborts rather than deleting through it.
 */
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

/** Housekeeping track-refs the cascade simply deletes (never real objects). */
export const CASCADE_TRACK_TABLES = ["cost_events"];

/** How many rows of `table` reference one of `trackIds`. */
export async function countTrackRefs(
  db: Client,
  table: string,
  trackIds: ReadonlySet<string>,
): Promise<number> {
  const result = await db.execute(`select track_id from ${table}`);

  return result.rows.filter((r) => typeof r.track_id === "string" && trackIds.has(r.track_id))
    .length;
}

/** Every guard table holding at least one deletable track. Empty ⇒ the purge may proceed. */
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

/** `select *` of every row matching `col in (ids)`, chunked past the SQLite IN() limit. */
export async function selectAllIn(
  db: Client,
  table: string,
  col: string,
  ids: string[],
): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const c of chunk(ids)) {
    const result = await db.execute({
      args: c,
      sql: `select * from ${table} where ${col} in (${c.map(() => "?").join(",")})`,
    });
    out.push(...result.rows);
  }

  return out;
}

/** Delete every row matching `col in (ids)`, chunked. Returns the rows removed. */
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
  albums: unknown[];
  artist_aliases: unknown[];
  artist_socials: unknown[];
  artists: unknown[];
  at: string;
  cost_events: unknown[];
  track_artists: unknown[];
  tracks: unknown[];
};

/**
 * The full per-row rollback, captured BEFORE anything is deleted.
 *
 * The edge delete runs on BOTH keys, so the rollback captures both and de-dupes on the composite
 * key — otherwise restoring would double-insert every edge that matches on artist AND track.
 */
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
    const r = row as { artist_id?: unknown; track_id?: unknown };
    const key = JSON.stringify([r.artist_id, r.track_id]);
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

/**
 * Delete the artists, their tracks, and the whole cascade in FK-safe order (children → parents).
 *
 * `track_artists` is deleted TWICE on purpose, on two different keys. By `artist_id` it clears the
 * purged artists' edges on tracks that SURVIVE (a shared/collab track is never deletable, so its
 * edge to a deleted artist has to go this way or the `artists` delete strands it). By `track_id` —
 * inside `deleteTracksWithEdges` — it kills the deletable tracks' edges in the SAME transaction as
 * the tracks, so no orphaned edge can survive the purge.
 */
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
