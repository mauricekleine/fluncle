import { type Client } from "@libsql/client";

import { beforeEach, describe, expect, it } from "vitest";

import { createIntegrationDb, seedCatalogueTrack } from "../src/lib/server/integration-db";
import {
  initializePublicProjectionTestState,
  readPublicProjectionMaintenanceSnapshot,
  settlePublicProjectionTestState,
} from "./lib/public-projection-test-state";
import { backfillHasIsrc } from "./backfill-has-isrc";

let db: Client;

async function mirror(trackId: string): Promise<number> {
  const result = await db.execute({
    args: [trackId],
    sql: "select has_isrc from tracks where track_id = ?",
  });

  return Number(result.rows[0]?.has_isrc);
}

beforeEach(async () => {
  db = await createIntegrationDb();
  await initializePublicProjectionTestState(db);
  await seedCatalogueTrack(db, { title: "Keyed", trackId: "isrc00000000000000000a" });
  await seedCatalogueTrack(db, { title: "Bare", trackId: "bare00000000000000000a" });
  await seedCatalogueTrack(db, { title: "Empty", trackId: "empty0000000000000000a" });

  await db.execute(
    "update tracks set isrc = 'GBTST2600001' where track_id = 'isrc00000000000000000a'",
  );
  await db.execute("update tracks set isrc = ' ' where track_id = 'empty0000000000000000a'");
  await db.execute("update tracks set has_isrc = 0");
});

describe("backfillHasIsrc", () => {
  it("flips a row carrying an ISRC to 1, leaves bare and empty-string rows at 0", async () => {
    const { flipped } = await backfillHasIsrc(db);

    expect(flipped).toBe(1);
    expect(await mirror("isrc00000000000000000a")).toBe(1);
    expect(await mirror("bare00000000000000000a")).toBe(0);
    expect(await mirror("empty0000000000000000a")).toBe(0);
  });

  it("is idempotent — a second run flips nothing", async () => {
    await backfillHasIsrc(db);
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
    const { flipped } = await backfillHasIsrc(db);

    expect(flipped).toBe(0);
    expect(await readPublicProjectionMaintenanceSnapshot(db)).toEqual(ready);
  });

  it("corrects drift in BOTH directions in one pass", async () => {
    await db.execute("update tracks set has_isrc = 1 where track_id = 'bare00000000000000000a'");

    const { flipped } = await backfillHasIsrc(db);

    expect(flipped).toBe(2);
    expect(await mirror("isrc00000000000000000a")).toBe(1);
    expect(await mirror("bare00000000000000000a")).toBe(0);
  });
});
