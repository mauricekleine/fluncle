import { type Client, type InStatement } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  batchDueWorkSourceMutation,
  DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
  DUE_WORK_SOURCE_REPAIR_KIND,
  listReadyDueWork,
  markDueWorkSourceRepairsStatement,
} from "./due-work";
import { CATALOGUE_RANK_STATE_KEY } from "./catalogue";
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
  it.each([0, 501, 1.5, Number.POSITIVE_INFINITY])(
    "rejects invalid ordinary source limits before applying the hosted cap: %s",
    async (limit) => {
      await seedCatalogueTrack(db, { trackId: "invalid-ordinary-limit" });
      await db.execute(
        markDueWorkSourceRepairsStatement(
          [{ subjectId: "invalid-ordinary-limit", subjectType: "track" }],
          { markerVersion: "invalid-ordinary-v1", producer: "capture-verification" },
        ),
      );

      await expect(
        fanOutDueWorkSourceRepairs(db, { includeCatalogueRank: false, limit }),
      ).rejects.toThrow("due-work limit must be an integer from 1 through 500");
      expect(
        (
          await db.execute({
            args: [DUE_WORK_SOURCE_REPAIR_KIND, "invalid-ordinary-limit"],
            sql: `select subject_id from due_work where work_kind = ? and subject_id = ?`,
          })
        ).rows,
      ).toHaveLength(1);
    },
  );

  it.each([0, 501, 1.5, Number.POSITIVE_INFINITY])(
    "rejects invalid catalogue-rank limits before starting a rebuild: %s",
    async (limit) => {
      await db.execute(
        markDueWorkSourceRepairsStatement(
          [
            {
              subjectId: DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
              subjectType: "track",
            },
          ],
          { markerVersion: "invalid-rank-v1", producer: "catalogue-rank" },
        ),
      );

      await expect(fanOutDueWorkSourceRepairs(db, { limit })).rejects.toThrow(
        "due-work limit must be an integer from 1 through 500",
      );
      expect(
        (
          await db.execute({
            args: [DUE_WORK_SOURCE_REPAIR_KIND, DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID],
            sql: `select subject_id from due_work where work_kind = ? and subject_id = ?`,
          })
        ).rows,
      ).toHaveLength(1);
    },
  );

  it("converges one track marker directly into final queue rows", async () => {
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
    expect(markers.rows.some((row) => row.state === "repair")).toBe(false);

    expect(
      (await listReadyDueWork(db, "embed-catalogue")).items.map((row) => row.subjectId),
    ).toEqual(["repair-track"]);
  });

  it("uses the maintained rank corpus cache for ordinary track source repair", async () => {
    await seedCatalogueTrack(db, { trackId: "cached-rank-repair" });
    await db.batch(
      [
        {
          args: [
            CATALOGUE_RANK_STATE_KEY,
            JSON.stringify({ corpus: "v5:0:0:0:cached", embeddedFindings: 0, findings: 0 }),
          ],
          sql: `insert into settings (key, value) values (?, ?)`,
        },
        markDueWorkSourceRepairsStatement(
          [{ subjectId: "cached-rank-repair", subjectType: "track" }],
          { markerVersion: "cached-rank-v1", producer: "capture-verification" },
        ),
      ],
      "write",
    );
    const cacheOnlyClient = {
      batch: db.batch.bind(db),
      execute: async (statement: InStatement | string) => {
        const sql = typeof statement === "string" ? statement : statement.sql;
        if (
          sql.includes("from findings cross join tracks ft") ||
          sql.includes("having sum(case when ta.role = 'remixer'")
        ) {
          throw new Error("ordinary repair recomputed the live rank corpus");
        }
        return typeof statement === "string" ? db.execute(statement) : db.execute(statement);
      },
    };

    await expect(fanOutDueWorkSourceRepairs(cacheOnlyClient, { limit: 1 })).resolves.toMatchObject({
      expanded: 1,
      scanned: 1,
    });
  });

  it("caps a requested 500-source page and continues from the durable marker set", async () => {
    const subjects = Array.from({ length: 6 }, (_, index) => ({
      subjectId: `wide-fanout-${String(index).padStart(3, "0")}`,
      subjectType: "track" as const,
    }));
    await db.execute({
      args: subjects.flatMap(({ subjectId }) => [
        subjectId,
        `Track ${subjectId}`,
        '["Test Artist"]',
        `spotify:track:${subjectId}`,
        270_000,
      ]),
      sql: `insert into tracks
        (track_id, title, artists_json, spotify_uri, duration_ms)
        values ${subjects.map(() => "(?, ?, ?, ?, ?)").join(", ")}`,
    });
    await db.batch(
      [
        {
          args: ["wide-fanout-000/audio.webm", "wide-fanout-000"],
          sql: `update tracks set source_audio_key = ?, capture_status = 'done'
            where track_id = ?`,
        },
        {
          args: ["2026-08-26T12:00:00.000Z", "wide-fanout-001"],
          sql: `update tracks set capture_status = 'failed', capture_priority = 0,
            source_audio_failures = 1, source_audio_attempted_at = ? where track_id = ?`,
        },
      ],
      "write",
    );
    await db.execute(
      markDueWorkSourceRepairsStatement(subjects, {
        markerVersion: "wide-fanout-v1",
        now: "2026-08-26T12:00:00.000Z",
        producer: "capture-verification",
      }),
    );

    let batchCalls = 0;
    let executeCalls = 0;
    let maximumBatchArgs = 0;
    let maximumBatchStatements = 0;
    let maximumStatementArgs = 0;
    let removalStatement: Exclude<InStatement, string> | undefined;
    const recordArgs = (statement: InStatement): void => {
      if (typeof statement !== "string" && Array.isArray(statement.args)) {
        maximumStatementArgs = Math.max(maximumStatementArgs, statement.args.length);
      }
    };
    const measuredClient = {
      batch: (statements: InStatement[], mode?: Parameters<Client["batch"]>[1]) => {
        batchCalls += 1;
        maximumBatchStatements = Math.max(maximumBatchStatements, statements.length);
        maximumBatchArgs = Math.max(
          maximumBatchArgs,
          statements.reduce(
            (total, statement) =>
              total +
              (typeof statement !== "string" && Array.isArray(statement.args)
                ? statement.args.length
                : 0),
            0,
          ),
        );
        for (const statement of statements) {
          recordArgs(statement);
          const sql = typeof statement === "string" ? statement : statement.sql;
          if (
            typeof statement !== "string" &&
            sql.includes("delete from due_work") &&
            sql.includes("from candidate")
          ) {
            removalStatement = statement;
          }
        }
        return db.batch(statements, mode);
      },
      execute: (...args: Parameters<Client["execute"]>) => {
        executeCalls += 1;
        recordArgs(args[0]);
        return db.execute(...args);
      },
    };
    const first = await fanOutDueWorkSourceRepairs(measuredClient, { limit: 500 });
    expect(first).toMatchObject({ deferred: 0, expanded: 5, hasMore: true, scanned: 5 });
    // A missing rank-state cache pays one bounded read plus one fill before later pages become
    // cache-only. The source page itself remains capped at five markers.
    expect(executeCalls).toBeLessThanOrEqual(9);
    expect(batchCalls).toBe(1);
    expect(maximumBatchStatements).toBeLessThanOrEqual(4);
    expect(maximumStatementArgs).toBeLessThanOrEqual(2_040);
    expect(maximumBatchArgs).toBeLessThanOrEqual(3_100);
    expect(
      Number(
        (
          await db.execute({
            args: [DUE_WORK_SOURCE_REPAIR_KIND],
            sql: `select count(*) as n from due_work where work_kind = ?`,
          })
        ).rows[0]?.n ?? 0,
      ),
    ).toBe(1);

    const second = await fanOutDueWorkSourceRepairs(measuredClient, { limit: 500 });
    expect(second).toMatchObject({ deferred: 0, expanded: 1, hasMore: false, scanned: 1 });
    expect(batchCalls).toBe(2);
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
    ).toBe(0);
    expect(
      (await listReadyDueWork(db, "embed-catalogue")).items.map((row) => row.subjectId),
    ).toEqual(["wide-fanout-000"]);
    expect(
      Number(
        (
          await db.execute({
            args: ["artist-edges"],
            sql: `select count(*) as n from due_work where work_kind = ?`,
          })
        ).rows[0]?.n ?? 0,
      ),
    ).toBe(6);
    expect(
      (
        await db.execute({
          args: ["capture-catalogue", "wide-fanout-001"],
          sql: `select state from due_work where work_kind = ? and subject_id = ?`,
        })
      ).rows[0],
    ).toMatchObject({ state: "scheduled" });
    if (removalStatement === undefined) {
      throw new Error("source repair did not emit the obsolete-row delete");
    }
    const removalPlan = (
      await db.execute({
        args: removalStatement.args,
        sql: `explain query plan ${removalStatement.sql}`,
      })
    ).rows.map((row) => (typeof row.detail === "string" ? row.detail : ""));
    expect(removalPlan).toContainEqual(expect.stringContaining("SEARCH due_work USING"));
    expect(removalPlan).not.toContainEqual(expect.stringMatching(/^SCAN due_work$/));
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
    const projection = await db.execute({
      args: ["album.cover-master"],
      sql: `select subject_id, state from due_work where work_kind = ?`,
    });
    expect(projection.rows[0]).toMatchObject({ state: "ready", subject_id: "album-slug" });
    expect(
      (await listReadyDueWork(db, "album.cover-master")).items.map((row) => row.subjectId),
    ).toEqual(["album-slug"]);
  });

  it("deletes an ineligible projection while clearing its source marker", async () => {
    await db.batch(
      [
        {
          args: [],
          sql: `insert into due_work
            (work_kind, subject_type, subject_id, state, sort_key, next_due_at, source_version,
             generation, updated_at)
            values ('embed-catalogue', 'track', 'deleted-track', 'ready', '', '', 'old',
              'live', '2026-08-26T12:00:00.000Z')`,
        },
        markDueWorkSourceRepairsStatement([{ subjectId: "deleted-track", subjectType: "track" }], {
          markerVersion: "deleted-v1",
          producer: "capture-verification",
        }),
      ],
      "write",
    );

    expect(await fanOutDueWorkSourceRepairs(db, { limit: 1 })).toMatchObject({
      deferred: 0,
      expanded: 1,
    });
    expect(
      (
        await db.execute({
          args: ["deleted-track"],
          sql: `select work_kind from due_work where subject_id = ?`,
        })
      ).rows,
    ).toEqual([]);
  });

  it("preserves a newer source marker and projection row across evaluation", async () => {
    await seedCatalogueTrack(db, { trackId: "raced-track" });
    await db.execute({
      args: ["raced-track/audio.webm", "raced-track"],
      sql: `update tracks set source_audio_key = ?, capture_status = 'done' where track_id = ?`,
    });
    await db.execute(
      markDueWorkSourceRepairsStatement([{ subjectId: "raced-track", subjectType: "track" }], {
        markerVersion: "raced-v1",
        producer: "capture-verification",
      }),
    );
    let raced = false;
    const racingClient = {
      batch: async (statements: InStatement[], mode?: Parameters<Client["batch"]>[1]) => {
        const isConvergence = statements.some((statement) =>
          typeof statement === "string" ? false : statement.sql.includes("marker_source_version"),
        );
        if (!raced && isConvergence) {
          raced = true;
          await db.batch(
            [
              markDueWorkSourceRepairsStatement(
                [{ subjectId: "raced-track", subjectType: "track" }],
                { markerVersion: "raced-v2", producer: "capture-verification" },
              ),
              {
                args: [],
                sql: `insert into due_work
                  (work_kind, subject_type, subject_id, state, sort_key, next_due_at,
                   source_version, generation, updated_at)
                  values ('embed-catalogue', 'track', 'raced-track', 'scheduled', 'newer',
                    '2099-01-01T00:00:00.000Z', 'newer-projection', 'live',
                    '2026-08-26T12:00:00.000Z')
                  on conflict(work_kind, subject_type, subject_id) do update set
                    state = excluded.state, sort_key = excluded.sort_key,
                    next_due_at = excluded.next_due_at,
                    source_version = excluded.source_version`,
              },
            ],
            "write",
          );
        }
        return db.batch(statements, mode);
      },
      execute: db.execute.bind(db),
    };

    expect(await fanOutDueWorkSourceRepairs(racingClient, { limit: 1 })).toMatchObject({
      deferred: 1,
      expanded: 0,
    });
    expect(
      (
        await db.execute({
          args: [DUE_WORK_SOURCE_REPAIR_KIND, "raced-track"],
          sql: `select source_version from due_work where work_kind = ? and subject_id = ?`,
        })
      ).rows[0],
    ).toMatchObject({ source_version: "raced-v2" });
    expect(
      (
        await db.execute({
          args: ["embed-catalogue", "raced-track"],
          sql: `select state, source_version from due_work where work_kind = ? and subject_id = ?`,
        })
      ).rows[0],
    ).toMatchObject({ source_version: "newer-projection", state: "scheduled" });
  });

  it("preserves a newer marker and target row after an obsolete-row decision", async () => {
    await seedCatalogueTrack(db, { trackId: "removed-race-track" });
    await db.batch(
      [
        {
          args: [],
          sql: `insert into due_work
            (work_kind, subject_type, subject_id, state, sort_key, next_due_at,
             source_version, generation, updated_at)
            values ('embed-catalogue', 'track', 'removed-race-track', 'ready', '', '', 'old',
              'live', '2026-08-26T12:00:00.000Z')`,
        },
        markDueWorkSourceRepairsStatement(
          [{ subjectId: "removed-race-track", subjectType: "track" }],
          { markerVersion: "removed-race-v1", producer: "capture-verification" },
        ),
      ],
      "write",
    );
    let raced = false;
    const racingClient = {
      batch: async (statements: InStatement[], mode?: Parameters<Client["batch"]>[1]) => {
        const isConvergence = statements.some((statement) =>
          typeof statement === "string" ? false : statement.sql.includes("marker_source_version"),
        );
        if (!raced && isConvergence) {
          raced = true;
          await db.batch(
            [
              markDueWorkSourceRepairsStatement(
                [{ subjectId: "removed-race-track", subjectType: "track" }],
                { markerVersion: "removed-race-v2", producer: "capture-verification" },
              ),
              {
                args: [],
                sql: `update due_work set state = 'scheduled', sort_key = 'newer',
                    next_due_at = '2099-01-01T00:00:00.000Z', source_version = 'newer-projection'
                  where work_kind = 'embed-catalogue' and subject_type = 'track'
                    and subject_id = 'removed-race-track'`,
              },
            ],
            "write",
          );
        }
        return db.batch(statements, mode);
      },
      execute: db.execute.bind(db),
    };

    expect(await fanOutDueWorkSourceRepairs(racingClient, { limit: 1 })).toMatchObject({
      deferred: 1,
      expanded: 0,
    });
    expect(
      (
        await db.execute({
          args: [DUE_WORK_SOURCE_REPAIR_KIND, "removed-race-track"],
          sql: `select source_version from due_work where work_kind = ? and subject_id = ?`,
        })
      ).rows[0],
    ).toMatchObject({ source_version: "removed-race-v2" });
    expect(
      (
        await db.execute({
          args: ["embed-catalogue", "removed-race-track"],
          sql: `select state, source_version from due_work where work_kind = ? and subject_id = ?`,
        })
      ).rows[0],
    ).toMatchObject({ source_version: "newer-projection", state: "scheduled" });
  });

  it("isolates a requested 500-row rank page before resuming ordinary marker work", async () => {
    const trackIds = Array.from(
      { length: 501 },
      (_, index) => `rank-${String(index).padStart(3, "0")}`,
    );
    for (const trackId of trackIds) {
      await seedCatalogueTrack(db, { trackId });
    }
    await db.execute({
      args: [
        CATALOGUE_RANK_STATE_KEY,
        JSON.stringify({ corpus: "v5:stale", embeddedFindings: 0, findings: 0 }),
      ],
      sql: `insert into settings (key, value) values (?, ?)`,
    });
    await db.execute(
      markDueWorkSourceRepairsStatement(
        [
          {
            subjectId: DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
            subjectType: "track",
          },
          { subjectId: "rank-500", subjectType: "track" },
        ],
        { markerVersion: "rank-corpus-v1", producer: "catalogue-rank" },
      ),
    );
    let corpusRefreshes = 0;
    const countedClient = {
      batch: db.batch.bind(db),
      execute: async (statement: InStatement | string) => {
        const sql = typeof statement === "string" ? statement : statement.sql;
        if (sql.includes("from findings cross join tracks ft")) {
          corpusRefreshes += 1;
        }
        return typeof statement === "string" ? db.execute(statement) : db.execute(statement);
      },
    };

    const first = await fanOutDueWorkSourceRepairs(countedClient, { limit: 500 });
    expect(first).toMatchObject({
      deferred: 1,
      expanded: 0,
      hasMore: true,
      rankRebuildScanned: 500,
      scanned: 1,
    });
    expect((await listReadyDueWork(db, "catalogue-rank", { limit: 500 })).items).toHaveLength(500);
    expect((await listReadyDueWork(db, "artist-edges", { limit: 500 })).items).toHaveLength(0);
    const refreshedRankState = await db.execute({
      args: [CATALOGUE_RANK_STATE_KEY],
      sql: `select value from settings where key = ?`,
    });
    const refreshedValue = refreshedRankState.rows[0]?.value;
    if (typeof refreshedValue !== "string") {
      throw new Error("catalogue rank state cache was not persisted");
    }
    expect(refreshedValue).not.toContain("v5:stale");

    const second = await fanOutDueWorkSourceRepairs(countedClient, { limit: 500 });
    expect(second).toMatchObject({
      deferred: 0,
      expanded: 1,
      hasMore: true,
      rankRebuildScanned: 1,
      scanned: 1,
    });
    expect(
      Number(
        (
          await db.execute({
            args: ["catalogue-rank"],
            sql: `select count(*) as n from due_work where work_kind = ? and state = 'ready'`,
          })
        ).rows[0]?.n ?? 0,
      ),
    ).toBe(501);
    expect((await listReadyDueWork(db, "artist-edges", { limit: 500 })).items).toHaveLength(0);

    expect(await fanOutDueWorkSourceRepairs(countedClient, { limit: 500 })).toMatchObject({
      deferred: 0,
      expanded: 1,
      hasMore: false,
      rankRebuildScanned: 0,
      scanned: 1,
    });
    expect(corpusRefreshes).toBe(1);
    expect((await listReadyDueWork(db, "artist-edges", { limit: 500 })).items).toHaveLength(1);
    const sourceMarker = await db.execute({
      args: [DUE_WORK_SOURCE_REPAIR_KIND, DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID],
      sql: `select subject_id from due_work where work_kind = ? and subject_id = ?`,
    });
    expect(sourceMarker.rows).toEqual([]);
  });

  it("finishes an owned rank generation before starting a newer corpus marker", async () => {
    for (const trackId of Array.from({ length: 6 }, (_, index) => `rank-roll-${index}`)) {
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
        { markerVersion: "rank-roll-v1", producer: "catalogue-rank" },
      ),
    );
    let corpusRefreshes = 0;
    const countedClient = {
      batch: db.batch.bind(db),
      execute: async (statement: InStatement | string) => {
        const sql = typeof statement === "string" ? statement : statement.sql;
        if (sql.includes("from findings cross join tracks ft")) {
          corpusRefreshes += 1;
        }
        return typeof statement === "string" ? db.execute(statement) : db.execute(statement);
      },
    };

    expect(await fanOutDueWorkSourceRepairs(countedClient, { limit: 5 })).toMatchObject({
      deferred: 1,
      rankRebuildScanned: 5,
    });
    await db.execute(
      markDueWorkSourceRepairsStatement(
        [
          {
            subjectId: DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
            subjectType: "track",
          },
        ],
        { markerVersion: "rank-roll-v2", producer: "catalogue-rank" },
      ),
    );

    expect(await fanOutDueWorkSourceRepairs(countedClient, { limit: 5 })).toMatchObject({
      deferred: 1,
      expanded: 0,
      rankRebuildScanned: 1,
    });
    expect(
      (
        await db.execute({
          args: ["catalogue-rank", "track"],
          sql: `select generation, scanned_count, state from due_work_rebuilds
            where work_kind = ? and subject_type = ?`,
        })
      ).rows[0],
    ).toMatchObject({ generation: "rank-roll-v1", scanned_count: 6, state: "complete" });
    expect(
      (
        await db.execute({
          args: [DUE_WORK_SOURCE_REPAIR_KIND, DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID],
          sql: `select source_version from due_work where work_kind = ? and subject_id = ?`,
        })
      ).rows[0],
    ).toMatchObject({ source_version: "rank-roll-v2" });
    expect(corpusRefreshes).toBe(1);

    expect(await fanOutDueWorkSourceRepairs(countedClient, { limit: 5 })).toMatchObject({
      deferred: 1,
      rankRebuildScanned: 5,
    });
    expect(
      (
        await db.execute({
          args: ["catalogue-rank", "track"],
          sql: `select generation, scanned_count, state from due_work_rebuilds
            where work_kind = ? and subject_type = ?`,
        })
      ).rows[0],
    ).toMatchObject({ generation: "rank-roll-v2", scanned_count: 5, state: "running" });
    expect(corpusRefreshes).toBe(2);

    expect(await fanOutDueWorkSourceRepairs(countedClient, { limit: 5 })).toMatchObject({
      deferred: 0,
      expanded: 1,
      rankRebuildScanned: 1,
    });
    expect(
      (
        await db.execute({
          args: [DUE_WORK_SOURCE_REPAIR_KIND, DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID],
          sql: `select source_version from due_work where work_kind = ? and subject_id = ?`,
        })
      ).rows,
    ).toEqual([]);
  });

  it("defers a completed rank rebuild when a newer corpus marker wins the clear race", async () => {
    for (const trackId of ["rank-race-a", "rank-race-b"]) {
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
        { markerVersion: "rank-race-v1", producer: "catalogue-rank" },
      ),
    );
    let raced = false;
    const racingClient = {
      batch: async (statements: InStatement[], mode?: Parameters<Client["batch"]>[1]) => {
        const clearsSourceMarker = statements.some((statement) => {
          if (typeof statement === "string" || !Array.isArray(statement.args)) {
            return false;
          }
          return (
            statement.args[0] === DUE_WORK_SOURCE_REPAIR_KIND &&
            statement.args[2] === DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID &&
            statement.sql.startsWith("delete from due_work")
          );
        });
        if (!raced && clearsSourceMarker) {
          raced = true;
          await db.execute(
            markDueWorkSourceRepairsStatement(
              [
                {
                  subjectId: DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
                  subjectType: "track",
                },
              ],
              { markerVersion: "rank-race-v2", producer: "catalogue-rank" },
            ),
          );
        }
        return db.batch(statements, mode);
      },
      execute: db.execute.bind(db),
    };

    expect(await fanOutDueWorkSourceRepairs(racingClient, { limit: 500 })).toMatchObject({
      deferred: 1,
      expanded: 0,
      hasMore: true,
      rankRebuildScanned: 2,
    });
    expect(
      (
        await db.execute({
          args: [DUE_WORK_SOURCE_REPAIR_KIND, DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID],
          sql: `select source_version from due_work where work_kind = ? and subject_id = ?`,
        })
      ).rows[0],
    ).toMatchObject({ source_version: "rank-race-v2" });
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
