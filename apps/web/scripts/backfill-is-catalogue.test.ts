import { type Client } from "@libsql/client";

import { beforeEach, describe, expect, it } from "vitest";

import {
  createIntegrationDb,
  seedCatalogueTrack,
  seedTrack,
} from "../src/lib/server/integration-db";
import { backfillIsCatalogue } from "./backfill-is-catalogue";

// The keystone-1 backfill (docs/db-scale-backlog Wave 2 #1): the migration adds `is_catalogue`
// DEFAULT 1, so every EXISTING row — findings included — lands at 1. This flips exactly the
// certified rows (those with a findings row) to 0, and only those. Driven against the real
// migrated schema so the SQL under test is byte-identical to production.

let db: Client;

async function flag(trackId: string): Promise<number> {
  const result = await db.execute({
    args: [trackId],
    sql: "select is_catalogue from tracks where track_id = ?",
  });

  return Number(result.rows[0]?.is_catalogue);
}

beforeEach(async () => {
  db = await createIntegrationDb();
  // A certified track and a raw catalogue track.
  await seedTrack(db, { logId: "004.7.2I", title: "Certified", trackId: "cert00000000000000000a" });
  await seedCatalogueTrack(db, { title: "Catalogue", trackId: "cat000000000000000000a" });
  // Recreate the pre-backfill state the migration leaves behind: DEFAULT 1 on EVERY row, so the
  // certified track is (wrongly) flagged catalogue until the backfill runs.
  await db.execute("update tracks set is_catalogue = 1");
});

describe("backfillIsCatalogue", () => {
  it("flips a certified row (has a findings row) to 0, leaves a catalogue row at 1", async () => {
    expect(await flag("cert00000000000000000a")).toBe(1); // pre-backfill: the migration's default
    expect(await flag("cat000000000000000000a")).toBe(1);

    const { flipped } = await backfillIsCatalogue(db);

    expect(flipped).toBe(1);
    expect(await flag("cert00000000000000000a")).toBe(0);
    expect(await flag("cat000000000000000000a")).toBe(1);
  });

  it("is idempotent — a second run flips nothing and changes no state", async () => {
    await backfillIsCatalogue(db);
    const { flipped } = await backfillIsCatalogue(db);

    expect(flipped).toBe(0);
    expect(await flag("cert00000000000000000a")).toBe(0);
    expect(await flag("cat000000000000000000a")).toBe(1);
  });
});
