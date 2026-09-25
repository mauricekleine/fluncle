import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb, seedArtist, seedCatalogueTrack, seedTrack } from "./integration-db";

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

vi.mock("./log", () => ({ logEvent: vi.fn() }));

const { ARTIST_EDGES_QUEUE_DEPTH_SQL, resolveArtistEdges } =
  await import("./backfill-artist-edges");

const NOW = "2026-07-20T00:00:00.000Z";

async function seedAlias(
  client: Client,
  alias: string,
  artistId: string,
  status: "auto" | "confirmed" = "auto",
): Promise<void> {
  await client.execute({
    args: [`alias-${artistId}-${alias}`, artistId, alias, alias.toLowerCase(), status, NOW],
    sql: `insert into artist_aliases (id, artist_id, alias, alias_slug, kind, source, status, created_at)
          values (?, ?, ?, ?, 'name', 'musicbrainz', ?, ?)`,
  });
}

async function edges(
  client: Client,
): Promise<Array<{ artist_id: string; position: number; track_id: string }>> {
  const result = await client.execute(
    `select track_id, artist_id, position from track_artists order by track_id, position`,
  );

  return result.rows as unknown as Array<{
    artist_id: string;
    position: number;
    track_id: string;
  }>;
}

beforeEach(async () => {
  db = await createIntegrationDb();
});

describe("resolveArtistEdges (integration)", () => {
  it("folds names + aliases onto existing identities, mints nothing, drains idempotently", async () => {
    await seedArtist(db, { id: "art-logi", name: "Logistics", slug: "logistics" });
    await seedArtist(db, { id: "art-nutone", name: "Nu:Tone", slug: "nu-tone" });
    await seedAlias(db, "DB", "art-logi");

    await seedCatalogueTrack(db, {
      artists: ["logistics", "NU:TONE"],
      title: "Roller",
      trackId: "tFull",
    });

    await seedCatalogueTrack(db, {
      artists: ["DB", "Some Unknown MC"],
      title: "Collab",
      trackId: "tPartial",
    });

    await seedCatalogueTrack(db, { artists: ["Nobody At All"], title: "Ghost", trackId: "tZero" });

    await seedTrack(db, {
      artists: ["Logistics"],
      logId: "001.1.1A",
      title: "Certified",
      trackId: "tFinding",
    });

    const result = await resolveArtistEdges(200, false);

    expect(new Set(result.fullyMatched)).toEqual(new Set(["tFull", "tFinding"]));
    expect(result.partiallyMatched).toEqual(["tPartial"]);
    expect(result.zeroMatched).toEqual(["tZero"]);

    expect(result.unmatchedNames).toBe(2);
    expect(result.scanned).toBe(4);
    expect(result.queueDepth).toBe(0);

    expect(await edges(db)).toEqual([
      { artist_id: "art-logi", position: 1, track_id: "tFinding" },
      { artist_id: "art-logi", position: 1, track_id: "tFull" },
      { artist_id: "art-nutone", position: 2, track_id: "tFull" },
      { artist_id: "art-logi", position: 1, track_id: "tPartial" },
    ]);
    expect(result.edgesWritten).toBe(4);

    const artistCount = await db.execute(`select count(*) as n from artists`);
    expect(Number(artistCount.rows[0]?.n)).toBe(2);

    const second = await resolveArtistEdges(200, false);
    expect(second.scanned).toBe(0);
    expect(second.edgesWritten).toBe(0);
    expect(second.queueDepth).toBe(0);
    expect((await edges(db)).length).toBe(4);
  });

  it("a dry run classifies without writing an edge or a stamp", async () => {
    await seedArtist(db, { id: "art-logi", name: "Logistics", slug: "logistics" });
    await seedCatalogueTrack(db, { artists: ["Logistics"], title: "Roller", trackId: "tA" });

    const result = await resolveArtistEdges(200, true);

    expect(result.dryRun).toBe(true);
    expect(result.fullyMatched).toEqual(["tA"]);
    expect(result.edgesWritten).toBe(1);
    expect(result.queueDepth).toBe(1);

    expect((await edges(db)).length).toBe(0);
    const wet = await resolveArtistEdges(200, false);
    expect(wet.scanned).toBe(1);
  });

  it("skips a track that already has an edge (the anti-join worklist)", async () => {
    await seedArtist(db, { id: "art-logi", name: "Logistics", slug: "logistics" });
    await seedCatalogueTrack(db, { artists: ["Logistics"], title: "Linked", trackId: "tLinked" });
    await db.execute({
      args: ["tLinked", "art-logi"],
      sql: `insert into track_artists (track_id, artist_id, position) values (?, ?, 1)`,
    });

    const result = await resolveArtistEdges(200, false);

    expect(result.scanned).toBe(0);
    expect(result.queueDepth).toBe(0);
    expect((await edges(db)).length).toBe(1);
  });

  it("counts the post-pass queue through the candidate and anti-join indexes", async () => {
    await seedCatalogueTrack(db, { artists: ["Nobody"], title: "Queued", trackId: "tQueued" });

    const plan = await db.execute(`explain query plan ${ARTIST_EDGES_QUEUE_DEPTH_SQL}`);
    const details = plan.rows
      .map((row) => (typeof row.detail === "string" ? row.detail : ""))
      .join("\n");

    expect(details).toContain("tracks_artist_edges_backfill_queue_idx");
    expect(details).toContain("track_artists_track_id_idx");
    expect((await resolveArtistEdges(200, true)).queueDepth).toBe(1);
  });
});
