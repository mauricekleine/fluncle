import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  batchDueWorkSourceMutation,
  DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
  DUE_WORK_SOURCE_REPAIR_KIND,
  listReadyDueWork,
  markDueWorkSourceRepairsStatement,
} from "./due-work";
import { fanOutDueWorkSourceRepairs, repairDueWorkBeforeRead } from "./due-work-source-repair";
import { DueWorkMaintenancePendingError } from "./due-work";
import { createIntegrationDb, seedAlbum, seedCatalogueTrack } from "./integration-db";

let db: Client;

beforeEach(async () => {
  db = await createIntegrationDb();
});

afterEach(() => {
  db.close();
});

describe("transactionally coupled due-work source repair", () => {
  it("fans one track marker out to every physical queue and repairs the requested queue", async () => {
    await seedCatalogueTrack(db, { trackId: "repair-track" });
    await batchDueWorkSourceMutation(
      db,
      [
        {
          args: ["repair-track/audio.webm", "repair-track"],
          sql: `update tracks set source_audio_key = ?, capture_status = 'done'
                where track_id = ?`,
        },
      ],
      [{ subjectId: "repair-track", subjectType: "track" }],
      { markerVersion: "track-source-v1", producer: "capture-verification" },
    );

    expect((await fanOutDueWorkSourceRepairs(db, { limit: 1 })).expanded).toBe(1);
    const markers = await db.execute(
      `select work_kind, state from due_work where subject_id = 'repair-track'`,
    );
    expect(markers.rows.some((row) => row.work_kind === DUE_WORK_SOURCE_REPAIR_KIND)).toBe(false);
    expect(markers.rows.filter((row) => row.state === "repair")).toHaveLength(34);

    await repairDueWorkBeforeRead(db, "embed-catalogue");
    expect(
      (await listReadyDueWork(db, "embed-catalogue")).items.map((row) => row.subjectId),
    ).toEqual(["repair-track"]);
  });

  it("fans out the full 500-source operator page in bounded set batches", async () => {
    const subjects = Array.from({ length: 500 }, (_, index) => ({
      subjectId: `wide-fanout-${String(index).padStart(3, "0")}`,
      subjectType: "track" as const,
    }));
    await db.execute(
      markDueWorkSourceRepairsStatement(subjects, {
        markerVersion: "wide-fanout-v1",
        producer: "capture-verification",
      }),
    );

    const result = await fanOutDueWorkSourceRepairs(db, { limit: 500 });
    expect(result).toMatchObject({ deferred: 0, expanded: 500, scanned: 500 });
    expect(
      Number(
        (
          await db.execute({
            args: [DUE_WORK_SOURCE_REPAIR_KIND],
            sql: `select count(*) as n from due_work where work_kind = ?`,
          })
        ).rows[0]?.n ?? 0,
      ),
    ).toBe(0);
    expect(
      Number(
        (
          await db.execute({
            args: [DUE_WORK_SOURCE_REPAIR_KIND],
            sql: `select count(*) as n from due_work where work_kind <> ? and state = 'repair'`,
          })
        ).rows[0]?.n ?? 0,
      ),
    ).toBe(17_000);
  });

  it("maps canonical entity markers onto slug-keyed artwork projections", async () => {
    await seedAlbum(db, { id: "album-id", slug: "album-slug" });
    await db.execute(
      markDueWorkSourceRepairsStatement([{ subjectId: "album-id", subjectType: "album" }], {
        markerVersion: "album-source-v1",
        producer: "album-bio-fill",
      }),
    );

    await fanOutDueWorkSourceRepairs(db, { limit: 1 });
    const marker = await db.execute({
      args: ["album.cover-master"],
      sql: `select subject_id, state from due_work where work_kind = ?`,
    });
    expect(marker.rows[0]).toMatchObject({ state: "repair", subject_id: "album-slug" });

    await repairDueWorkBeforeRead(db, "album.cover-master");
    expect(
      (await listReadyDueWork(db, "album.cover-master")).items.map((row) => row.subjectId),
    ).toEqual(["album-slug"]);
  });

  it("turns a coupled catalogue-corpus marker into a resumable rank rebuild", async () => {
    for (const trackId of ["rank-a", "rank-b", "rank-c"]) {
      await seedCatalogueTrack(db, { trackId });
    }
    await db.execute(
      markDueWorkSourceRepairsStatement(
        [
          {
            subjectId: DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
            subjectType: "track",
          },
        ],
        { markerVersion: "rank-corpus-v1", producer: "catalogue-rank" },
      ),
    );

    const result = await fanOutDueWorkSourceRepairs(db, { limit: 1 });
    expect(result).toMatchObject({ expanded: 1, rankRebuildScanned: 3 });
    expect((await listReadyDueWork(db, "catalogue-rank")).items).toHaveLength(3);
    const sourceMarker = await db.execute({
      args: [DUE_WORK_SOURCE_REPAIR_KIND, DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID],
      sql: `select subject_id from due_work where work_kind = ? and subject_id = ?`,
    });
    expect(sourceMarker.rows).toEqual([]);
  });

  it("repairs the requested subject family without unrelated or rank-marker head blocking", async () => {
    await seedAlbum(db, { id: "blocking-album", slug: "blocking-album" });
    await seedCatalogueTrack(db, { trackId: "target-track" });
    await db.execute({
      args: ["target-track/audio.webm", "target-track"],
      sql: `update tracks set source_audio_key = ?, capture_status = 'done' where track_id = ?`,
    });
    await db.batch(
      [
        markDueWorkSourceRepairsStatement([{ subjectId: "blocking-album", subjectType: "album" }], {
          markerVersion: "album-v1",
          producer: "album-bio-fill",
        }),
        markDueWorkSourceRepairsStatement(
          [
            {
              subjectId: DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
              subjectType: "track",
            },
          ],
          { markerVersion: "rank-v1", producer: "catalogue-rank" },
        ),
        markDueWorkSourceRepairsStatement([{ subjectId: "target-track", subjectType: "track" }], {
          markerVersion: "track-v1",
          producer: "capture-verification",
        }),
      ],
      "write",
    );

    await repairDueWorkBeforeRead(db, "embed-catalogue");

    expect(
      (await listReadyDueWork(db, "embed-catalogue")).items.map((row) => row.subjectId),
    ).toEqual(["target-track"]);
    const remaining = await db.execute({
      args: [DUE_WORK_SOURCE_REPAIR_KIND],
      sql: `select subject_id from due_work where work_kind = ? order by subject_id`,
    });
    expect(remaining.rows.map((row) => row.subject_id)).toEqual([
      DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
      "blocking-album",
    ]);
  });

  it("never exposes a partial queue while a bounded source-marker page is still pending", async () => {
    for (let index = 0; index < 6; index += 1) {
      const trackId = `pending-${index}`;
      await seedCatalogueTrack(db, { trackId });
      await db.execute(
        markDueWorkSourceRepairsStatement([{ subjectId: trackId, subjectType: "track" }], {
          markerVersion: `pending-v${index}`,
          producer: "capture-verification",
        }),
      );
    }

    await expect(repairDueWorkBeforeRead(db, "artist-edges")).rejects.toBeInstanceOf(
      DueWorkMaintenancePendingError,
    );
    await expect(repairDueWorkBeforeRead(db, "artist-edges")).resolves.toBeUndefined();
    expect((await listReadyDueWork(db, "artist-edges")).items).toHaveLength(6);
  });
});
