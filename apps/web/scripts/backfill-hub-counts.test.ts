import { type Client } from "@libsql/client";

import { beforeEach, describe, expect, it } from "vitest";

import {
  createIntegrationDb,
  seedAlbum,
  seedArtist,
  seedCatalogueTrack,
  seedLabel,
  seedTrack,
} from "../src/lib/server/integration-db";
import { backfillHubCounts } from "./backfill-hub-counts";

// The keystone-2 backfill (docs/db-scale-backlog Wave 2 #2): the migration adds the maintained
// per-entity counters with DEFAULT 0, so every EXISTING row reads zero while the edges it should be
// counting already exist. This is the ONE recompute-from-truth in the design — the exact shape the
// write paths are forbidden to use — so it is guarded to run once and skipped ever after. Driven
// against the real migrated schema so the `UPDATE … FROM (… GROUP BY …)` under test is
// byte-identical to production's.

let db: Client;

async function counts(
  table: "albums" | "artists" | "labels",
  id: string,
): Promise<{ certified: number; renderable: number }> {
  const result = await db.execute({
    args: [id],
    sql: `select renderable_track_count as renderable, certified_finding_count as certified
          from ${table} where id = ?`,
  });
  const row = result.rows[0];

  return { certified: Number(row?.certified ?? -1), renderable: Number(row?.renderable ?? -1) };
}

beforeEach(async () => {
  db = await createIntegrationDb();
  // The graph history leaves behind: one label + one album + one artist carrying two certified
  // findings and one raw catalogue track, plus an EMPTY label nothing points at.
  await seedLabel(db, { id: "lab-1", name: "Hospital Records", slug: "hospital-records" });
  await seedLabel(db, { id: "lab-empty", name: "Nothing Here", slug: "nothing-here" });
  await seedAlbum(db, { id: "alb-1", name: "Sight To Behold", slug: "sight-to-behold" });
  await seedArtist(db, { id: "art-1", name: "Logistics", slug: "logistics" });
  await seedTrack(db, { logId: "004.7.2A", trackId: "t-cert-0000000000000a" });
  await seedTrack(db, { logId: "004.7.2B", trackId: "t-cert-0000000000000b" });
  await seedCatalogueTrack(db, { trackId: "t-cat-00000000000000a" });
  // The edges, written RAW (no deltas) — exactly the pre-backfill state history is in.
  await db.batch(
    [
      `update tracks set label_id = 'lab-1', album_id = 'alb-1'`,
      `insert into track_artists (track_id, artist_id, position)
       values ('t-cert-0000000000000a', 'art-1', 1),
              ('t-cert-0000000000000b', 'art-1', 1),
              ('t-cat-00000000000000a', 'art-1', 1)`,
    ],
    "write",
  );
});

describe("backfillHubCounts", () => {
  it("counts every entity's linked tracks and its certified subset, in one pass per table", async () => {
    const result = await backfillHubCounts(db);

    expect(result.skipped).toBe(false);
    expect(result.filled).toEqual({ albums: 1, artists: 1, labels: 1 });
    // Three linked tracks, two of them certified (`is_catalogue = 0`).
    expect(await counts("labels", "lab-1")).toEqual({ certified: 2, renderable: 3 });
    expect(await counts("albums", "alb-1")).toEqual({ certified: 2, renderable: 3 });
    expect(await counts("artists", "art-1")).toEqual({ certified: 2, renderable: 3 });
  });

  it("leaves an entity with no linked tracks at the DDL default of 0", async () => {
    await backfillHubCounts(db);

    expect(await counts("labels", "lab-empty")).toEqual({ certified: 0, renderable: 0 });
  });

  it("SKIPS on an already-backfilled database — the deploy-time no-op", async () => {
    await backfillHubCounts(db);
    // Drift the counts, then re-run: the guard must see the seeded state and change nothing, so a
    // real maintenance bug is left visible for the reconciliation sweep rather than papered over.
    await db.execute(`update labels set certified_finding_count = 99 where id = 'lab-1'`);

    const result = await backfillHubCounts(db);

    expect(result.skipped).toBe(true);
    expect(result.filled).toBeUndefined();
    expect(await counts("labels", "lab-1")).toEqual({ certified: 99, renderable: 3 });
  });

  it("--force re-fills over seeded counts, correcting drift", async () => {
    await backfillHubCounts(db);
    await db.execute(`update labels set certified_finding_count = 99 where id = 'lab-1'`);

    const result = await backfillHubCounts(db, { force: true });

    expect(result.skipped).toBe(false);
    expect(await counts("labels", "lab-1")).toEqual({ certified: 2, renderable: 3 });
  });

  it("is idempotent under --force — a second forced run lands the same numbers", async () => {
    await backfillHubCounts(db, { force: true });
    await backfillHubCounts(db, { force: true });

    expect(await counts("artists", "art-1")).toEqual({ certified: 2, renderable: 3 });
  });
});
