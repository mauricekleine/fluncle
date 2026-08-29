import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createIntegrationDb,
  seedAlbum,
  seedArtist,
  seedCatalogueTrack,
  seedLabel,
  seedTrack,
} from "./integration-db";
import { DUE_WORK_SOURCE_REPAIR_KIND } from "./due-work";

// THE HUB-COUNTS DRIFT BACKSTOP, PROVEN AGAINST THE REAL SCHEMA (docs/db-scale-backlog Wave 2
// keystone 2, slice C).
//
// Every case here fabricates drift the way production produces it — RAW edge writes with no delta
// (an out-of-band prune, a missed write path, the slice-A deploy-window skew that left 44 artists /
// 3 albums / 1 label wrong on rollout day) — then asserts the sweep both FIXES it and REPORTS the
// right number. The reported count is the operator's drift audit, so an over-count is as much a bug
// as a missed correction: `corrected` must be the number of rows that were actually WRONG, never
// the number of rows re-written.
//
// Driven against the in-memory libSQL harness with the real migrations applied, so the
// `UPDATE … FROM (… GROUP BY …)` under test is byte-identical to production's.

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

// Imported AFTER the mock so the module's `getDb` is the mocked one.
const { reconcileHubCounts } = await import("./hub-counts-reconcile");

type Counts = { certified: number; renderable: number };

async function counts(table: "albums" | "artists" | "labels", id: string): Promise<Counts> {
  const result = await db.execute({
    args: [id],
    sql: `select renderable_track_count as renderable, certified_finding_count as certified
          from ${table} where id = ?`,
  });
  const row = result.rows[0];

  return { certified: Number(row?.certified ?? -1), renderable: Number(row?.renderable ?? -1) };
}

/** Force a row's stored counters to an arbitrary (wrong) pair — the drift fabricator. */
async function setCounts(
  table: "albums" | "artists" | "labels",
  id: string,
  value: Counts,
): Promise<void> {
  await db.execute({
    args: [value.renderable, value.certified, id],
    sql: `update ${table}
            set renderable_track_count = ?, certified_finding_count = ?
          where id = ?`,
  });
}

beforeEach(async () => {
  db = await createIntegrationDb();
  await seedLabel(db, { id: "lab-1", name: "Hospital Records", slug: "hospital-records" });
  await seedAlbum(db, { id: "alb-1", name: "Sight To Behold", slug: "sight-to-behold" });
  await seedArtist(db, { id: "art-1", name: "Logistics", slug: "logistics" });
  await seedTrack(db, { logId: "004.7.2A", trackId: "t-cert-0000000000000a" });
  await seedTrack(db, { logId: "004.7.2B", trackId: "t-cert-0000000000000b" });
  await seedCatalogueTrack(db, { trackId: "t-cat-00000000000000a" });
  // The edges, written RAW (no deltas) — three linked tracks, two of them certified.
  await db.batch(
    [
      `update tracks set label_id = 'lab-1', album_id = 'alb-1'`,
      `insert into track_artists (track_id, artist_id, position)
       values ('t-cert-0000000000000a', 'art-1', 1),
              ('t-cert-0000000000000b', 'art-1', 1),
              ('t-cat-00000000000000a', 'art-1', 1)`,
      `update tracks set key = '8A', has_embedding = 1
       where track_id = 't-cert-0000000000000a'`,
    ],
    "write",
  );
});

describe("reconcileHubCounts — the grouped correction", () => {
  it("repairs the artist-grain rankable-track projection", async () => {
    await reconcileHubCounts();
    let row = await db.execute(`select rankable_track_count as n from artists where id = 'art-1'`);
    expect(Number(row.rows[0]?.n ?? -1)).toBe(1);

    await db.execute(`update artists set rankable_track_count = 9 where id = 'art-1'`);
    const result = await reconcileHubCounts();
    row = await db.execute(`select rankable_track_count as n from artists where id = 'art-1'`);
    expect(result.artists).toEqual({ corrected: 1 });
    expect(Number(row.rows[0]?.n ?? -1)).toBe(1);
  });
  it("corrects a drifted counter on all three tables and reports one row each", async () => {
    // The slice-A rollout shape: the edges exist, the counters were never moved for them.
    const result = await reconcileHubCounts();

    expect(result.labels).toEqual({ corrected: 1 });
    expect(result.albums).toEqual({ corrected: 1 });
    expect(result.artists).toEqual({ corrected: 1 });
    expect(await counts("labels", "lab-1")).toEqual({ certified: 2, renderable: 3 });
    expect(await counts("albums", "alb-1")).toEqual({ certified: 2, renderable: 3 });
    expect(await counts("artists", "art-1")).toEqual({ certified: 2, renderable: 3 });
    const repairs = await db.execute({
      args: [DUE_WORK_SOURCE_REPAIR_KIND],
      sql: `select subject_type, subject_id from due_work
            where work_kind = ? order by subject_type, subject_id`,
    });
    expect(repairs.rows).toEqual([
      { subject_id: "alb-1", subject_type: "album" },
      { subject_id: "art-1", subject_type: "artist" },
      { subject_id: "lab-1", subject_type: "label" },
    ]);
  });

  it("corrects an OVER-count too, not only an under-count", async () => {
    await setCounts("labels", "lab-1", { certified: 9, renderable: 12 });

    const result = await reconcileHubCounts();

    expect(result.labels).toEqual({ corrected: 1 });
    expect(await counts("labels", "lab-1")).toEqual({ certified: 2, renderable: 3 });
  });

  it("corrects a HALF-drifted pair (renderable right, certified wrong)", async () => {
    await setCounts("albums", "alb-1", { certified: 3, renderable: 3 });

    const result = await reconcileHubCounts();

    expect(result.albums).toEqual({ corrected: 1 });
    expect(await counts("albums", "alb-1")).toEqual({ certified: 2, renderable: 3 });
  });

  it("reports ZERO corrected on an already-correct archive — the healthy steady state", async () => {
    await reconcileHubCounts();
    const second = await reconcileHubCounts();

    expect(second.labels).toEqual({ corrected: 0 });
    expect(second.albums).toEqual({ corrected: 0 });
    expect(second.artists).toEqual({ corrected: 0 });
  });

  it("is idempotent — a third pass still writes nothing and reports nothing", async () => {
    await reconcileHubCounts();
    await reconcileHubCounts();
    const third = await reconcileHubCounts();

    expect(third).toMatchObject({
      albums: { corrected: 0 },
      artists: { corrected: 0 },
      labels: { corrected: 0 },
    });
    expect(await counts("artists", "art-1")).toEqual({ certified: 2, renderable: 3 });
  });

  it("reports a tookMs", async () => {
    const result = await reconcileHubCounts();

    expect(result.tookMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(result.tookMs)).toBe(true);
  });
});

describe("reconcileHubCounts — the zero-truth pass", () => {
  it("zeroes a label whose last track was deleted out of band", async () => {
    await reconcileHubCounts();
    // The out-of-band prune: the tracks vanish, the counters keep their stale non-zero reading and
    // the label appears in NO group, so only the zero pass can reach it.
    await db.execute(`delete from tracks`);
    expect(await counts("labels", "lab-1")).toEqual({ certified: 2, renderable: 3 });

    const result = await reconcileHubCounts();

    expect(result.labels).toEqual({ corrected: 1 });
    expect(await counts("labels", "lab-1")).toEqual({ certified: 0, renderable: 0 });
  });

  it("zeroes an emptied album and artist in the same pass", async () => {
    await reconcileHubCounts();
    await db.execute(`delete from tracks`);

    const result = await reconcileHubCounts();

    expect(result.albums).toEqual({ corrected: 1 });
    expect(result.artists).toEqual({ corrected: 1 });
    expect(await counts("albums", "alb-1")).toEqual({ certified: 0, renderable: 0 });
    expect(await counts("artists", "art-1")).toEqual({ certified: 0, renderable: 0 });
  });

  it("leaves an already-zero unlinked entity alone — it is not 'corrected'", async () => {
    await seedLabel(db, { id: "lab-empty", name: "Nothing Here", slug: "nothing-here" });

    const result = await reconcileHubCounts();

    // Only lab-1 drifted; the empty label is already truthful at 0/0 and must not inflate the count.
    expect(result.labels).toEqual({ corrected: 1 });
    expect(await counts("labels", "lab-empty")).toEqual({ certified: 0, renderable: 0 });
  });

  it("still zeroes when NO track carries the pointer at all (the NOT IN null trap)", async () => {
    // Every remaining track points at NO label. A `not in (select label_id from tracks)` without
    // the `is not null` filter would yield a NULL predicate here and silently match nothing.
    await reconcileHubCounts();
    await db.execute(`update tracks set label_id = null`);

    const result = await reconcileHubCounts();

    expect(result.labels).toEqual({ corrected: 1 });
    expect(await counts("labels", "lab-1")).toEqual({ certified: 0, renderable: 0 });
  });
});

describe("reconcileHubCounts — the pinned artists source (orphaned edges)", () => {
  it("does NOT count a track_artists edge whose track is gone", async () => {
    await reconcileHubCounts();
    // The production condition: the track row is deleted
    // out of band and its `track_artists` edge survives. The hub reads join `tracks`, so counting
    // the raw edge would 'correct' the counter into disagreeing with what renders.
    await db.execute(`delete from tracks where track_id = 't-cat-00000000000000a'`);

    const result = await reconcileHubCounts();

    expect(result.artists).toEqual({ corrected: 1 });
    // Two surviving tracks, both certified — the orphan contributes nothing.
    expect(await counts("artists", "art-1")).toEqual({ certified: 2, renderable: 2 });
  });

  it("zeroes an artist left holding ONLY orphaned edges", async () => {
    await reconcileHubCounts();
    await db.execute(`delete from tracks`);

    const result = await reconcileHubCounts();

    // The three edges survive the track delete; the zero pass carries the same join, so the artist
    // is zeroed rather than pinned at its stale reading.
    const edges = await db.execute(`select count(*) as n from track_artists`);
    expect(Number(edges.rows[0]?.n ?? 0)).toBe(3);
    expect(result.artists).toEqual({ corrected: 1 });
    expect(await counts("artists", "art-1")).toEqual({ certified: 0, renderable: 0 });
  });
});
