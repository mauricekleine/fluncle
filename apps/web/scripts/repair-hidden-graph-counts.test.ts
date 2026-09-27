import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LONG_FORM_MS } from "../src/lib/catalogue-eligibility";
import {
  createIntegrationDb,
  seedAlbum,
  seedArtist,
  seedCatalogueTrack,
  seedLabel,
  seedTrack,
} from "../src/lib/server/integration-db";
import {
  LONG_FORM_GRAPH_REPAIR,
  repairHiddenGraphCounts,
  SPOKEN_WORD_GRAPH_REPAIR,
} from "./repair-hidden-graph-counts";

let db: Client;

beforeEach(async () => {
  db = await createIntegrationDb();
  await seedAlbum(db, { id: "alb-one", name: "One", slug: "one" });
  await seedLabel(db, { id: "lab-one", name: "One", slug: "one" });
  await seedArtist(db, { id: "art-one", name: "One", slug: "one" });
  await seedCatalogueTrack(db, { trackId: "long-catalogue" });
  await seedCatalogueTrack(db, { trackId: "long-dismissed" });
  await seedCatalogueTrack(db, { trackId: "long-duplicate" });
  await seedTrack(db, { logId: "100.1.1A", trackId: "long-finding" });
  await db.batch(
    [
      {
        args: [LONG_FORM_MS],
        sql: `update tracks set duration_ms = ?, album_id = 'alb-one', label_id = 'lab-one',
                    release_date = case when track_id = 'long-catalogue'
                      then '2021-01-01' else '2020-01-01' end`,
      },
      `insert into track_artists (track_id, artist_id, position)
       values ('long-catalogue', 'art-one', 1), ('long-dismissed', 'art-one', 1),
              ('long-duplicate', 'art-one', 1), ('long-finding', 'art-one', 1)`,
      `update tracks set dismissed_at = '2021-01-02T00:00:00.000Z'
       where track_id = 'long-dismissed'`,
      `update tracks set duplicate_of_track_id = 'long-catalogue'
       where track_id = 'long-duplicate'`,
      ...["albums", "labels", "artists"].map(
        (table) =>
          `update ${table} set renderable_track_count = 4,
          certified_finding_count = 1, latest_release_date = '2021-01-01'`,
      ),
    ],
    "write",
  );
});

afterEach(() => {
  db.close();
});

describe("repairHiddenGraphCounts long-form pass", () => {
  it("removes only hidden memberships and repairs latest dates once", async () => {
    const first = await repairHiddenGraphCounts(db, LONG_FORM_GRAPH_REPAIR);
    expect(first).toEqual({ repaired: 3, skipped: false });

    for (const table of ["albums", "labels", "artists"]) {
      const result = await db.execute(
        `select renderable_track_count as n, latest_release_date as latest from ${table}`,
      );
      expect(result.rows[0]).toEqual({ latest: "2020-01-01", n: 1 });
    }

    const marker = await db.execute({
      args: [LONG_FORM_GRAPH_REPAIR.markerKey],
      sql: `select value from settings where key = ?`,
    });
    expect(marker.rows[0]?.value).toBe(LONG_FORM_GRAPH_REPAIR.completeValue);
    expect(await repairHiddenGraphCounts(db, LONG_FORM_GRAPH_REPAIR)).toEqual({
      repaired: 0,
      skipped: true,
    });
  });

  it("resumes after a failed page without subtracting the completed page twice", async () => {
    const extraIds = Array.from(
      { length: 100 },
      (_, index) => `long-extra-${String(index).padStart(3, "0")}`,
    );
    await db.batch(
      extraIds.flatMap((trackId) => [
        {
          args: [trackId, trackId, LONG_FORM_MS],
          sql: `insert into tracks
                (track_id, title, artists_json, duration_ms, album_id, label_id)
                values (?, ?, '["One"]', ?, 'alb-one', 'lab-one')`,
        },
        {
          args: [trackId],
          sql: `insert into track_artists (track_id, artist_id, position)
                values (?, 'art-one', 1)`,
        },
      ]),
      "write",
    );
    await db.batch(
      ["albums", "labels", "artists"].map(
        (table) => `update ${table} set renderable_track_count = 104`,
      ),
      "write",
    );

    let batches = 0;
    const interrupted = {
      batch: ((...args: Parameters<Client["batch"]>) => {
        batches += 1;
        if (batches === 2) {
          throw new Error("interrupted");
        }
        return db.batch(...args);
      }) as Client["batch"],
      execute: ((...args: Parameters<Client["execute"]>) =>
        db.execute(...args)) as Client["execute"],
    } as Client;

    await expect(repairHiddenGraphCounts(interrupted, LONG_FORM_GRAPH_REPAIR)).rejects.toThrow(
      "interrupted",
    );
    const marker = await db.execute({
      args: [LONG_FORM_GRAPH_REPAIR.markerKey],
      sql: `select value from settings where key = ?`,
    });
    expect(marker.rows[0]?.value).toMatch(/^running:long-/);

    expect(await repairHiddenGraphCounts(db, LONG_FORM_GRAPH_REPAIR)).toEqual({
      repaired: 3,
      skipped: false,
    });
    for (const table of ["albums", "labels", "artists"]) {
      const result = await db.execute(`select renderable_track_count as n from ${table}`);
      expect(result.rows[0]?.n).toBe(1);
    }
  });
});

describe("repairHiddenGraphCounts spoken-word pass", () => {
  beforeEach(async () => {
    await seedCatalogueTrack(db, { title: "Had a Little Fight (Commentary)", trackId: "spoken" });
    await seedCatalogueTrack(db, { title: "Interview With The Vampire", trackId: "song" });
    await seedTrack(db, {
      logId: "100.1.2A",
      title: "Certified (Commentary)",
      trackId: "spoken-finding",
    });
    await db.batch(
      [
        `update tracks set album_id = 'alb-one', label_id = 'lab-one', release_date = '2022-01-01'
         where track_id in ('spoken', 'song', 'spoken-finding')`,
        `update tracks set release_date = '2023-01-01' where track_id = 'spoken'`,
        `insert into track_artists (track_id, artist_id, position)
         values ('spoken', 'art-one', 1), ('song', 'art-one', 1), ('spoken-finding', 'art-one', 1)`,
      ],
      "write",
    );
  });

  it("subtracts only non-finding spoken-word catalogue tracks the long-form pass left counted", async () => {
    expect(await repairHiddenGraphCounts(db, LONG_FORM_GRAPH_REPAIR)).toEqual({
      repaired: 3,
      skipped: false,
    });
    await db.batch(
      ["albums", "labels", "artists"].map(
        (table) =>
          `update ${table} set renderable_track_count = 4, latest_release_date = '2023-01-01'`,
      ),
      "write",
    );

    expect(await repairHiddenGraphCounts(db, SPOKEN_WORD_GRAPH_REPAIR)).toEqual({
      repaired: 1,
      skipped: false,
    });

    for (const table of ["albums", "labels", "artists"]) {
      const result = await db.execute(
        `select renderable_track_count as n, latest_release_date as latest from ${table}`,
      );
      expect(result.rows[0]).toEqual({ latest: "2022-01-01", n: 3 });
    }
    expect(await repairHiddenGraphCounts(db, SPOKEN_WORD_GRAPH_REPAIR)).toEqual({
      repaired: 0,
      skipped: true,
    });
  });

  it("skips every pass once the hub-count backfill applied the current visibility rule", async () => {
    await db.execute({
      args: ["backfill_hub_counts_v3_state", "complete:v3"],
      sql: `insert into settings (key, value) values (?, ?)`,
    });

    expect(await repairHiddenGraphCounts(db, SPOKEN_WORD_GRAPH_REPAIR)).toEqual({
      repaired: 0,
      skipped: true,
    });
    expect(await repairHiddenGraphCounts(db, LONG_FORM_GRAPH_REPAIR)).toEqual({
      repaired: 0,
      skipped: true,
    });
  });
});
