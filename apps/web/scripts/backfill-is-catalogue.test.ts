import { type Client } from "@libsql/client";

import { beforeEach, describe, expect, it } from "vitest";

import {
  createIntegrationDb,
  seedCatalogueTrack,
  seedTrack,
} from "../src/lib/server/integration-db";
import {
  initializePublicProjectionTestState,
  readPublicProjectionMaintenanceSnapshot,
  settlePublicProjectionTestState,
} from "./lib/public-projection-test-state";
import { backfillIsCatalogue } from "./backfill-is-catalogue";

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
  await initializePublicProjectionTestState(db);

  await seedTrack(db, { logId: "004.7.2I", title: "Certified", trackId: "cert00000000000000000a" });
  await seedCatalogueTrack(db, { title: "Catalogue", trackId: "cat000000000000000000a" });

  await db.execute("update tracks set is_catalogue = 1");
});

describe("backfillIsCatalogue", () => {
  it("flips a certified row (has a findings row) to 0, leaves a catalogue row at 1", async () => {
    expect(await flag("cert00000000000000000a")).toBe(1);
    expect(await flag("cat000000000000000000a")).toBe(1);

    const { flipped } = await backfillIsCatalogue(db);

    expect(flipped).toBe(1);
    expect(await flag("cert00000000000000000a")).toBe(0);
    expect(await flag("cat000000000000000000a")).toBe(1);
  });

  it("is idempotent — a second run flips nothing and changes no state", async () => {
    await backfillIsCatalogue(db);
    expect(await readPublicProjectionMaintenanceSnapshot(db)).toEqual({
      aggregate: { projectionEpoch: 0, ready: true, sourceEpoch: 0 },
      artists: { projectionEpoch: 0, ready: true, sourceEpoch: 0 },
      repairs: [],
    });
    await settlePublicProjectionTestState(db);
    const ready = await readPublicProjectionMaintenanceSnapshot(db);
    expect(ready).toEqual({
      aggregate: { projectionEpoch: 0, ready: true, sourceEpoch: 0 },
      artists: { projectionEpoch: 0, ready: true, sourceEpoch: 0 },
      repairs: [],
    });

    const { flipped } = await backfillIsCatalogue(db);

    expect(flipped).toBe(0);
    expect(await flag("cert00000000000000000a")).toBe(0);
    expect(await flag("cat000000000000000000a")).toBe(1);
    expect(await readPublicProjectionMaintenanceSnapshot(db)).toEqual(ready);
  });
});
