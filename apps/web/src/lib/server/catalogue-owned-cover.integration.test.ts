import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => holder.db };
});

import { listFreshReleases } from "./fresh";
import { createIntegrationDb, seedAlbum, seedCatalogueTrack } from "./integration-db";
import { bestAlbumCoverUrl } from "../media";
import { listCatalogueTracksByAlbum } from "./tracks";

const NOW = new Date("2026-09-24T12:00:00.000Z");
const IMAGE_KEY = "albums/owned-master.jpg";
const IMAGE_UPDATED_AT = "2026-09-01T00:00:00.000Z";
const OWNED = bestAlbumCoverUrl({
  imageKey: IMAGE_KEY,
  imageState: "resolved",
  imageUpdatedAt: IMAGE_UPDATED_AT,
  spotifyUrl: null,
});

let db: Client;

beforeEach(async () => {
  db = await createIntegrationDb();
  holder.db = db;

  await seedAlbum(db, { id: "album-owned", name: "Owned Master", slug: "owned-master" });
  await db.execute({
    args: [IMAGE_KEY, IMAGE_UPDATED_AT],
    sql: `update albums set image_key = ?, image_state = 'resolved', image_updated_at = ?
           where id = 'album-owned'`,
  });
  await seedCatalogueTrack(db, {
    artists: ["Owned Artist"],
    title: "Owned Cover",
    trackId: "owned-cover-1",
  });

  await db.execute({
    sql: `update tracks set album_id = 'album-owned', album_image_url = null,
                 release_date = '2026-09-20', is_catalogue = 1
           where track_id = 'owned-cover-1'`,
  });
});

describe("catalogue rows carry the album's owned cover master", () => {
  it("on /fresh and the front door's release band", async () => {
    expect(OWNED).toBeDefined();

    const fresh = await listFreshReleases(NOW);
    const row = fresh.sections
      .flatMap((section) => section.catalogue)
      .find((item) => item.trackId === "owned-cover-1");

    expect(row?.albumImageUrl).toBe(OWNED);
  });

  it("on the album page's tracklist", async () => {
    const slice = await listCatalogueTracksByAlbum("album-owned");

    expect(slice.tracks.map((track) => track.albumImageUrl)).toEqual([OWNED]);
  });
});
