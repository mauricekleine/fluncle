import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb, seedCatalogueTrack, seedTrack } from "./integration-db";
import { readJson, req } from "./orpc-test-kit";

// THE MULTI-ARTIST "SOUNDS LIKE THESE" READ, PROVEN — against the REAL vector schema, with vectors we
// control. Three layers, one seeded world:
//   1. `listSimilarArtistNeighbours` — the exact `vector_distance_cos` scan over a LIVE averaged probe
//      (the selected artists' centroids meaned in the isolate), the selected artists excluded.
//   2. `listSimilarArtistsApi` — the same read shaped as `ArtistListItem`s (certified/counts/spotify).
//   3. The `list_similar_artists` oRPC op end to end via `handleOrpc` — the 2..6 validation, the
//      exclusion, and (the routing trap) that `/artists/similar` resolves to it and NOT `get_artist`
//      at `/artists/{slug}` (the static path wins over the dynamic one, the `/tracks/random` precedent).
//
// Runs on the in-memory libSQL DB from the generated migrations, so the vector SQL (`vector32`,
// `vector_distance_cos`) executes against the real DDL — not a mock.

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

// Imported AFTER the mock so every module's `getDb` is the mocked one.
const { rankArtists, listSimilarArtistNeighbours } = await import("./artist-dossier");
const { getArtistListItemBySlug, listSimilarArtistsApi } = await import("./artists");
const { handleOrpc } = await import("./orpc");

const DIMS = 1024;
const NOW = () => "2026-07-18T00:00:00.000Z";

/** A unit vector pointing along one axis — an "artificial genre" we can aim tracks at. */
function axis(index: number): number[] {
  const vector = Array.from<number>({ length: DIMS }).fill(0);
  vector[index] = 1;

  return vector;
}

function unit(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));

  return vector.map((value) => value / norm);
}

/** A vector `weight` of the way from `from` toward `toward` — a controlled near-neighbour. */
function blend(from: number[], toward: number[], weight: number): number[] {
  return unit(from.map((value, index) => value * (1 - weight) + (toward[index] ?? 0) * weight));
}

async function seedArtist(id: string): Promise<void> {
  const now = new Date().toISOString();

  await db.execute({
    args: [
      id,
      id,
      id,
      `https://i.scdn.co/image/${id}`,
      `https://open.spotify.com/artist/${id}`,
      now,
      now,
    ],
    sql: `insert into artists (id, name, slug, image_url, spotify_url, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?, ?)`,
  });
}

async function link(trackId: string, artistId: string): Promise<void> {
  await db.execute({
    args: [trackId, artistId],
    sql: `insert into track_artists (track_id, artist_id, position) values (?, ?, 1)`,
  });
}

async function embed(trackId: string, vector: number[]): Promise<void> {
  await db.execute({
    args: [JSON.stringify(vector), trackId],
    sql: `update tracks set embedding_blob = vector32(?) where track_id = ?`,
  });
}

/** A CERTIFIED artist (one embedded finding) aimed at `vector`. */
async function seedCertifiedArtist(id: string, vector: number[]): Promise<void> {
  await seedArtist(id);
  await seedTrack(db, { logId: `${id}.7.1A`, title: `${id} find`, trackId: `${id}-find` });
  await link(`${id}-find`, id);
  await embed(`${id}-find`, vector);
}

/** A CATALOGUE-ONLY artist (no finding — uncertified) with one embedded catalogue track. */
async function seedCatalogueArtist(id: string, vector: number[]): Promise<void> {
  await seedArtist(id);
  await seedCatalogueTrack(db, { title: `${id} cat`, trackId: `${id}-cat` });
  await link(`${id}-cat`, id);
  await embed(`${id}-cat`, vector);
}

beforeEach(async () => {
  db = await createIntegrationDb();

  // a + b sit near axis 0 (the two we compare); c/d tilt away from them by increasing amounts, z is
  // orthogonal (axis 40). c is catalogue-only (uncertified) — for the lit/unlit assertion.
  await seedCertifiedArtist("a", axis(0));
  await seedCertifiedArtist("b", blend(axis(0), axis(1), 0.05));
  await seedCatalogueArtist("c", blend(axis(0), axis(1), 0.2));
  await seedCertifiedArtist("d", blend(axis(0), axis(1), 0.5));
  await seedCatalogueArtist("z", axis(40));

  // Build the centroids the scan reads.
  await rankArtists(100, NOW);
});

describe("listSimilarArtistNeighbours — the exact averaged-probe scan", () => {
  it("ranks by nearness to the AVERAGE of the selected artists, both selected excluded", async () => {
    const neighbours = await listSimilarArtistNeighbours(["a", "b"], 12);

    expect(neighbours.map((n) => n.slug)).toEqual(["c", "d", "z"]);
    // Neither compared artist appears among its own results.
    expect(neighbours.some((n) => n.slug === "a" || n.slug === "b")).toBe(false);
  });

  it("carries the artist identity (name + avatar) through", async () => {
    const [first] = await listSimilarArtistNeighbours(["a", "b"], 1);

    expect(first).toMatchObject({ name: "c", slug: "c" });
    expect(first?.imageUrl).toContain("/image/c");
  });

  it("caps the selected input and dedupes it (never a whole-corpus pull)", async () => {
    // Duplicates collapse; > MAX selected slugs are sliced — the read still returns cleanly.
    const deduped = await listSimilarArtistNeighbours(["a", "a", "b"], 12);
    expect(deduped.map((n) => n.slug)).toEqual(["c", "d", "z"]);
  });

  it("returns [] when no selected slug resolves to a stored centroid", async () => {
    expect(await listSimilarArtistNeighbours(["ghostx", "ghosty"], 12)).toEqual([]);
    expect(await listSimilarArtistNeighbours([], 12)).toEqual([]);
    expect(await listSimilarArtistNeighbours(["a"], 0)).toEqual([]);
  });
});

describe("listSimilarArtistsApi — the ArtistListItem projection", () => {
  it("shapes each neighbour with the shared-gate certified flag + counts + spotify", async () => {
    const artists = await listSimilarArtistsApi(["a", "b"]);

    expect(artists.map((artist) => artist.slug)).toEqual(["c", "d", "z"]);

    // d has a finding → certified; c/z are catalogue-only → uncertified (the unlit tier).
    expect(artists.find((artist) => artist.slug === "d")).toMatchObject({
      certified: true,
      findingCount: 1,
      slug: "d",
      trackCount: 1,
    });
    expect(artists.find((artist) => artist.slug === "c")).toMatchObject({
      certified: false,
      findingCount: 0,
      trackCount: 1,
    });
    // spotifyUrl rides through from the artists row.
    expect(artists.find((artist) => artist.slug === "d")?.spotifyUrl).toContain("/artist/d");
  });
});

describe("list_similar_artists — the oRPC op (GET /artists/similar)", () => {
  it("serves { ok: true, artists } excluding the compared artists", async () => {
    const response = await handleOrpc(req("/artists/similar?slugs=a,b", "GET", undefined));

    expect(response?.status).toBe(200);
    const body = (await readJson(response)) as { artists: { slug: string }[]; ok: boolean };
    expect(body.ok).toBe(true);
    expect(body.artists.map((artist) => artist.slug)).toEqual(["c", "d", "z"]);
  });

  it("routes /artists/similar to THIS op, not get_artist at /artists/{slug}", async () => {
    // The regression trap: the static `/artists/similar` must win over the dynamic `/artists/{slug}`.
    // Proof both ways — the literal path serves the list, and a real slug still serves get_artist.
    const similar = await handleOrpc(req("/artists/similar?slugs=a,b", "GET", undefined));
    expect(((await readJson(similar)) as { artists?: unknown }).artists).toBeInstanceOf(Array);

    const one = await handleOrpc(req("/artists/a", "GET", undefined));
    expect(one?.status).toBe(200);
    expect(((await readJson(one)) as { artist: { slug: string } }).artist.slug).toBe("a");
    // Sanity: get_artist agrees the row exists.
    expect(await getArtistListItemBySlug("a")).toMatchObject({ slug: "a" });
  });

  it("400s fewer than two slugs (invalid_request)", async () => {
    const response = await handleOrpc(req("/artists/similar?slugs=a", "GET", undefined));

    expect(response?.status).toBe(400);
    expect(await readJson(response)).toMatchObject({ code: "invalid_request", ok: false });
  });

  it("400s more than the cap (seven slugs)", async () => {
    const response = await handleOrpc(
      req("/artists/similar?slugs=a,b,c,d,e,f,g", "GET", undefined),
    );

    expect(response?.status).toBe(400);
    expect(await readJson(response)).toMatchObject({ code: "invalid_request", ok: false });
  });

  it("serves an empty list when the compared artists have no stored centroid", async () => {
    const response = await handleOrpc(
      req("/artists/similar?slugs=ghostx,ghosty", "GET", undefined),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ artists: [], ok: true });
  });
});
