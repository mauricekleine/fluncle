import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createIntegrationDb,
  seedCatalogueTrack,
  seedTrack,
} from "../src/lib/server/integration-db";
import {
  PUBLIC_PROJECTION_CUTOVER_ENABLED_KEY,
  readProjectedAggregateBuckets,
  readProjectedDefaultTrackTotal,
} from "../src/lib/server/public-projection-cutover";
import {
  rebuildDefaultTrackHubAnchors,
  rebuildPublicProjection,
  repairPublicProjectionChunk,
  shadowPublicProjections,
} from "../src/lib/server/public-projections";
import {
  enqueueHiddenTrackProjectionRepairs,
  SPOKEN_WORD_PROJECTION_REPAIR,
} from "./enqueue-hidden-track-projection-repairs";

const NOW = new Date("2026-01-10T12:00:00.000Z");

let db: Client;

async function seedProjected(
  trackId: string,
  key: string,
  options: { certified?: boolean } = {},
): Promise<void> {
  if (options.certified) {
    await seedTrack(db, { logId: `001.1.${trackId.length}A`, title: "Rewind", trackId });
  } else {
    await seedCatalogueTrack(db, { title: "Rewind", trackId });
  }
  await db.execute({
    args: [key, trackId],
    sql: `update tracks set release_date = '2024-01-01', key = ? where track_id = ?`,
  });
}

async function drainRepairs(): Promise<void> {
  for (let pass = 0; pass < 100; pass += 1) {
    const pending = Number(
      (await db.execute(`select count(*) as n from projection_repairs`)).rows[0]?.n ?? 0,
    );
    if (pending === 0) {
      return;
    }
    await repairPublicProjectionChunk(db, { limit: 2, now: () => NOW });
  }
  throw new Error("public projection repairs did not drain");
}

beforeEach(async () => {
  db = await createIntegrationDb();
  await seedProjected("music", "Am");
  await seedProjected("spoken", "Dm");
  await seedProjected("spoken-finding", "F#m", { certified: true });
  await rebuildPublicProjection(db, "public_aggregates", { generation: "aggregate-a", limit: 2 });
  await rebuildPublicProjection(db, "artist_qualification", { generation: "artists-a", limit: 2 });
  await rebuildDefaultTrackHubAnchors(db, { generation: "aggregate-a", now: () => NOW });
  await db.execute({
    args: [PUBLIC_PROJECTION_CUTOVER_ENABLED_KEY, "true"],
    sql: `insert into settings (key, value) values (?, ?)
      on conflict(key) do update set value = excluded.value`,
  });
  await db.execute(
    `update tracks set title = 'Rewind (Commentary)' where track_id in ('spoken', 'spoken-finding')`,
  );
});

afterEach(() => db.close());

describe("enqueueHiddenTrackProjectionRepairs", () => {
  it("reprojects spoken-word catalogue tracks out of the public aggregates and keeps spoken-word findings", async () => {
    expect(await readProjectedDefaultTrackTotal(db)).toBe(3);

    expect(
      await enqueueHiddenTrackProjectionRepairs(db, SPOKEN_WORD_PROJECTION_REPAIR, NOW),
    ).toEqual({ enqueued: 1, skipped: false });
    expect(await readProjectedDefaultTrackTotal(db)).toBeUndefined();

    await drainRepairs();

    expect(await readProjectedDefaultTrackTotal(db)).toBe(2);
    expect(await readProjectedAggregateBuckets(db, "key")).toEqual([
      { bucket: "Am", count: 1 },
      { bucket: "F#m", count: 1 },
    ]);
    const members = await db.execute(
      `select track_id from public_aggregate_membership order by track_id`,
    );
    expect(members.rows.map((row) => row.track_id)).toEqual(["music", "spoken-finding"]);
    expect((await shadowPublicProjections(db)).aggregateBucketsMatched).toBe(true);
  });

  it("enqueues once per database and resumes from its durable cursor", async () => {
    await db.execute({
      args: [SPOKEN_WORD_PROJECTION_REPAIR.markerKey, "running:spoken"],
      sql: `insert into settings (key, value) values (?, ?)`,
    });

    expect(
      await enqueueHiddenTrackProjectionRepairs(db, SPOKEN_WORD_PROJECTION_REPAIR, NOW),
    ).toEqual({ enqueued: 0, skipped: true });
    expect(
      await enqueueHiddenTrackProjectionRepairs(db, SPOKEN_WORD_PROJECTION_REPAIR, NOW),
    ).toEqual({ enqueued: 0, skipped: true });
    const marker = await db.execute({
      args: [SPOKEN_WORD_PROJECTION_REPAIR.markerKey],
      sql: `select value from settings where key = ?`,
    });
    expect(marker.rows[0]?.value).toBe(SPOKEN_WORD_PROJECTION_REPAIR.completeValue);
  });
});
