import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb, seedCatalogueTrack, seedTrack } from "./integration-db";
import { upsertDueWork, type DueWorkProjection } from "./due-work";
import { TRACK_WORK_DUE_CUTOVER_ENABLED_KEY } from "./due-work-cutover";
import { PIPELINE_WATCH_LIMITS, readPipelineWatch } from "./pipeline-watch-read";
import { setSetting } from "./settings";

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return { ...actual, getDb: () => Promise.resolve(db) };
});

const NOW = "2026-09-25T00:00:00.000Z";

async function dueWork(
  workKind: string,
  subjectId: string,
  state: "ready" | "scheduled" = "ready",
): Promise<void> {
  const projection: DueWorkProjection<string> = {
    nextDueAt: NOW,
    sortKey: subjectId,
    sourceVersion: `test-${subjectId}`,
    state,
    subjectId,
    subjectType: "track",
    workKind,
  };
  await upsertDueWork(db, projection, { now: new Date(NOW) });
}

async function repair(workKind: string, subjectId: string): Promise<void> {
  await db.execute({
    args: [workKind, subjectId, NOW, NOW],
    sql: `insert into due_work
      (work_kind, subject_type, subject_id, state, sort_key, next_due_at,
       generation, source_version, updated_at)
      values (?, 'track', ?, 'repair', '', ?, 'test', 'test', ?)
      on conflict(work_kind, subject_type, subject_id) do update set state = 'repair'`,
  });
}

beforeEach(async () => {
  db = await createIntegrationDb();
});

afterEach(() => {
  db.close();
});

describe("pipeline watchdog bounded reads", () => {
  it("matches full crawl counts below each cap and capture work under an open budget", async () => {
    const { getCrawlPipelineSummary } = await import("./crawl");
    const { countTrackWork } = await import("./track-work");
    const { setCatalogueCapturePaused } = await import("./capture-budget");

    await db.execute(`insert into crawl_frontier
      (id, kind, source, external_id, hop, created_at, updated_at)
      values ('artist:one', 'artist', 'musicbrainz', 'one', 0, '${NOW}', '${NOW}')`);
    for (const [id, rank] of [
      ["release:one", 0],
      ["release:two", 1],
    ] as const) {
      await db.execute({
        args: [id, rank, NOW, NOW],
        sql: `insert into crawl_due_work
          (node_id, node_kind, state, storable_rank, hop, demand_rank,
           generation, source_version, created_at, updated_at)
          values (?, 'release', 'ready', ?, 0, 1, 'test', 'test', ?, ?)`,
      });
    }
    await seedCatalogueTrack(db, { trackId: "catalogue-one" });
    await db.execute("update tracks set isrc = 'TEST00000001' where track_id = 'catalogue-one'");
    await seedTrack(db, { logId: "001.1.1A", trackId: "finding-one" });
    await dueWork("capture-findings", "finding-one");
    await dueWork("capture-catalogue", "catalogue-one");
    await setSetting(TRACK_WORK_DUE_CUTOVER_ENABLED_KEY, "true");
    await setCatalogueCapturePaused(false);

    const full = await getCrawlPipelineSummary();
    const watch = await readPipelineWatch();
    expect(watch.frontier).toEqual({ atLeast: false, count: full.frontier.pending });
    expect(watch.anchors).toEqual({ atLeast: false, count: full.anchorsPending });
    expect(watch.storable).toEqual({ atLeast: true, count: full.storablePending });
    expect(watch.unstorable).toEqual({ atLeast: false, count: full.unstorablePending });
    expect(watch.capture).toEqual({
      atLeast: false,
      count: await countTrackWork({ kind: "capture", scope: "all" }),
    });
  });

  it("preserves a definite capture lower bound while source repairs are pending", async () => {
    await setSetting(TRACK_WORK_DUE_CUTOVER_ENABLED_KEY, "true");
    await dueWork("capture-findings", "finding-one");
    await dueWork("capture-findings", "finding-two");
    await repair("source-repair", "finding-one");

    expect((await readPipelineWatch()).capture).toEqual({ atLeast: true, count: 1 });
    await db.execute(
      "delete from due_work where work_kind = 'capture-findings' and subject_id = 'finding-two'",
    );
    expect((await readPipelineWatch()).capture).toBeNull();
  });

  it("obeys the capture budget and includes due scheduled work", async () => {
    await setSetting(TRACK_WORK_DUE_CUTOVER_ENABLED_KEY, "true");
    await dueWork("capture-findings", "finding-one", "scheduled");
    await dueWork("capture-catalogue", "catalogue-one");

    expect((await readPipelineWatch()).capture).toEqual({ atLeast: false, count: 1 });
    await repair("capture-catalogue", "catalogue-one");
    expect((await readPipelineWatch()).capture).toEqual({ atLeast: false, count: 1 });
    await db.execute("update due_work set state = 'ready' where work_kind = 'capture-catalogue'");
    const { setCatalogueCapturePaused } = await import("./capture-budget");
    await setCatalogueCapturePaused(false);
    expect((await readPipelineWatch()).capture).toEqual({ atLeast: false, count: 2 });
    await repair("capture-catalogue", "catalogue-one");
    expect((await readPipelineWatch()).capture).toBeNull();
  });

  it("treats a saturated physical repair probe as unknown", async () => {
    await setSetting(TRACK_WORK_DUE_CUTOVER_ENABLED_KEY, "true");
    await dueWork("capture-findings", "finding-one");
    await db.execute(`with recursive ids(n) as (
      select 1 union all select n + 1 from ids where n < 1000
    ) insert into due_work
      (work_kind, subject_type, subject_id, state, sort_key, next_due_at,
       generation, source_version, updated_at)
      select 'analyze-catalogue', 'track', 'other:' || n, 'repair', '', '${NOW}',
        'test', 'test', '${NOW}' from ids`);

    expect((await readPipelineWatch()).capture).toBeNull();
  });

  it("caps frontier growth and reports the bound as a lower bound", async () => {
    await db.execute(`with recursive ids(n) as (
      select 1 union all select n + 1 from ids where n < ${PIPELINE_WATCH_LIMITS.frontier + 1}
    ) insert into crawl_frontier
      (id, kind, source, external_id, hop, created_at, updated_at)
      select 'artist:' || n, 'artist', 'musicbrainz', 'artist:' || n, 0, '${NOW}', '${NOW}' from ids`);

    const exact = await db.execute(
      "select count(*) as n from crawl_frontier where state = 'pending'",
    );
    expect(Number(exact.rows[0]?.n)).toBe(PIPELINE_WATCH_LIMITS.frontier + 1);
    expect((await readPipelineWatch()).frontier).toEqual({
      atLeast: true,
      count: PIPELINE_WATCH_LIMITS.frontier,
    });
  });

  it("uses the existing queue indexes for every bounded count", async () => {
    await setSetting(TRACK_WORK_DUE_CUTOVER_ENABLED_KEY, "true");
    const execute = vi.spyOn(db, "execute");
    await readPipelineWatch();
    const statements = execute.mock.calls
      .map(([statement]) => statement)
      .filter((statement) => typeof statement === "object" && !Array.isArray(statement))
      .map((statement) => statement as { args: Array<number | string>; sql: string });
    execute.mockRestore();

    const expected = [
      ["from crawl_frontier", "crawl_frontier_pick_idx"],
      ["from tracks indexed by tracks_anchor_queue_idx", "tracks_anchor_queue_idx"],
      ["storable_rank = 0", "crawl_due_work_release_ready_idx"],
      ["storable_rank = 1", "crawl_due_work_release_ready_idx"],
      ["state = 'scheduled' and next_due_at <= ?", "due_work_ready_idx"],
      ["from due_work indexed by due_work_repair_idx", "due_work_repair_idx"],
      ["+state = 'repair'", "sqlite_autoindex_due_work_1"],
    ] as const;
    for (const [fragment, index] of expected) {
      const statement = statements.find((candidate) => candidate.sql.includes(fragment));
      expect(statement, fragment).toBeDefined();
      if (!statement) {
        continue;
      }
      const plan = await db.execute({
        args: statement.args,
        sql: `explain query plan ${statement.sql}`,
      });
      const details = plan.rows
        .map((row) => (typeof row.detail === "string" ? row.detail : ""))
        .join("\n");
      expect(details, fragment).toContain(index);
      if (fragment.includes("scheduled")) {
        expect(details).toContain("due_work_scheduled_idx");
      }
    }
  });
});
