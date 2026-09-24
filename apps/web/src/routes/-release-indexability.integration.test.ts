import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));
vi.mock("@/lib/server/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/db")>()),
  getDb: async () => holder.db,
}));

import { ARTIST_INDEX_MIN_FINDINGS, listArtistSitemapRows } from "@/lib/server/artists";
import { createIntegrationDb } from "@/lib/server/integration-db";
import { LABEL_INDEX_MIN_TRACKS, listLabelSitemapRows } from "@/lib/server/labels";
import { resolveArtistPageData } from "./-artist-page-data";
import { resolveLabelPageData } from "./-label-page-data";

let db: Client;

beforeEach(async () => {
  db = await createIntegrationDb();
  holder.db = db;
  await db.execute(`insert into artists (id, name, slug, created_at, updated_at, renderable_track_count)
    values ('future-artist', 'Future Artist', 'future-artist', 'x', 'x', 3)`);
  await db.execute(`insert into labels (id, name, slug, created_at, updated_at, renderable_track_count)
    values ('future-label', 'Future Label', 'future-label', 'x', 'x', 3)`);
  for (let index = 0; index < 3; index += 1) {
    const trackId = `future-${index}`;
    await db.execute({
      args: [trackId],
      sql: `insert into tracks (track_id, title, artists_json, label_id, release_date, duration_ms)
        values (?, 'Future tune', '["Future Artist"]', 'future-label', '2999-01-01', 0)`,
    });
    await db.execute({
      args: [trackId],
      sql: `insert into track_artists (track_id, artist_id, position) values (?, 'future-artist', 1)`,
    });
  }
});

describe("future-only entity indexability", () => {
  it("agrees across artist and label pages and sitemap reads", async () => {
    const artist = await resolveArtistPageData("future-artist", "recent", 1);
    const label = await resolveLabelPageData("future-label", "recent", 1);
    const artistSitemap = await listArtistSitemapRows(ARTIST_INDEX_MIN_FINDINGS, { limit: 10 });
    const labelSitemap = await listLabelSitemapRows(LABEL_INDEX_MIN_TRACKS, { limit: 10 });

    expect(artist.status).toBe("found");
    expect(label.status).toBe("found");
    expect(artist.status === "found" && artist.indexable).toBe(true);
    expect(label.status === "found" && label.indexable).toBe(true);
    expect(artistSitemap.map((row) => row.slug)).toContain("future-artist");
    expect(labelSitemap.map((row) => row.slug)).toContain("future-label");
  });
});

describe("the entity pages and the sitemap read one stored gate", () => {
  it("agree when the maintained counter falls below the floor", async () => {
    await db.execute("update artists set renderable_track_count = 0 where id = 'future-artist'");
    await db.execute("update labels set renderable_track_count = 0 where id = 'future-label'");

    const artist = await resolveArtistPageData("future-artist", "recent", 1);
    const label = await resolveLabelPageData("future-label", "recent", 1);

    expect(artist.status === "found" && artist.indexable).toBe(false);
    expect(label.status === "found" && label.indexable).toBe(false);
    expect(
      (await listArtistSitemapRows(ARTIST_INDEX_MIN_FINDINGS)).map((row) => row.slug),
    ).not.toContain("future-artist");
    expect(
      (await listLabelSitemapRows(LABEL_INDEX_MIN_TRACKS)).map((row) => row.slug),
    ).not.toContain("future-label");
  });
});
