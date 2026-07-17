import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb, seedCatalogueTrack } from "./integration-db";
// `vi.mock` is hoisted above this import, so `getTrackEntityPurgeTargets` resolves its `getDb`
// through the mock below (the catalogue.integration.test.ts pattern) — a static import keeps
// vite's `cloudflare:workers` alias applied to the tracks.ts module graph.
import { getTrackEntityPurgeTargets } from "./tracks";

// THE ENTITY-PURGE FAN-OUT, PROVEN — against the REAL schema.
//
// A write to a track must drop the cached `/artist|/album|/label/<slug>` pages that render
// it. `getTrackEntityPurgeTargets` is the join that decides WHICH pages — resolving a track's
// linked entity slugs through `track_artists→artists.slug`, `tracks.album_id→albums.slug`, and
// `tracks.label_id→labels.slug` (the exact graph the pages read). A wrong join here silently
// leaves a stale page served, or purges the wrong one, so the resolution is pinned against a
// real libSQL engine + the generated DDL — not a mock. The unit-level cache/predicate logic
// lives in `edge-cache.test.ts`; this file proves only the SQL resolution.

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
  it("resolves the artist, album, AND label pages a track renders on", async () => {
    await seedCatalogueTrack(db, { title: "Roller", trackId: "t1" });
    await seedArtist("a1", "sub-focus");
    await linkArtist("t1", "a1", 0);
    await seedAlbumAndLink("t1", "al1", "all-that-jazz");
    await seedLabelAndLink("t1", "l1", "hospital-records");

    const targets = await getTrackEntityPurgeTargets("t1");

    expect(targets).toEqual(
      expect.arrayContaining([
        { kind: "artist", slug: "sub-focus" },
        { kind: "album", slug: "all-that-jazz" },
        { kind: "label", slug: "hospital-records" },
      ]),
    );
    expect(targets).toHaveLength(3);
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
        { kind: "artist", slug: "sub-focus" },
        { kind: "artist", slug: "id" },
      ]),
    );
    expect(targets).toHaveLength(2);
  });

  it("returns nothing for a track with no linked entities", async () => {
    // A bare catalogue track with no artist join, album_id, or label_id renders on no
    // entity page — so it must purge none (never a spurious global purge).
    await seedCatalogueTrack(db, { trackId: "t3" });

    expect(await getTrackEntityPurgeTargets("t3")).toEqual([]);
  });
});
