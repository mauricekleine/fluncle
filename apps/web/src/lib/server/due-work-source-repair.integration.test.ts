import { type Client, type InStatement } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  batchDueWorkSourceMutation,
  DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
  DUE_WORK_SOURCE_REPAIR_KIND,
  listReadyDueWork,
  markDueWorkRepair,
  markDueWorkSourceRepairsStatement,
  upsertDueWork,
} from "./due-work";
import { CATALOGUE_RANK_MATERIAL_REVISION_KEY, CATALOGUE_RANK_STATE_KEY } from "./catalogue";
import { fanOutDueWorkSourceRepairs, repairDueWorkBeforeRead } from "./due-work-source-repair";
import { DueWorkMaintenancePendingError } from "./due-work";
import { DUE_WORK_BACKFILLS } from "./due-work-registry";
import { createIntegrationDb, seedAlbum, seedCatalogueTrack, seedTrack } from "./integration-db";
import { advanceProjectionFor } from "./projection-operations";

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
    expect(executeCalls).toBeLessThanOrEqual(10);
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

  it("keeps rank and ordinary source transactions separate while both make progress", async () => {
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
      expanded: 1,
      hasMore: true,
      rankRebuildScanned: 100,
      scanned: 2,
    });
    expect((await listReadyDueWork(db, "catalogue-rank", { limit: 500 })).items).toHaveLength(101);
    expect((await listReadyDueWork(db, "artist-edges", { limit: 500 })).items).toHaveLength(1);
    const refreshedRankState = await db.execute({
      args: [CATALOGUE_RANK_STATE_KEY],
      sql: `select value from settings where key = ?`,
    });
    const refreshedValue = refreshedRankState.rows[0]?.value;
    if (typeof refreshedValue !== "string") {
      throw new Error("catalogue rank state cache was not persisted");
    }
    expect(refreshedValue).not.toContain("v5:stale");

    let last = first;
    for (let step = 0; step < 8 && last.hasMore; step += 1) {
      last = await fanOutDueWorkSourceRepairs(countedClient, { limit: 500 });
    }
    expect(last).toMatchObject({ deferred: 0, expanded: 1, hasMore: false });
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
    expect(corpusRefreshes).toBe(2);
    expect((await listReadyDueWork(db, "artist-edges", { limit: 500 })).items).toHaveLength(1);
    const sourceMarker = await db.execute({
      args: [DUE_WORK_SOURCE_REPAIR_KIND, DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID],
      sql: `select subject_id from due_work where work_kind = ? and subject_id = ?`,
    });
    expect(sourceMarker.rows).toEqual([]);
  });

  it("gives rank, ordinary source, and physical repair bounded progress in one action", async () => {
    const ordinary = Array.from({ length: 210 }, (_, index) => ({
      subjectId: `fair-${String(index).padStart(3, "0")}`,
      subjectType: "track" as const,
    }));
    await db.execute({
      args: ordinary.flatMap(({ subjectId }) => [
        subjectId,
        `Track ${subjectId}`,
        '["Test Artist"]',
        `spotify:track:${subjectId}`,
        270_000,
      ]),
      sql: `insert into tracks
        (track_id, title, artists_json, spotify_uri, duration_ms)
        values ${ordinary.map(() => "(?, ?, ?, ?, ?)").join(", ")}`,
    });
    await seedCatalogueTrack(db, { trackId: "fair-physical" });
    await db.batch(
      [
        markDueWorkSourceRepairsStatement(ordinary, {
          markerVersion: "fair-ordinary-v1",
          producer: "capture-verification",
        }),
        markDueWorkSourceRepairsStatement(
          [
            {
              subjectId: DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
              subjectType: "track",
            },
          ],
          { markerVersion: "fair-rank-v0", producer: "catalogue-rank" },
        ),
      ],
      "write",
    );
    await markDueWorkRepair(db, {
      sourceVersion: "fair-physical-v1",
      subjectId: "fair-physical",
      subjectType: "track",
      workKind: "artist-edges",
    });

    const rankPageCursors: string[] = [];
    let batchCalls = 0;
    let executeCalls = 0;
    let maximumBatchStatements = 0;
    let maximumReadRows = 0;
    let maximumStatementArgs = 0;
    const traced = {
      batch: async (statements: InStatement[], mode?: Parameters<Client["batch"]>[1]) => {
        batchCalls += 1;
        maximumBatchStatements = Math.max(maximumBatchStatements, statements.length);
        for (const statement of statements) {
          if (typeof statement !== "string" && Array.isArray(statement.args)) {
            maximumStatementArgs = Math.max(maximumStatementArgs, statement.args.length);
          }
        }
        const results = await db.batch(statements, mode);
        maximumReadRows = Math.max(maximumReadRows, ...results.map((result) => result.rows.length));
        return results;
      },
      execute: async (statement: InStatement | string) => {
        executeCalls += 1;
        const sql = typeof statement === "string" ? statement : statement.sql;
        if (
          typeof statement !== "string" &&
          Array.isArray(statement.args) &&
          sql.includes("t.catalogue_rank_corpus") &&
          sql.includes("where t.track_id > ?")
        ) {
          const cursor = statement.args[0];
          if (typeof cursor !== "string") {
            throw new Error("catalogue-rank page cursor is not a string");
          }
          rankPageCursors.push(cursor);
        }
        const result =
          typeof statement === "string" ? await db.execute(statement) : await db.execute(statement);
        maximumReadRows = Math.max(maximumReadRows, result.rows.length);
        return result;
      },
    };

    const first = await advanceProjectionFor(traced, {
      action: "repair",
      includeStatus: false,
      limit: 500,
      target: "track_due_work",
    });
    expect(first.complete).toBe(false);
    expect(
      Number(
        (
          await db.execute(`select count(*) as n from due_work
            where work_kind = '${DUE_WORK_SOURCE_REPAIR_KIND}'
              and subject_id <> '${DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID}'`)
        ).rows[0]?.n ?? 0,
      ),
    ).toBe(205);
    expect(
      (
        await db.execute(`select state from due_work
          where work_kind = 'artist-edges' and subject_id = 'fair-physical'`)
      ).rows[0],
    ).toMatchObject({ state: "ready" });
    expect(
      (
        await db.execute(`select scanned_count from due_work_rebuilds
          where work_kind = 'catalogue-rank' and subject_type = 'track'`)
      ).rows[0],
    ).toMatchObject({ scanned_count: 100 });
    // limit=500 still performs exactly 5 ordinary + 100 rank + 1 physical units here.
    expect(batchCalls + executeCalls).toBe(53);
    expect({
      batchCalls,
      executeCalls,
      maximumBatchStatements,
      maximumReadRows,
      maximumStatementArgs,
    }).toEqual({
      batchCalls: 4,
      executeCalls: 49,
      maximumBatchStatements: 101,
      maximumReadRows: 100,
      maximumStatementArgs: 960,
    });

    let actions = 1;
    for (let marker = 1; marker < 10; marker += 1) {
      await db.execute(
        markDueWorkSourceRepairsStatement(
          [
            {
              subjectId: DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
              subjectType: "track",
            },
          ],
          { markerVersion: `fair-rank-v${marker}`, producer: "catalogue-rank" },
        ),
      );
      await advanceProjectionFor(traced, {
        action: "repair",
        includeStatus: false,
        limit: 100,
        target: "track_due_work",
      });
      actions += 1;
    }
    while (actions < 45) {
      const result = await advanceProjectionFor(traced, {
        action: "repair",
        includeStatus: false,
        limit: 100,
        target: "track_due_work",
      });
      actions += 1;
      if (result.complete) {
        break;
      }
    }

    expect(actions).toBeLessThanOrEqual(45);
    expect(
      Number(
        (await db.execute(`select count(*) as n from due_work where state = 'repair'`)).rows[0]
          ?.n ?? 0,
      ),
    ).toBe(0);
    expect(new Set(rankPageCursors).size).toBe(rankPageCursors.length);
    expect(rankPageCursors).toHaveLength(4);
    expect(
      Number(
        (
          await db.execute(`select scanned_count from due_work_rebuilds
            where work_kind = 'catalogue-rank' and subject_type = 'track'`)
        ).rows[0]?.scanned_count ?? 0,
      ),
    ).toBe(ordinary.length + 1);
  });

  it("bounds every repair lane while subject and rank writes continue", async () => {
    const subjectBatches = Array.from({ length: 40 }, (_, batch) =>
      Array.from({ length: 5 }, (_, offset) => ({
        subjectId: `continuous-${String(batch * 5 + offset).padStart(3, "0")}`,
        subjectType: "track" as const,
      })),
    );
    const subjects = subjectBatches.flat();
    const physicalSubjects = Array.from({ length: 60 }, (_, index) => ({
      subjectId: `continuous-physical-${String(index).padStart(3, "0")}`,
      subjectType: "track" as const,
    }));
    const sourceRows = [...subjects, ...physicalSubjects];
    await db.execute({
      args: sourceRows.flatMap(({ subjectId }) => [
        subjectId,
        `Track ${subjectId}`,
        '["Test Artist"]',
        `spotify:track:${subjectId}`,
        270_000,
      ]),
      sql: `insert into tracks
        (track_id, title, artists_json, spotify_uri, duration_ms)
        values ${sourceRows.map(() => "(?, ?, ?, ?, ?)").join(", ")}`,
    });
    for (const { subjectId } of physicalSubjects) {
      await markDueWorkRepair(db, {
        sourceVersion: `continuous-physical:${subjectId}`,
        subjectId,
        subjectType: "track",
        workKind: "artist-edges",
      });
    }

    const rankPageCursors: string[] = [];
    const traced = {
      batch: db.batch.bind(db),
      execute: async (statement: InStatement | string) => {
        if (typeof statement !== "string" && Array.isArray(statement.args)) {
          const sql = statement.sql;
          if (sql.includes("t.catalogue_rank_corpus") && sql.includes("where t.track_id > ?")) {
            const cursor = statement.args[0];
            if (typeof cursor !== "string") {
              throw new Error("catalogue-rank page cursor is not a string");
            }
            rankPageCursors.push(cursor);
          }
        }
        return typeof statement === "string" ? db.execute(statement) : db.execute(statement);
      },
    };
    let rankMarkersWritten = 0;

    for (const [step, batch] of subjectBatches.entries()) {
      const writes = [
        markDueWorkSourceRepairsStatement(batch, {
          markerVersion: `continuous-subject-v${step}`,
          producer: "capture-verification",
        }),
      ];
      if (step < 10) {
        rankMarkersWritten += 1;
        writes.push(
          markDueWorkSourceRepairsStatement(
            [
              {
                subjectId: DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
                subjectType: "track",
              },
            ],
            { markerVersion: `continuous-rank-v${step}`, producer: "catalogue-rank" },
          ),
        );
      }
      await db.batch(writes, "write");

      await advanceProjectionFor(traced, {
        action: "repair",
        includeStatus: false,
        limit: 500,
        target: "track_due_work",
      });

      const placeholders = batch.map(() => "?").join(", ");
      const remainingBatch = await db.execute({
        args: [DUE_WORK_SOURCE_REPAIR_KIND, ...batch.map(({ subjectId }) => subjectId)],
        sql: `select subject_id from due_work where work_kind = ?
          and subject_id in (${placeholders})`,
      });
      expect(remainingBatch.rows, `subject batch ${step} exceeded its one-action bound`).toEqual(
        [],
      );
      if (step === 0) {
        expect(
          Number(
            (
              await db.execute(`select count(*) as n from due_work
                where work_kind = 'artist-edges' and state = 'repair'`)
            ).rows[0]?.n ?? 0,
          ),
        ).toBe(10);
        expect(
          (
            await db.execute(`select scanned_count from due_work_rebuilds
              where work_kind = 'catalogue-rank' and subject_type = 'track'`)
          ).rows[0],
        ).toMatchObject({ scanned_count: 100 });
      }
    }

    expect(subjects).toHaveLength(200);
    expect(rankMarkersWritten).toBe(10);
    expect(rankPageCursors.length).toBeGreaterThanOrEqual(2);
    expect(new Set(rankPageCursors).size).toBe(rankPageCursors.length);
    expect(
      Number(
        (await db.execute(`select count(*) as n from due_work where state = 'repair'`)).rows[0]
          ?.n ?? 0,
      ),
    ).toBe(0);
  });

  it("coalesces ordinary same-semantic markers and refreshes changed rank definitions", async () => {
    for (const trackId of ["definition-a", "definition-b", "definition-c"]) {
      await seedCatalogueTrack(db, { trackId });
    }
    const rankMarker = (markerVersion: string) =>
      markDueWorkSourceRepairsStatement(
        [
          {
            subjectId: DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
            subjectType: "track" as const,
          },
        ],
        { markerVersion, producer: "catalogue-rank" },
      );
    await db.execute(rankMarker("definition-v1"));

    for (let step = 0; step < 3; step += 1) {
      await fanOutDueWorkSourceRepairs(db, { limit: 2 });
    }
    const first = await db.execute(`select generation, scanned_count from due_work_rebuilds
      where work_kind = 'catalogue-rank' and subject_type = 'track'`);
    const firstGeneration = first.rows[0]?.generation;
    expect(typeof firstGeneration).toBe("string");
    expect(first.rows[0]).toMatchObject({ scanned_count: 3 });

    await db.execute(rankMarker("definition-v2-same-corpus"));
    await fanOutDueWorkSourceRepairs(db, { limit: 2 });
    expect(
      (
        await db.execute(`select generation, scanned_count from due_work_rebuilds
          where work_kind = 'catalogue-rank' and subject_type = 'track'`)
      ).rows[0],
    ).toMatchObject({ generation: firstGeneration, scanned_count: 3 });

    await seedTrack(db, { logId: "001.1.1A", trackId: "definition-finding" });
    await db.execute(rankMarker("definition-v3-changed-corpus"));
    await fanOutDueWorkSourceRepairs(db, { limit: 2 });
    const changed = await db.execute(`select generation, scanned_count, state
      from due_work_rebuilds where work_kind = 'catalogue-rank' and subject_type = 'track'`);
    expect(changed.rows[0]?.generation).not.toBe(firstGeneration);
    expect(changed.rows[0]).toMatchObject({ scanned_count: 2, state: "running" });
    const changedGeneration = changed.rows[0]?.generation;
    expect(
      (
        await db.execute({
          args: [DUE_WORK_SOURCE_REPAIR_KIND, DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID],
          sql: `select source_version from due_work where work_kind = ? and subject_id = ?`,
        })
      ).rows[0],
    ).toMatchObject({ source_version: "definition-v3-changed-corpus" });

    expect(await fanOutDueWorkSourceRepairs(db, { limit: 2 })).toMatchObject({
      deferred: 1,
      rankRebuildScanned: 2,
    });
    expect(await fanOutDueWorkSourceRepairs(db, { limit: 2 })).toMatchObject({
      deferred: 1,
      rankRebuildScanned: 0,
    });
    expect(
      (
        await db.execute({
          args: [DUE_WORK_SOURCE_REPAIR_KIND, DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID],
          sql: `select source_version from due_work where work_kind = ? and subject_id = ?`,
        })
      ).rows[0],
    ).toMatchObject({ source_version: "definition-v3-changed-corpus" });
    expect(await fanOutDueWorkSourceRepairs(db, { limit: 2 })).toMatchObject({
      deferred: 0,
      expanded: 1,
      rankRebuildScanned: 0,
    });
    expect(
      (
        await db.execute(`select generation, scanned_count, state from due_work_rebuilds
          where work_kind = 'catalogue-rank' and subject_type = 'track'`)
      ).rows[0],
    ).toMatchObject({ generation: changedGeneration, scanned_count: 4, state: "complete" });
  });

  it("keeps catalogue-rank cleanup bounded before clearing its source marker", async () => {
    await seedCatalogueTrack(db, { trackId: "rank-bounded-current" });
    for (const subjectId of [
      "rank-bounded-stale-a",
      "rank-bounded-stale-b",
      "rank-bounded-stale-c",
    ]) {
      await upsertDueWork(
        db,
        {
          generation: "rank-bounded-stale-generation",
          nextDueAt: "2026-01-01T00:00:00.000Z",
          sortKey: subjectId,
          sourceVersion: "rank-bounded-stale-v1",
          state: "ready",
          subjectId,
          subjectType: "track",
          workKind: "catalogue-rank",
        },
        { now: "2026-01-01T00:00:00.000Z" },
      );
    }
    await db.execute(
      markDueWorkSourceRepairsStatement(
        [
          {
            subjectId: DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
            subjectType: "track",
          },
        ],
        { markerVersion: "rank-bounded-v1", producer: "catalogue-rank" },
      ),
    );

    expect(await fanOutDueWorkSourceRepairs(db, { limit: 2 })).toMatchObject({
      deferred: 1,
      expanded: 0,
      rankRebuildScanned: 1,
    });
    expect(await fanOutDueWorkSourceRepairs(db, { limit: 2 })).toMatchObject({
      deferred: 1,
      expanded: 0,
      rankRebuildScanned: 2,
    });
    expect(
      Number(
        (
          await db.execute({
            args: ["catalogue-rank", "rank-bounded-stale-generation"],
            sql: `select count(*) as n from due_work where work_kind = ? and generation = ?`,
          })
        ).rows[0]?.n ?? 0,
      ),
    ).toBe(1);
    expect(
      (
        await db.execute({
          args: ["catalogue-rank", "track"],
          sql: `select state from due_work_rebuilds where work_kind = ? and subject_type = ?`,
        })
      ).rows[0],
    ).toMatchObject({ state: "running" });
    expect(
      (
        await db.execute({
          args: [DUE_WORK_SOURCE_REPAIR_KIND, DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID],
          sql: `select subject_id from due_work where work_kind = ? and subject_id = ?`,
        })
      ).rows,
    ).toHaveLength(1);

    expect(await fanOutDueWorkSourceRepairs(db, { limit: 2 })).toMatchObject({
      deferred: 1,
      expanded: 0,
      rankRebuildScanned: 1,
    });
    expect(
      Number(
        (
          await db.execute({
            args: ["catalogue-rank", "rank-bounded-stale-generation"],
            sql: `select count(*) as n from due_work where work_kind = ? and generation = ?`,
          })
        ).rows[0]?.n ?? 0,
      ),
    ).toBe(0);
    expect(
      (
        await db.execute({
          args: [DUE_WORK_SOURCE_REPAIR_KIND, DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID],
          sql: `select subject_id from due_work where work_kind = ? and subject_id = ?`,
        })
      ).rows,
    ).toHaveLength(1);
    expect(
      (
        await db.execute({
          args: ["catalogue-rank", "track"],
          sql: `select state from due_work_rebuilds where work_kind = ? and subject_type = ?`,
        })
      ).rows[0],
    ).toMatchObject({ state: "complete" });
    expect(await fanOutDueWorkSourceRepairs(db, { limit: 2 })).toMatchObject({
      deferred: 0,
      expanded: 1,
      rankRebuildScanned: 0,
    });
  });

  it("finishes an owned rank generation and coalesces a newer same-corpus marker", async () => {
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
    const firstGenerationValue = (
      await db.execute({
        args: ["catalogue-rank", "track"],
        sql: `select generation from due_work_rebuilds
          where work_kind = ? and subject_type = ?`,
      })
    ).rows[0]?.generation;
    if (typeof firstGenerationValue !== "string") {
      throw new Error("catalogue-rank generation is missing");
    }
    const firstGeneration = firstGenerationValue;
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
    await db.execute({
      args: [
        JSON.stringify({ corpus: "v5:rollout-cache", embeddedFindings: 0, findings: 0 }),
        CATALOGUE_RANK_STATE_KEY,
      ],
      sql: "update settings set value = ? where key = ?",
    });

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
    ).toMatchObject({ generation: firstGeneration, scanned_count: 6, state: "running" });
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
      expanded: 0,
      rankRebuildScanned: 0,
    });
    expect(
      (
        await db.execute({
          args: ["catalogue-rank", "track"],
          sql: `select generation, scanned_count, state from due_work_rebuilds
            where work_kind = ? and subject_type = ?`,
        })
      ).rows[0],
    ).toMatchObject({ generation: firstGeneration, scanned_count: 6, state: "complete" });

    expect(await fanOutDueWorkSourceRepairs(countedClient, { limit: 5 })).toMatchObject({
      deferred: 0,
      expanded: 1,
      rankRebuildScanned: 0,
    });
    expect(
      (
        await db.execute({
          args: ["catalogue-rank", "track"],
          sql: `select generation, scanned_count, state from due_work_rebuilds
            where work_kind = ? and subject_type = ?`,
        })
      ).rows[0],
    ).toMatchObject({ generation: firstGeneration, scanned_count: 6, state: "complete" });
    expect(corpusRefreshes).toBe(2);
    expect(
      (
        await db.execute({
          args: [DUE_WORK_SOURCE_REPAIR_KIND, DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID],
          sql: `select source_version from due_work where work_kind = ? and subject_id = ?`,
        })
      ).rows,
    ).toEqual([]);
    const definition = DUE_WORK_BACKFILLS.find(
      (candidate) => candidate.workKind === "catalogue-rank",
    );
    if (definition === undefined) {
      throw new Error("catalogue-rank owned generation is missing");
    }
    const expectedVersions = new Map(
      (
        await definition.readSourceChunk({
          after: null,
          client: db,
          generation: firstGeneration,
          limit: 100,
        })
      ).map((source) => [source.subjectId, source.sourceVersion]),
    );
    const ownedRows = await db.execute({
      args: ["catalogue-rank", firstGeneration],
      sql: `select subject_id, source_version from due_work
        where work_kind = ? and generation = ? order by subject_id`,
    });
    expect(ownedRows.rows.map((row) => [row.subject_id, row.source_version])).toEqual([
      ...expectedVersions,
    ]);
  });

  it("keeps bounded material evidence fresh and adopts a newer marker after the owned generation", async () => {
    for (const trackId of Array.from({ length: 6 }, (_, index) => `rank-force-${index}`)) {
      await seedCatalogueTrack(db, { trackId });
    }
    const marker = (markerVersion: string, producer: string) =>
      markDueWorkSourceRepairsStatement(
        [
          {
            subjectId: DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
            subjectType: "track" as const,
          },
        ],
        { markerVersion, producer },
      );
    await db.execute(marker("track-update:force-v1", "track-update"));

    expect(await fanOutDueWorkSourceRepairs(db, { limit: 5 })).toMatchObject({
      deferred: 1,
      rankRebuildScanned: 5,
    });
    const firstGeneration = (
      await db.execute(`select generation from due_work_rebuilds
        where work_kind = 'catalogue-rank' and subject_type = 'track'`)
    ).rows[0]?.generation;
    expect(firstGeneration).toEqual(expect.stringMatching(/^v6:/));
    expect(
      (
        await db.execute({
          args: [CATALOGUE_RANK_MATERIAL_REVISION_KEY],
          sql: "select value from settings where key = ?",
        })
      ).rows[0]?.value,
    ).toBe("track-update:force-v1");

    await db.execute(marker("rank-semantic-v2", "catalogue-rank"));
    expect(
      (
        await db.execute({
          args: [DUE_WORK_SOURCE_REPAIR_KIND, DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID],
          sql: `select source_version from due_work where work_kind = ? and subject_id = ?`,
        })
      ).rows[0],
    ).toMatchObject({
      source_version: "track-update:force-v1|rank-fresh|rank-semantic-v2",
    });
    await db.execute(marker("rank-semantic-v2b", "catalogue-rank"));
    expect(
      (
        await db.execute({
          args: [DUE_WORK_SOURCE_REPAIR_KIND, DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID],
          sql: `select source_version from due_work where work_kind = ? and subject_id = ?`,
        })
      ).rows[0],
    ).toMatchObject({
      source_version: "track-update:force-v1|rank-fresh|rank-semantic-v2b",
    });

    await db.execute(marker("track-update:force-v3", "track-update"));
    expect(await fanOutDueWorkSourceRepairs(db, { limit: 5 })).toMatchObject({
      deferred: 1,
      rankRebuildScanned: 1,
    });
    expect(await fanOutDueWorkSourceRepairs(db, { limit: 5 })).toMatchObject({
      deferred: 1,
      rankRebuildScanned: 0,
    });
    expect(await fanOutDueWorkSourceRepairs(db, { limit: 5 })).toMatchObject({
      deferred: 1,
      rankRebuildScanned: 5,
    });
    const replacement = await db.execute(`select generation, scanned_count, state
      from due_work_rebuilds where work_kind = 'catalogue-rank' and subject_type = 'track'`);
    expect(replacement.rows[0]?.generation).not.toBe(firstGeneration);
    expect(
      (
        await db.execute({
          args: [CATALOGUE_RANK_MATERIAL_REVISION_KEY],
          sql: "select value from settings where key = ?",
        })
      ).rows[0]?.value,
    ).toBe("track-update:force-v3");
    expect(replacement.rows[0]).toMatchObject({ scanned_count: 5, state: "running" });
  });

  it("keeps a semantic corpus mutation newer than material adoption across the clear race", async () => {
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
        { markerVersion: "track-update:rank-race-v1", producer: "track-update" },
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
          await seedTrack(db, {
            logId: "997.9.9Z",
            trackId: "rank-race-new-finding",
          });
          await db.execute(
            markDueWorkSourceRepairsStatement(
              [
                {
                  subjectId: DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
                  subjectType: "track",
                },
              ],
              { markerVersion: "publish-track:rank-race-v2", producer: "publish-track" },
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
    expect(await fanOutDueWorkSourceRepairs(racingClient, { limit: 500 })).toMatchObject({
      deferred: 1,
      expanded: 0,
      hasMore: true,
      rankRebuildScanned: 0,
    });
    expect(await fanOutDueWorkSourceRepairs(racingClient, { limit: 500 })).toMatchObject({
      deferred: 1,
      expanded: 0,
      hasMore: true,
      rankRebuildScanned: 0,
    });
    expect(
      (
        await db.execute({
          args: [DUE_WORK_SOURCE_REPAIR_KIND, DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID],
          sql: `select source_version from due_work where work_kind = ? and subject_id = ?`,
        })
      ).rows[0],
    ).toMatchObject({
      source_version: "track-update:rank-race-v1|rank-fresh|publish-track:rank-race-v2",
    });
    expect(await fanOutDueWorkSourceRepairs(racingClient, { limit: 500 })).toMatchObject({
      deferred: 1,
      expanded: 0,
      hasMore: true,
      rankRebuildScanned: 3,
    });
    expect(await fanOutDueWorkSourceRepairs(racingClient, { limit: 500 })).toMatchObject({
      deferred: 1,
      rankRebuildScanned: 0,
    });
    expect(await fanOutDueWorkSourceRepairs(racingClient, { limit: 500 })).toMatchObject({
      deferred: 0,
      expanded: 1,
      hasMore: false,
      rankRebuildScanned: 0,
    });
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

  it("keeps a serial maintenance pass open across physical kinds and a concurrent marker", async () => {
    await seedCatalogueTrack(db, { trackId: "maintenance-edges" });
    await seedCatalogueTrack(db, { trackId: "maintenance-embed" });
    await db.execute({
      args: ["maintenance-embed/audio.webm", "maintenance-embed"],
      sql: `update tracks set source_audio_key = ?, capture_status = 'done' where track_id = ?`,
    });
    await markDueWorkRepair(db, {
      sourceVersion: "edges-v1",
      subjectId: "maintenance-edges",
      subjectType: "track",
      workKind: "artist-edges",
    });

    let addedConcurrentMarker = false;
    const racingClient = {
      batch: async (statements: InStatement[], mode?: Parameters<Client["batch"]>[1]) => {
        const results = await db.batch(statements, mode);
        if (!addedConcurrentMarker) {
          addedConcurrentMarker = true;
          await markDueWorkRepair(db, {
            sourceVersion: "embed-v1",
            subjectId: "maintenance-embed",
            subjectType: "track",
            workKind: "embed-catalogue",
          });
        }
        return results;
      },
      execute: db.execute.bind(db),
    };

    const first = await advanceProjectionFor(racingClient, {
      action: "repair",
      includeStatus: false,
      limit: 500,
      target: "track_due_work",
    });
    expect(first).toMatchObject({ complete: false, processed: 1, status: undefined });
    expect(addedConcurrentMarker).toBe(true);

    const second = await advanceProjectionFor(db, {
      action: "repair",
      includeStatus: false,
      limit: 500,
      target: "track_due_work",
    });
    expect(second).toMatchObject({ complete: true, processed: 1, status: undefined });
    expect(
      (
        await db.execute(`select work_kind from due_work where state = 'repair'
          order by work_kind`)
      ).rows,
    ).toEqual([]);
    expect((await listReadyDueWork(db, "artist-edges")).items).toHaveLength(1);
    expect((await listReadyDueWork(db, "embed-catalogue")).items).toHaveLength(1);
  });

  it("observes a source marker produced after the pass begins with no initial debt", async () => {
    await seedCatalogueTrack(db, { trackId: "maintenance-late-source" });
    let addedSourceMarker = false;
    const racingClient = {
      batch: db.batch.bind(db),
      execute: async (statement: InStatement | string) => {
        const sql = typeof statement === "string" ? statement : statement.sql;
        if (
          !addedSourceMarker &&
          typeof statement !== "string" &&
          sql.includes("select 1 from due_work where work_kind = ?")
        ) {
          addedSourceMarker = true;
          await db.execute(
            markDueWorkSourceRepairsStatement(
              [{ subjectId: "maintenance-late-source", subjectType: "track" }],
              { markerVersion: "late-source-v1", producer: "capture-verification" },
            ),
          );
        }
        return typeof statement === "string" ? db.execute(statement) : db.execute(statement);
      },
    };

    const first = await advanceProjectionFor(racingClient, {
      action: "repair",
      includeStatus: false,
      limit: 500,
      target: "track_due_work",
    });
    expect(first).toMatchObject({ complete: false, processed: 0, status: undefined });
    expect(addedSourceMarker).toBe(true);

    const second = await advanceProjectionFor(db, {
      action: "repair",
      includeStatus: false,
      limit: 500,
      target: "track_due_work",
    });
    expect(second).toMatchObject({ complete: true, processed: 1, status: undefined });
    expect((await listReadyDueWork(db, "artist-edges")).items).toHaveLength(1);
  });
});
