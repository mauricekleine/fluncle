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
  const item = process.env.FLUNCLE_TURSO_OP_ITEM;
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

/** Per-artist rollup used by the buckets + purge. */
export type ArtistAgg = { hasFinding: boolean; enabled: number; off: number; total: number };

export function aggregateArtists(cat: Catalogue): Map<string, ArtistAgg> {
  const agg = new Map<string, ArtistAgg>();
  for (const e of cat.edges) {
    const t = cat.trackById.get(e.track_id);
    if (!t) {
      continue;
    }
    let a = agg.get(e.artist_id);
    if (!a) {
      agg.set(e.artist_id, (a = { enabled: 0, hasFinding: false, off: 0, total: 0 }));
    }
    a.total++;
    if (cat.findingTrackIds.has(e.track_id)) {
      a.hasFinding = true;
    }
    if (cat.trackEnabled(t)) {
      a.enabled++;
    } else {
      a.off++;
    }
  }
  return agg;
}

/**
 * A SAFE-PURGE artist: no finding AND no enabled-label track. Their entire Fluncle presence is
 * off-boundary, so deleting them (and the tracks credited ONLY to them) removes off-genre pages
 * without touching any DnB act. An artist with even one enabled-label track is PROTECTED.
 */
export function safePurgeArtists(cat: Catalogue, agg = aggregateArtists(cat)): Set<string> {
  const out = new Set<string>();
  for (const [id, a] of agg) {
    if (!a.hasFinding && a.enabled === 0) {
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
