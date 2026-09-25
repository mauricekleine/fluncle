import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createIntegrationDb,
  seedCatalogueTrack,
  seedEmbedding,
  seedTrack,
  syncHubCounts,
} from "./integration-db";

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

const { ARTIST_NEIGHBOURS_SQL, getArtistNeighbours, rankArtists } =
  await import("./artist-dossier");

const DIMS = 1024;
const NOW = () => "2026-07-18T00:00:00.000Z";

function axis(index: number): number[] {
  const vector = Array.from<number>({ length: DIMS }).fill(0);
  vector[index] = 1;

  return vector;
}

function unit(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));

  return vector.map((value) => value / norm);
}

function blend(from: number[], toward: number[], weight: number): number[] {
  return unit(from.map((value, index) => value * (1 - weight) + (toward[index] ?? 0) * weight));
}

async function seedArtist(id: string, name: string): Promise<void> {
  const now = new Date().toISOString();

  await db.execute({
    args: [id, name, id, `https://i.scdn.co/image/${id}`, now, now],
    sql: `insert into artists (id, name, slug, image_url, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?)`,
  });
}

async function link(trackId: string, artistId: string): Promise<void> {
  await db.execute({
    args: [trackId, artistId],
    sql: `insert into track_artists (track_id, artist_id, position) values (?, ?, 1)`,
  });
  await syncHubCounts(db);
}

async function embed(trackId: string, vector: number[]): Promise<void> {
  await seedEmbedding(db, trackId, vector);
}

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
    await seedCertifiedArtist("a", axis(0), blend(axis(0), axis(1), 0.1));
    await seedCertifiedArtist("b", blend(axis(0), axis(1), 0.15));
    await seedCertifiedArtist("d", blend(axis(0), axis(1), 0.5));
    await seedCatalogueArtist("z", axis(40));

    const summary = await rankArtists(100, NOW);

    expect(summary.centroidsComputed).toBe(4);
    expect(summary.centroidsRemoved).toBe(0);
    expect(summary.remaining).toBe(0);
    expect(await centroidCount()).toBe(4);

    const aCentroid = await db.execute({
      args: ["a"],
      sql: `select vector_count from artist_centroids where artist_id = ?`,
    });
    expect(Number(aCentroid.rows[0]?.vector_count)).toBe(2);

    const neighbours = await getArtistNeighbours("a", 4);
    expect(neighbours.map((n) => n.slug)).toEqual(["b", "d", "z"]);

    expect(neighbours.some((n) => n.slug === "a")).toBe(false);
  });

  it("marks a catalogue-only neighbour uncertified (the unlit tier) and a finding-artist certified", async () => {
    await seedCertifiedArtist("a", axis(0));
    await seedCertifiedArtist("b", blend(axis(0), axis(1), 0.1));
    await seedCatalogueArtist("c", blend(axis(0), axis(1), 0.2));

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
    expect(first.remaining).toBeGreaterThan(0);
    expect(await centroidCount()).toBe(2);

    await rankArtists(2, NOW);
    const last = await rankArtists(2, NOW);
    expect(last.remaining).toBe(0);
    expect(await centroidCount()).toBe(5);
  });

  it("reports the EXACT stale backlog on a full batch when countRemaining asks for it", async () => {
    for (let index = 0; index < 5; index += 1) {
      await seedCatalogueArtist(`ar${index}`, blend(axis(0), axis(index + 1), 0.2));
    }

    const counted = await rankArtists(2, NOW, true);
    expect(counted.centroidsComputed).toBe(2);
    expect(counted.remaining).toBe(3);
  });

  it("counts (never assumes zero) after a short batch", async () => {
    await seedCatalogueArtist("a", axis(0));
    await seedCatalogueArtist("b", axis(1));

    const short = await rankArtists(100, NOW);
    expect(short.centroidsComputed).toBe(2);
    expect(short.remaining).toBe(0);
  });

  it("counts remaining on a zero limit, and infers it on an empty positive-limit page", async () => {
    await seedCatalogueArtist("a", axis(0));
    await seedCatalogueArtist("b", axis(1));

    const idle = await rankArtists(0, NOW);
    expect(idle.centroidsComputed).toBe(0);
    expect(idle.remaining).toBe(2);

    await rankArtists(100, NOW);
    const settled = await rankArtists(100, NOW);
    expect(settled.centroidsComputed).toBe(0);
    expect(settled.remaining).toBe(0);
  });

  it("re-stales ONLY the artists whose own discography changed (per-artist staleness)", async () => {
    await seedCertifiedArtist("a", axis(0));
    await seedCertifiedArtist("b", blend(axis(0), axis(1), 0.1));

    const settled = await rankArtists(100, NOW);
    expect(settled.remaining).toBe(0);

    const again = await rankArtists(100, NOW);
    expect(again.centroidsComputed).toBe(0);
    expect(again.remaining).toBe(0);

    await seedCertifiedArtist("c", blend(axis(0), axis(1), 0.2));
    const added = await rankArtists(100, NOW);
    expect(added.centroidsComputed).toBe(1);
    expect(added.remaining).toBe(0);

    await seedCatalogueTrack(db, { title: "a extra", trackId: "a-extra" });
    await link("a-extra", "a");
    await embed("a-extra", blend(axis(0), axis(2), 0.1));
    const grown = await rankArtists(100, NOW);
    expect(grown.centroidsComputed).toBe(1);

    const aCount = await db.execute({
      args: ["a"],
      sql: `select vector_count from artist_centroids where artist_id = ?`,
    });
    expect(Number(aCount.rows[0]?.vector_count)).toBe(2);
  });

  it("purges an orphan centroid whose artist lost every embedded track", async () => {
    await seedCertifiedArtist("a", axis(0));
    await seedCertifiedArtist("b", blend(axis(0), axis(1), 0.1));
    await rankArtists(100, NOW);
    expect(await centroidCount()).toBe(2);

    await seedEmbedding(db, "a-find", null);

    const summary = await rankArtists(100, NOW);
    expect(summary.centroidsRemoved).toBe(1);
    expect(await centroidCount()).toBe(1);

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

  it("answers `certified` off the stored mirror, naming no growing table in its plan", async () => {
    await seedCertifiedArtist("a", axis(0));
    await seedCertifiedArtist("b", blend(axis(0), axis(1), 0.1));
    await rankArtists(100, NOW);

    const plan = await db.execute({
      args: ["a", 4],
      sql: `explain query plan ${ARTIST_NEIGHBOURS_SQL}`,
    });
    const details = plan.rows
      .map((row) => (typeof row["detail"] === "string" ? row["detail"] : ""))
      .join("\n");

    expect(details).not.toMatch(/\btrack_artists\b/);
    expect(details).not.toMatch(/\bfindings\b/);
  });
});
