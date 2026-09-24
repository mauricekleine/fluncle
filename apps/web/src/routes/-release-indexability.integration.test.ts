import { type Client, type InStatement } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));
vi.mock("@/lib/server/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/db")>()),
  getDb: async () => holder.db,
}));

import {
  ARTIST_INDEX_MIN_FINDINGS,
  countArtistSitemapCandidates,
  listArtistSitemapRows,
} from "@/lib/server/artists";
import { typedRows } from "@/lib/server/db";
import {
  countRenderedLabelTracks,
  renderedArtistGateSql,
  withArtistFallback,
} from "@/lib/server/entity-indexability";
import { createIntegrationDb } from "@/lib/server/integration-db";
import { LABEL_INDEX_MIN_TRACKS, listLabelSitemapRows } from "@/lib/server/labels";
import { collectSitemapBag, collectSitemapIndexStats } from "@/lib/server/sitemap-data";
import { shardCountForSize } from "@/lib/sitemap";
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

  it("excludes dismissed and duplicate future rows from page and sitemap gates", async () => {
    await db.execute(
      "update tracks set dismissed_at = 'x' where track_id in ('future-0', 'future-1')",
    );
    await db.execute(
      "update tracks set duplicate_of_track_id = 'future-0' where track_id = 'future-2'",
    );

    const artist = await resolveArtistPageData("future-artist", "recent", 1);
    const label = await resolveLabelPageData("future-label", "recent", 1);
    expect(artist).toMatchObject({ indexable: false, status: "found" });
    expect(label).toMatchObject({ indexable: false, status: "found" });
    expect(
      (await listArtistSitemapRows(ARTIST_INDEX_MIN_FINDINGS)).map((row) => row.slug),
    ).not.toContain("future-artist");
    expect(
      (await listLabelSitemapRows(LABEL_INDEX_MIN_TRACKS)).map((row) => row.slug),
    ).not.toContain("future-label");
  });

  it("indexes an artist whose only visible content is JSON-only findings", async () => {
    await db.execute(`insert into artists (id, name, slug, created_at, updated_at, renderable_track_count)
      values ('fallback-artist', 'Fallback Artist', 'fallback-artist', 'x', 'x', 0)`);
    for (let index = 0; index < 3; index += 1) {
      const trackId = `fallback-${index}`;
      await db.execute({
        args: [trackId],
        sql: `insert into tracks (track_id, title, artists_json, duration_ms)
          values (?, 'Fallback tune', '["Fallback Artist"]', 0)`,
      });
      await db.execute({
        args: [trackId, `FALLBACK-${index}`],
        sql: `insert into findings (track_id, log_id, added_at) values (?, ?, '2026-07-20T00:00:00.000Z')`,
      });
    }

    const artist = await resolveArtistPageData("fallback-artist", "recent", 1);
    expect(artist).toMatchObject({ indexable: true, status: "found" });
    if (artist.status === "found") {
      expect(artist.findings).toHaveLength(3);
    }
    expect(
      (await listArtistSitemapRows(ARTIST_INDEX_MIN_FINDINGS)).map((row) => row.slug),
    ).toContain("fallback-artist");
  });
});

describe("the rendered-row gate stops at its floor", () => {
  it("counts no further than the floor, however many rows an entity renders", async () => {
    // Seven rendered rows on each entity: the gate only asks "at least the floor?", so it answers
    // with the floor and never walks the rest of a large catalogue to compare a total with it.
    for (let index = 3; index < 7; index += 1) {
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

    expect(
      await countRenderedLabelTracks("future-label", "2026-09-24", LABEL_INDEX_MIN_TRACKS),
    ).toBe(LABEL_INDEX_MIN_TRACKS);
    const artistGate = await db.execute(
      `${withArtistFallback("'2026-09-24'")} select ${renderedArtistGateSql(
        "'future-artist'",
        "'Future Artist'",
        "'2026-09-24'",
        ARTIST_INDEX_MIN_FINDINGS,
      )} as total`,
    );

    expect(Number(artistGate.rows[0]?.total)).toBe(ARTIST_INDEX_MIN_FINDINGS);
  });
});

describe("the artist page and the sitemap read one gate", () => {
  it("agree when the maintained counter drifts below the floor", async () => {
    await db.execute("update artists set renderable_track_count = 0 where id = 'future-artist'");

    const artist = await resolveArtistPageData("future-artist", "recent", 1);
    const artistSitemap = await listArtistSitemapRows(ARTIST_INDEX_MIN_FINDINGS, { limit: 10 });

    expect(artist.status === "found" && artist.indexable).toBe(false);
    expect(artistSitemap.map((row) => row.slug)).not.toContain("future-artist");
  });
});

describe("the sitemap index sizes the artist child from its candidates", () => {
  async function artistChildren(): Promise<number> {
    const stats = await collectSitemapIndexStats();

    return shardCountForSize(stats.artists.count, "artists");
  }

  it("lists the one artist child only when the exact gate admits someone", async () => {
    // The counter still says three, but every row is dismissed or a duplicate: a candidate the
    // exact gate turns away, so the index lists no artist child at all rather than one that 404s.
    await db.execute(
      "update tracks set dismissed_at = 'x' where track_id in ('future-0', 'future-1')",
    );
    await db.execute(
      "update tracks set duplicate_of_track_id = 'future-0' where track_id = 'future-2'",
    );

    expect(await artistChildren()).toBe(0);

    await db.execute("update tracks set dismissed_at = null, duplicate_of_track_id = null");

    expect(await artistChildren()).toBe(1);
    expect((await collectSitemapBag("artists", 1)).artists.map((row) => row.slug)).toEqual([
      "future-artist",
    ]);
  });

  it("reads no tracks row to count the candidates", async () => {
    const statements: string[] = [];
    const recorder: Pick<Client, "execute"> = {
      execute: async (statement: InStatement) => {
        statements.push(typeof statement === "string" ? statement : statement.sql);
        return db.execute(statement);
      },
    };
    holder.db = recorder as Client;
    await countArtistSitemapCandidates();
    holder.db = db;

    const plan = typedRows<{ detail: string; id: number; parent: number }>(
      (await db.execute(`explain query plan ${statements.at(-1) ?? ""}`)).rows,
    );
    // The credit-name fallback's two bounded windows are the only `tracks` reads, inside the one
    // materialized table; outside it the count touches `artists` alone.
    const fallbackRoot = plan.find((row) => row.detail === "MATERIALIZE artist_fallback");
    const inFallback = new Set<number>(fallbackRoot ? [fallbackRoot.id] : []);
    for (const row of plan) {
      if (inFallback.has(row.parent)) {
        inFallback.add(row.id);
      }
    }
    const outside = plan.filter((row) => !inFallback.has(row.id)).map((row) => row.detail);

    expect(outside.join("\n")).not.toMatch(/\b(?:SCAN|SEARCH) (?:t|ta|tracks|track_artists)\b/);
  });
});
