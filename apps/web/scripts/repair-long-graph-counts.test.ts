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
  LONG_GRAPH_REPAIR_COMPLETE_VALUE,
  LONG_GRAPH_REPAIR_MARKER_KEY,
  repairLongGraphCounts,
} from "./repair-long-graph-counts";

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

describe("repairLongGraphCounts", () => {
  it("removes only hidden memberships and repairs latest dates once", async () => {
    const first = await repairLongGraphCounts(db);
    expect(first).toEqual({ repaired: 3, skipped: false });

    for (const table of ["albums", "labels", "artists"]) {
      const result = await db.execute(
        `select renderable_track_count as n, latest_release_date as latest from ${table}`,
      );
      expect(result.rows[0]).toEqual({ latest: "2020-01-01", n: 1 });
    }

    const marker = await db.execute({
      args: [LONG_GRAPH_REPAIR_MARKER_KEY],
      sql: `select value from settings where key = ?`,
    });
    expect(marker.rows[0]?.value).toBe(LONG_GRAPH_REPAIR_COMPLETE_VALUE);
    expect(await repairLongGraphCounts(db)).toEqual({ repaired: 0, skipped: true });
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

    await expect(repairLongGraphCounts(interrupted)).rejects.toThrow("interrupted");
    const marker = await db.execute({
      args: [LONG_GRAPH_REPAIR_MARKER_KEY],
      sql: `select value from settings where key = ?`,
    });
    expect(marker.rows[0]?.value).toMatch(/^running:long-/);

    expect(await repairLongGraphCounts(db)).toEqual({ repaired: 3, skipped: false });
    for (const table of ["albums", "labels", "artists"]) {
      const result = await db.execute(`select renderable_track_count as n from ${table}`);
      expect(result.rows[0]?.n).toBe(1);
    }
  });
});
