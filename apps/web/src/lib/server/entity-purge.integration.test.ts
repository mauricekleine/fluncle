import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb, seedCatalogueTrack } from "./integration-db";

import { getTrackEntityPurgeTargets } from "./entity-cache-purge";

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

const now = new Date().toISOString();

async function seedArtist(id: string, slug: string): Promise<void> {
  await db.execute({
    args: [id, `Artist ${id}`, slug, now, now],
    sql: `insert into artists (id, name, slug, created_at, updated_at) values (?, ?, ?, ?, ?)`,
  });
}

async function linkArtist(trackId: string, artistId: string, position: number): Promise<void> {
  await db.execute({
    args: [trackId, artistId, position],
    sql: `insert into track_artists (track_id, artist_id, position) values (?, ?, ?)`,
  });
}

async function seedAlbumAndLink(trackId: string, id: string, slug: string): Promise<void> {
  await db.execute({
    args: [id, `Album ${id}`, slug, now, now],
    sql: `insert into albums (id, name, slug, created_at, updated_at) values (?, ?, ?, ?, ?)`,
  });
  await db.execute({
    args: [id, trackId],
    sql: `update tracks set album_id = ? where track_id = ?`,
  });
}

async function seedLabelAndLink(trackId: string, id: string, slug: string): Promise<void> {
  await db.execute({
    args: [id, `Label ${id}`, slug, "undecided", now, now],
    sql: `insert into labels (id, name, slug, seed_state, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?)`,
  });
  await db.execute({
    args: [id, trackId],
    sql: `update tracks set label_id = ? where track_id = ?`,
  });
}

beforeEach(async () => {
  db = await createIntegrationDb();
});

describe("getTrackEntityPurgeTargets", () => {
  it("resolves the track's OWN destination, plus its artist, album and label pages", async () => {
    await seedCatalogueTrack(db, { title: "Roller", trackId: "t1" });
    await seedArtist("a1", "sub-focus");
    await linkArtist("t1", "a1", 0);
    await seedAlbumAndLink("t1", "al1", "all-that-jazz");
    await seedLabelAndLink("t1", "l1", "hospital-records");

    const targets = await getTrackEntityPurgeTargets("t1");

    expect(targets).toEqual(
      expect.arrayContaining([
        { kind: "track", slug: "t1" },
        { kind: "artist", slug: "sub-focus" },
        { kind: "album", slug: "all-that-jazz" },
        { kind: "label", slug: "hospital-records" },
      ]),
    );
    expect(targets).toHaveLength(4);
  });

  it("returns EVERY artist a track features (a track links several)", async () => {
    await seedCatalogueTrack(db, { trackId: "t2" });
    await seedArtist("a1", "sub-focus");
    await seedArtist("a2", "id");
    await linkArtist("t2", "a1", 0);
    await linkArtist("t2", "a2", 1);

    const targets = await getTrackEntityPurgeTargets("t2");

    expect(targets).toEqual(
      expect.arrayContaining([
        { kind: "track", slug: "t2" },
        { kind: "artist", slug: "sub-focus" },
        { kind: "artist", slug: "id" },
      ]),
    );
    expect(targets).toHaveLength(3);
  });

  it("returns ONLY the track's own destination when it links to no entity", async () => {
    await seedCatalogueTrack(db, { trackId: "t3" });

    expect(await getTrackEntityPurgeTargets("t3")).toEqual([{ kind: "track", slug: "t3" }]);
  });
});
