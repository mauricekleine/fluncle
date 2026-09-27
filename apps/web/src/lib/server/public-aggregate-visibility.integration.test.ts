import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LONG_FORM_MS } from "../catalogue-eligibility";
import { createIntegrationDb, seedCatalogueTrack, seedTrack } from "./integration-db";
import { advanceProjectionFor, getProjectionStatusFor } from "./projection-operations";
import {
  PUBLIC_AGGREGATE_VISIBILITY_CURSOR_KEY,
  PUBLIC_AGGREGATE_VISIBILITY_VERSION,
  PUBLIC_AGGREGATE_VISIBILITY_VERSION_KEY,
  PUBLIC_PROJECTION_CUTOVER_ENABLED_KEY,
  readProjectedAggregateBuckets,
  readProjectedDefaultTrackTotal,
} from "./public-projection-cutover";
import {
  rebuildDefaultTrackHubAnchors,
  rebuildPublicProjection,
  reconcilePublicAggregateVisibilityChunk,
} from "./public-projections";

const NOW = new Date("2026-01-10T12:00:00.000Z");

let db: Client;

async function seedProjected(
  trackId: string,
  key: string,
  options: { certified?: boolean; title?: string } = {},
): Promise<void> {
  const title = options.title ?? "Rewind";
  if (options.certified) {
    await seedTrack(db, { logId: `001.1.${trackId.length}A`, title, trackId });
  } else {
    await seedCatalogueTrack(db, { title, trackId });
  }
  await db.execute({
    args: [key, trackId],
    sql: `update tracks set release_date = '2024-01-01', key = ? where track_id = ?`,
  });
}

async function members(): Promise<unknown[]> {
  const result = await db.execute(
    `select track_id from public_aggregate_membership order by track_id`,
  );
  return result.rows.map((row) => row.track_id);
}

async function simulateProjectionBuiltUnderOlderRule(): Promise<void> {
  await db.batch(
    [
      `delete from public_aggregate_membership where track_id = 'long-finding'`,
      `update public_aggregate_counts set track_count = track_count - 1
         where aggregate_kind = 'key' and bucket = 'F#m'`,
      `update public_aggregate_counts set track_count = track_count - 1
         where aggregate_kind = 'release_date_bucket' and bucket = '2024'`,
      `update public_aggregate_state set default_track_total = default_track_total - 1
         where scope = 'tracks'`,
      `update tracks set title = 'Rewind (Commentary)' where track_id = 'spoken'`,
      {
        args: [PUBLIC_AGGREGATE_VISIBILITY_VERSION_KEY],
        sql: `update settings set value = 'older-rule' where key = ?`,
      },
    ],
    "write",
  );
}

async function repairUntilComplete(): Promise<void> {
  for (let step = 0; step < 50; step += 1) {
    const result = await advanceProjectionFor(db, {
      action: "repair",
      includeStatus: false,
      limit: 2,
      target: "public_aggregates",
    });
    if (result.complete) {
      return;
    }
  }
  throw new Error("public aggregate maintenance did not converge");
}

beforeEach(async () => {
  db = await createIntegrationDb();
  await seedProjected("music", "Am");
  await seedProjected("spoken", "Dm");
  await seedProjected("long-finding", "F#m", { certified: true });
  await db.execute({
    args: [LONG_FORM_MS],
    sql: `update tracks set duration_ms = ? where track_id = 'long-finding'`,
  });
  await rebuildPublicProjection(db, "public_aggregates", { generation: "aggregate-a", limit: 2 });
  await rebuildPublicProjection(db, "artist_qualification", { generation: "artists-a", limit: 2 });
  await rebuildDefaultTrackHubAnchors(db, { generation: "aggregate-a", now: () => NOW });
  await db.execute({
    args: [PUBLIC_PROJECTION_CUTOVER_ENABLED_KEY, "true"],
    sql: `insert into settings (key, value) values (?, ?)
      on conflict(key) do update set value = excluded.value`,
  });
});

afterEach(() => db.close());

describe("public aggregate visibility reconcile", () => {
  it("stamps the running visibility rule when a rebuild completes", async () => {
    const marker = await db.execute({
      args: [PUBLIC_AGGREGATE_VISIBILITY_VERSION_KEY],
      sql: `select value from settings where key = ?`,
    });

    expect(marker.rows[0]?.value).toBe(PUBLIC_AGGREGATE_VISIBILITY_VERSION);
    expect(await readProjectedDefaultTrackTotal(db)).toBe(3);
    expect(await members()).toEqual(["long-finding", "music", "spoken"]);
  });

  it("closes projected reads while the stored projection answers an older rule", async () => {
    await simulateProjectionBuiltUnderOlderRule();

    expect(await readProjectedDefaultTrackTotal(db)).toBeUndefined();
    expect(await readProjectedAggregateBuckets(db, "key")).toBeUndefined();
    expect(
      (await getProjectionStatusFor(db)).projections.publicAggregates.durationGenerationReady,
    ).toBe(false);
  });

  it("heals every membership change, long-form findings included, through bounded maintenance repair", async () => {
    await simulateProjectionBuiltUnderOlderRule();

    await repairUntilComplete();

    expect(await members()).toEqual(["long-finding", "music"]);
    expect(await readProjectedDefaultTrackTotal(db)).toBe(2);
    expect(await readProjectedAggregateBuckets(db, "key")).toEqual([
      { bucket: "Am", count: 1 },
      { bucket: "F#m", count: 1 },
    ]);
    const status = await getProjectionStatusFor(db);
    expect(status.projections.publicAggregates.durationGenerationReady).toBe(true);
    const cursor = await db.execute({
      args: [PUBLIC_AGGREGATE_VISIBILITY_CURSOR_KEY],
      sql: `select value from settings where key = ?`,
    });
    expect(cursor.rows).toHaveLength(0);
  });

  it("reports a walked window with no disagreement as progress, not as a stall", async () => {
    await db.execute({
      args: [PUBLIC_AGGREGATE_VISIBILITY_VERSION_KEY],
      sql: `update settings set value = 'older-rule' where key = ?`,
    });

    const walked = await advanceProjectionFor(db, {
      action: "repair",
      includeStatus: false,
      limit: 2,
      target: "public_aggregates",
    });

    expect(walked).toMatchObject({
      complete: false,
      processed: 3,
      rebuildRowsWalked: 3,
      rebuildStaleFamilies: 1,
      scheduled: 0,
    });
    await repairUntilComplete();
    expect(await readProjectedDefaultTrackTotal(db)).toBe(3);
  });

  it("counts each table row once even when the repair limit cuts a window short", async () => {
    await simulateProjectionBuiltUnderOlderRule();

    const steps = [];
    for (let step = 0; step < 10; step += 1) {
      const result = await reconcilePublicAggregateVisibilityChunk(db, { limit: 1, now: NOW });
      steps.push(result);
      if (result.complete) {
        break;
      }
    }

    expect(steps.map((step) => step.scanned)).toEqual([1, 2, 0]);
    expect(steps.reduce((total, step) => total + step.enqueued, 0)).toBe(2);
    expect(steps.at(-1)).toMatchObject({ complete: true, walked: true });
  });

  it("keeps the walk diagnostic on the step that stamps the version", async () => {
    await db.execute({
      args: [PUBLIC_AGGREGATE_VISIBILITY_VERSION_KEY],
      sql: `update settings set value = 'older-rule' where key = ?`,
    });
    const advance = () =>
      advanceProjectionFor(db, {
        action: "repair",
        includeStatus: false,
        limit: 2,
        target: "public_aggregates",
      });

    await advance();
    const stamping = await advance();

    expect(stamping).toMatchObject({ rebuildRowsWalked: 0, rebuildStaleFamilies: 0 });
    const settled = await advance();
    expect(settled).not.toHaveProperty("rebuildRowsWalked");
  });

  it("walks the table in bounded windows and resumes from its durable cursor", async () => {
    await simulateProjectionBuiltUnderOlderRule();

    const first = await reconcilePublicAggregateVisibilityChunk(db, {
      limit: 10,
      now: NOW,
      scanWindow: 2,
    });
    expect(first).toEqual({ complete: false, enqueued: 1, scanned: 2, walked: true });
    const second = await reconcilePublicAggregateVisibilityChunk(db, {
      limit: 10,
      now: NOW,
      scanWindow: 2,
    });
    expect(second).toEqual({ complete: false, enqueued: 1, scanned: 1, walked: true });
    const third = await reconcilePublicAggregateVisibilityChunk(db, {
      limit: 10,
      now: NOW,
      scanWindow: 2,
    });
    expect(third).toEqual({ complete: true, enqueued: 0, scanned: 0, walked: true });
    const queued = await db.execute(
      `select subject_id from projection_repairs where projection = 'public_aggregates'
        order by subject_id`,
    );
    expect(queued.rows.map((row) => row.subject_id)).toEqual(["long-finding", "spoken"]);
  });
});
