import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb, seedCatalogueTrack, seedTrack } from "./integration-db";

// THE SIMILAR-ARTISTS ENGINE, PROVEN — against the REAL schema, with vectors we control.
//
// The `rank_artists` sweep folds each artist's embedded tracks (findings AND catalogue) into a
// stored centroid, then re-ranks its top-K nearest neighbours IN SQL (`vector_distance_cos` over
// `artist_centroids`). None of that can be checked by reading it, so these cases seed artists whose
// tracks aim at known axes, run the sweep, and assert the centroids, the edges, the `certified`
// tier, the bounded tick, the fingerprint staleness, the orphan purge, and determinism.
//
// Runs on the in-memory libSQL database built from the generated migrations, so the vector SQL
// under test (`vector32`, `vector_distance_cos`) executes against the real DDL — not a mock.

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

// Imported AFTER the mock so the module's `getDb` is the mocked one.
const { getArtistNeighbours, rankArtists } = await import("./artist-dossier");

const DIMS = 1024;
const NOW = () => "2026-07-18T00:00:00.000Z";

/** A unit vector pointing along one axis — an "artificial genre" we can aim tracks at. */
function axis(index: number): number[] {
  const vector = Array.from<number>({ length: DIMS }).fill(0);
  vector[index] = 1;

  return vector;
}

/** Normalize, so every fixture vector is unit-length like a real MuQ vector. */
function unit(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));

  return vector.map((value) => value / norm);
}

/** A vector `weight` of the way from `from` toward `toward` — a controlled near-neighbour. */
function blend(from: number[], toward: number[], weight: number): number[] {
  return unit(from.map((value, index) => value * (1 - weight) + (toward[index] ?? 0) * weight));
}

/** Insert one artist (only the columns the sweep + read touch). */
async function seedArtist(id: string, name: string): Promise<void> {
  const now = new Date().toISOString();

  await db.execute({
    args: [id, name, id, `https://i.scdn.co/image/${id}`, now, now],
    sql: `insert into artists (id, name, slug, image_url, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?)`,
  });
}

/** Link a track to an artist (position 1, lead). */
async function link(trackId: string, artistId: string): Promise<void> {
  await db.execute({
    args: [trackId, artistId],
    sql: `insert into track_artists (track_id, artist_id, position) values (?, ?, 1)`,
  });
}

/** The write the agent-tier `update_track` path performs: validated JSON → ranked F32_BLOB. */
async function embed(trackId: string, vector: number[]): Promise<void> {
  await db.execute({
    args: [JSON.stringify(vector), trackId],
    sql: `update tracks set embedding_blob = vector32(?) where track_id = ?`,
  });
}

/**
 * Seed an artist with one embedded FINDING (certified) aimed at `vector`. `catalogueVector`, when
 * given, adds a second embedded CATALOGUE track under the same artist — so the centroid is the mean
 * over a findings+catalogue mix.
 */
async function seedCertifiedArtist(
  id: string,
  vector: number[],
  catalogueVector?: number[],
): Promise<void> {
  await seedArtist(id, id);
  await seedTrack(db, { logId: `${id}.7.1A`, title: `${id} find`, trackId: `${id}-find` });
  await link(`${id}-find`, id);
  await embed(`${id}-find`, vector);

  if (catalogueVector) {
    await seedCatalogueTrack(db, { title: `${id} cat`, trackId: `${id}-cat` });
    await link(`${id}-cat`, id);
    await embed(`${id}-cat`, catalogueVector);
  }
}

/** Seed a CATALOGUE-ONLY artist (no finding — uncertified) with one embedded catalogue track. */
async function seedCatalogueArtist(id: string, vector: number[]): Promise<void> {
  await seedArtist(id, id);
  await seedCatalogueTrack(db, { title: `${id} cat`, trackId: `${id}-cat` });
  await link(`${id}-cat`, id);
  await embed(`${id}-cat`, vector);
}

async function centroidCount(): Promise<number> {
  const result = await db.execute(`select count(*) as n from artist_centroids`);

  return Number(result.rows[0]?.n ?? 0);
}

beforeEach(async () => {
  db = await createIntegrationDb();
});

describe("rankArtists — the sweep", () => {
  it("stores one centroid per embedded artist and its top-K sonic edges", async () => {
    // A sits at axis 0 (mean of a finding + a catalogue track, both near axis 0). B is closest to A,
    // then D (a small tilt), then Z (orthogonal, axis 40).
    await seedCertifiedArtist("a", axis(0), blend(axis(0), axis(1), 0.1));
    await seedCertifiedArtist("b", blend(axis(0), axis(1), 0.15));
    await seedCertifiedArtist("d", blend(axis(0), axis(1), 0.5));
    await seedCatalogueArtist("z", axis(40));

    const summary = await rankArtists(100, NOW);

    expect(summary.centroidsComputed).toBe(4);
    expect(summary.centroidsRemoved).toBe(0);
    expect(summary.remaining).toBe(0);
    expect(await centroidCount()).toBe(4);

    // A folded TWO vectors (finding + catalogue) into its mean.
    const aCentroid = await db.execute({
      args: ["a"],
      sql: `select vector_count from artist_centroids where artist_id = ?`,
    });
    expect(Number(aCentroid.rows[0]?.vector_count)).toBe(2);

    const neighbours = await getArtistNeighbours("a", 4);
    expect(neighbours.map((n) => n.slug)).toEqual(["b", "d", "z"]);
    // A never appears among its own neighbours.
    expect(neighbours.some((n) => n.slug === "a")).toBe(false);
  });

  it("marks a catalogue-only neighbour uncertified (the unlit tier) and a finding-artist certified", async () => {
    await seedCertifiedArtist("a", axis(0));
    await seedCertifiedArtist("b", blend(axis(0), axis(1), 0.1)); // has a finding → certified
    await seedCatalogueArtist("c", blend(axis(0), axis(1), 0.2)); // catalogue only → uncertified

    await rankArtists(100, NOW);

    const neighbours = await getArtistNeighbours("a", 4);
    const byslug = new Map(neighbours.map((n) => [n.slug, n]));
    expect(byslug.get("b")?.certified).toBe(true);
    expect(byslug.get("c")?.certified).toBe(false);
  });

  it("only touches N stale artists per tick and reports the rest as remaining", async () => {
    for (let index = 0; index < 5; index += 1) {
      await seedCatalogueArtist(`ar${index}`, blend(axis(0), axis(index + 1), 0.2));
    }

    const first = await rankArtists(2, NOW);
    expect(first.centroidsComputed).toBe(2);
    expect(first.remaining).toBe(3);
    expect(await centroidCount()).toBe(2);

    // Draining the rest converges to zero — the sweep is resumable.
    await rankArtists(2, NOW);
    const last = await rankArtists(2, NOW);
    expect(last.remaining).toBe(0);
    expect(await centroidCount()).toBe(5);
  });

  it("is a no-op on a settled graph and re-ranks when the corpus fingerprint moves", async () => {
    await seedCertifiedArtist("a", axis(0));
    await seedCertifiedArtist("b", blend(axis(0), axis(1), 0.1));

    const settled = await rankArtists(100, NOW);
    expect(settled.remaining).toBe(0);

    // Re-running changes nothing (idempotent no-op).
    const again = await rankArtists(100, NOW);
    expect(again.centroidsComputed).toBe(0);
    expect(again.remaining).toBe(0);

    // Embedding a NEW track moves the corpus fingerprint → every centroid goes stale.
    await seedCertifiedArtist("c", blend(axis(0), axis(1), 0.2));
    const moved = await rankArtists(100, NOW);
    expect(moved.corpus).not.toBe(settled.corpus);
    expect(moved.centroidsComputed).toBeGreaterThan(0);
    expect(moved.remaining).toBe(0);
  });

  it("purges an orphan centroid whose artist lost every embedded track", async () => {
    await seedCertifiedArtist("a", axis(0));
    await seedCertifiedArtist("b", blend(axis(0), axis(1), 0.1));
    await rankArtists(100, NOW);
    expect(await centroidCount()).toBe(2);

    // Clear A's only embedding (the wrong-audio path) → A becomes an orphan.
    await db.execute(`update tracks set embedding_blob = null where track_id = 'a-find'`);

    const summary = await rankArtists(100, NOW);
    expect(summary.centroidsRemoved).toBe(1);
    expect(await centroidCount()).toBe(1);
    // B no longer lists A (A's edge to B and B's edge to A are both gone).
    expect(await getArtistNeighbours("b", 4)).toEqual([]);
  });

  it("is deterministic: two identical ticks write byte-identical edges", async () => {
    await seedCertifiedArtist("a", axis(0));
    await seedCertifiedArtist("b", blend(axis(0), axis(1), 0.1));
    await seedCertifiedArtist("c", blend(axis(0), axis(1), 0.2));

    await rankArtists(100, NOW);
    const firstEdges = await db.execute(
      `select artist_id, neighbour_artist_id, rank, similarity from artist_similar order by artist_id, rank`,
    );

    // A fresh DB, the same seeds, the same injected clock → the same rows.
    db = await createIntegrationDb();
    await seedCertifiedArtist("a", axis(0));
    await seedCertifiedArtist("b", blend(axis(0), axis(1), 0.1));
    await seedCertifiedArtist("c", blend(axis(0), axis(1), 0.2));
    await rankArtists(100, NOW);
    const secondEdges = await db.execute(
      `select artist_id, neighbour_artist_id, rank, similarity from artist_similar order by artist_id, rank`,
    );

    expect(secondEdges.rows).toEqual(firstEdges.rows);
  });
});

describe("getArtistNeighbours — the read", () => {
  it("returns [] for an artist with no edge rows yet (the rail hides)", async () => {
    await seedCertifiedArtist("a", axis(0));
    // No sweep has run — no edges exist.
    expect(await getArtistNeighbours("a", 4)).toEqual([]);
  });

  it("returns [] for a non-positive limit without touching the DB", async () => {
    expect(await getArtistNeighbours("a", 0)).toEqual([]);
  });

  it("honours the limit against the stored top-K edges", async () => {
    await seedCertifiedArtist("a", axis(0));
    await seedCertifiedArtist("b", blend(axis(0), axis(1), 0.1));
    await seedCertifiedArtist("c", blend(axis(0), axis(1), 0.2));
    await seedCertifiedArtist("d", blend(axis(0), axis(1), 0.3));
    await rankArtists(100, NOW);

    expect((await getArtistNeighbours("a", 2)).map((n) => n.slug)).toEqual(["b", "c"]);
  });
});
