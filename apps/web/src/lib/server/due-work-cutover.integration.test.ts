import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createIntegrationDb,
  seedCatalogueTrack,
  seedEmbedding,
  seedTrack,
} from "./integration-db";
import { DueWorkMaintenancePendingError, upsertDueWork, type DueWorkProjection } from "./due-work";
import {
  isTrackWorkDueCutoverEnabled,
  readPromotedDueWorkPage,
  TRACK_WORK_DUE_CUTOVER_ENABLED_KEY,
} from "./due-work-cutover";
import { runWithDatabaseRequestScope } from "./database-request-scope";
import { setSetting } from "./settings";

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

const NOW = new Date("2026-08-26T12:00:00.000Z");

async function withAudio(trackId: string): Promise<void> {
  await db.execute({
    args: [`${trackId}/audio.webm`, trackId],
    sql: `update tracks
          set source_audio_key = ?, capture_status = 'done'
          where track_id = ?`,
  });
  await seedEmbedding(db, trackId, null);
}

async function ready(workKind: string, subjectId: string, sortKey: string): Promise<void> {
  const projection: DueWorkProjection<string> = {
    nextDueAt: NOW.toISOString(),
    sortKey,
    sourceVersion: `test-${subjectId}`,
    state: "ready",
    subjectId,
    subjectType: "track",
    workKind,
  };
  await upsertDueWork(db, projection, { now: NOW });
}

beforeEach(async () => {
  db = await createIntegrationDb();
});

afterEach(() => {
  db.close();
});

describe("listTrackWork Goal C cutover", () => {
  it("keeps the legacy selector when the flag is unset, malformed, or unreadable", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedCatalogueTrack(db, { trackId: "legacy-track" });
    await withAudio("legacy-track");

    expect(await isTrackWorkDueCutoverEnabled()).toBe(false);
    expect((await listTrackWork({ kind: "embed" })).map((item) => item.trackId)).toEqual([
      "legacy-track",
    ]);

    await setSetting(TRACK_WORK_DUE_CUTOVER_ENABLED_KEY, "1");
    expect(await isTrackWorkDueCutoverEnabled()).toBe(false);
    expect((await listTrackWork({ kind: "embed" })).map((item) => item.trackId)).toEqual([
      "legacy-track",
    ]);

    await db.execute("drop table settings");
    expect(await isTrackWorkDueCutoverEnabled()).toBe(false);
    expect((await listTrackWork({ kind: "embed" })).map((item) => item.trackId)).toEqual([
      "legacy-track",
    ]);
  });

  it("reads ready due rows in bounded order, hydrates only their IDs, and keeps the wire exact", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedTrack(db, {
      logId: "004.7.2I",
      title: "Finding",
      trackId: "finding-track",
    });
    await withAudio("finding-track");
    await seedCatalogueTrack(db, { title: "Catalogue", trackId: "catalogue-track" });
    await withAudio("catalogue-track");
    await seedCatalogueTrack(db, { title: "Not projected", trackId: "not-projected" });
    await withAudio("not-projected");

    // The catalogue has the lexically earlier projection key on purpose: the legacy outer order
    // is findings first, then catalogue, not one global sort over the two physical halves.
    await ready("embed-findings", "finding-track", "ff");
    await ready("embed-catalogue", "catalogue-track", "00");
    await setSetting(TRACK_WORK_DUE_CUTOVER_ENABLED_KEY, "true");
    expect(await isTrackWorkDueCutoverEnabled()).toBe(true);

    const execute = vi.spyOn(db, "execute");
    const work = await listTrackWork({ kind: "embed", limit: 2 });

    expect(work.map((item) => item.trackId)).toEqual(["finding-track", "catalogue-track"]);
    expect(work[0]).toEqual({
      artists: ["Test Artist"],
      capturePriority: null,
      certified: true,
      durationMs: 270_000,
      isrc: null,
      label: null,
      logId: "004.7.2I",
      sourceAudioKey: "finding-track/audio.webm",
      title: "Finding",
      trackId: "finding-track",
    });
    expect(work.map((item) => item.trackId)).not.toContain("not-projected");

    const hydration = execute.mock.calls
      .map((call) => call[0] as unknown)
      .find(
        (statement): statement is { args?: unknown[]; sql: string } =>
          typeof statement === "object" &&
          statement !== null &&
          "sql" in statement &&
          typeof statement.sql === "string" &&
          statement.sql.includes("t.track_id in (?, ?)"),
      );
    expect(hydration).toBeDefined();
    if (hydration === undefined) {
      throw new Error("the due-work cutover did not issue its bounded hydration query");
    }
    expect(hydration.args).toEqual(["finding-track", "catalogue-track"]);

    const states = await db.execute({
      args: ["embed-findings", "embed-catalogue"],
      sql: `select work_kind, state from due_work
            where work_kind in (?, ?)
            order by work_kind`,
    });
    expect(states.rows.map((row) => [row.work_kind, row.state])).toEqual([
      ["embed-catalogue", "ready"],
      ["embed-findings", "ready"],
    ]);
  });

  it("returns the projection's empty page and projected count without falling back", async () => {
    const { countTrackWork, listTrackWork } = await import("./track-work");

    await seedCatalogueTrack(db, { trackId: "missing-projection" });
    await withAudio("missing-projection");
    await setSetting(TRACK_WORK_DUE_CUTOVER_ENABLED_KEY, "true");

    expect(await listTrackWork({ kind: "embed" })).toEqual([]);
    expect(await countTrackWork({ kind: "embed" })).toBe(0);

    await ready("embed-catalogue", "missing-projection", "00");
    expect(await countTrackWork({ kind: "embed" })).toBe(1);
  });

  it("keeps the capture brake and scope empty behavior outside the projection read", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedTrack(db, { logId: "004.7.2I", trackId: "finding-capture" });
    await seedCatalogueTrack(db, { trackId: "catalogue-capture" });
    await setSetting(TRACK_WORK_DUE_CUTOVER_ENABLED_KEY, "true");
    await ready("capture-findings", "finding-capture", "ff");
    await ready("capture-catalogue", "catalogue-capture", "00");

    // The untouched catalogue budget is closed. The due reader sees only the findings half, and
    // an explicit catalogue scope is empty before any due_work read occurs.
    expect((await listTrackWork({ kind: "capture" })).map((item) => item.trackId)).toEqual([
      "finding-capture",
    ]);
    expect(await listTrackWork({ kind: "capture", scope: "catalogue" })).toEqual([]);

    const states = await db.execute({
      args: ["capture-findings", "capture-catalogue"],
      sql: `select work_kind, state from due_work
            where work_kind in (?, ?)
            order by work_kind`,
    });
    expect(states.rows.every((row) => row.state === "ready")).toBe(true);
  });

  it("withholds claims until bounded promotion has exposed every overdue priority row", async () => {
    const statements = Array.from({ length: 501 }, (_, index) => {
      const subjectId = `scheduled-${String(index).padStart(3, "0")}`;
      return {
        args: [
          "promotion-order",
          "track",
          subjectId,
          "scheduled",
          index === 500 ? "000" : `1${String(index).padStart(3, "0")}`,
          NOW.toISOString(),
          `source-${index}`,
          "test",
          NOW.toISOString(),
        ],
        sql: `insert into due_work
          (work_kind, subject_type, subject_id, state, sort_key, next_due_at,
           source_version, generation, updated_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      };
    });
    await db.batch(statements.slice(0, 250), "write");
    await db.batch(statements.slice(250, 500), "write");
    await db.batch(statements.slice(500), "write");

    await expect(
      readPromotedDueWorkPage(db, "promotion-order", { limit: 1, now: () => NOW }),
    ).rejects.toBeInstanceOf(DueWorkMaintenancePendingError);
    await expect(
      readPromotedDueWorkPage(db, "promotion-order", { limit: 1, now: () => NOW }),
    ).resolves.toEqual({ hasMore: true, subjectIds: ["scheduled-500"] });
  });

  // AN EMPTY PAGE HANDS OUT NO ROW. The deferral over an empty page under residual source debt is
  // what turned the render conductor's near-always-empty queue into a deferral on every tick while
  // the track family carried permanent debt. A queue may opt out of it; the metered queues do not.
  it("answers an honest empty page under debt only for a queue that opted in", async () => {
    const { markDueWorkSourceRepairsStatement } = await import("./due-work");
    const { DUE_WORK_READ_DRAIN_BUDGET, SOURCE_REPAIR_LIMIT } =
      await import("./due-work-source-repair");

    // More track source debt than one request's whole drain budget can converge, and no row in the
    // queue being read — the conductor's ordinary overnight shape.
    const burst = SOURCE_REPAIR_LIMIT * (DUE_WORK_READ_DRAIN_BUDGET.sourcePages + 1) + 1;
    const trackIds = Array.from(
      { length: burst },
      (_, index) => `debt-${String(index).padStart(4, "0")}`,
    );
    for (const trackId of trackIds) {
      await seedCatalogueTrack(db, { trackId });
    }
    for (let start = 0; start < trackIds.length; start += 100) {
      await db.execute(
        markDueWorkSourceRepairsStatement(
          trackIds
            .slice(start, start + 100)
            .map((subjectId) => ({ subjectId, subjectType: "track" })),
          { now: NOW, producer: "test-burst" },
        ),
      );
    }

    await expect(
      runWithDatabaseRequestScope(() =>
        readPromotedDueWorkPage(db, "finding.render", { limit: 1, now: () => NOW }),
      ),
    ).rejects.toBeInstanceOf(DueWorkMaintenancePendingError);

    await expect(
      runWithDatabaseRequestScope(() =>
        readPromotedDueWorkPage(db, "finding.render", {
          emptyPageUnderDebt: "serve",
          limit: 1,
          now: () => NOW,
        }),
      ),
    ).resolves.toEqual({ hasMore: false, subjectIds: [] });
  });

  it("serves the subjects a burst of repair markers does not own, and withholds the ones it does", async () => {
    const { listTrackWork } = await import("./track-work");
    const { markDueWorkSourceRepairsStatement } = await import("./due-work");
    const { DUE_WORK_READ_DRAIN_BUDGET, SOURCE_REPAIR_LIMIT } =
      await import("./due-work-source-repair");

    // One subject more than a single guarded read's whole drain budget converges. Every steady
    // track writer — the rank sweep, the demand rewrite, the crawl, an operator requeue, and the
    // sweeps' own write-backs — mints markers at this shape, so this is the ordinary steady state,
    // not an incident.
    // A scope spanning both certification halves reads two physical queues, and every guarded read
    // always runs its first page whatever the shared budget has left, so one request converges
    // `sourcePages + 1` pages in all.
    const burst = SOURCE_REPAIR_LIMIT * (DUE_WORK_READ_DRAIN_BUDGET.sourcePages + 1) + 1;
    const trackIds = Array.from(
      { length: burst },
      (_, index) => `burst-${String(index).padStart(3, "0")}`,
    );
    for (const trackId of trackIds) {
      await seedCatalogueTrack(db, { trackId });
      await withAudio(trackId);
    }
    await setSetting(TRACK_WORK_DUE_CUTOVER_ENABLED_KEY, "true");
    for (let start = 0; start < trackIds.length; start += 100) {
      await db.execute(
        markDueWorkSourceRepairsStatement(
          trackIds
            .slice(start, start + 100)
            .map((subjectId) => ({ subjectId, subjectType: "track" })),
          { now: NOW, producer: "test-burst" },
        ),
      );
    }

    // One Worker request, so the drain budget is shared by both physical embed queues exactly as
    // it is in production.
    const served = (
      await runWithDatabaseRequestScope(() => listTrackWork({ kind: "embed", limit: burst }))
    ).map((item) => item.trackId);

    // The read drains what its budget allows and answers with it. Debt it could not reach belongs
    // to other subjects, so they cannot withhold the rows this read completed.
    expect(served.length).toBeGreaterThan(0);
    const outstanding = await db.execute({
      args: ["source-repair"],
      sql: `select subject_id from due_work where work_kind = ? and state = 'repair'`,
    });
    const withheld = new Set(outstanding.rows.map((row) => row.subject_id));
    expect(withheld.size).toBeGreaterThan(0);
    expect(served.filter((trackId) => withheld.has(trackId))).toEqual([]);
    expect(served.length + withheld.size).toBe(burst);
  });

  it("never serves a row a repair marker still owns, even when its projection is stale-eligible", async () => {
    const { listTrackWork } = await import("./track-work");
    const { markDueWorkSourceRepairsStatement } = await import("./due-work");

    const { DUE_WORK_READ_DRAIN_BUDGET, SOURCE_REPAIR_LIMIT } =
      await import("./due-work-source-repair");

    // Source markers drain in subject order, so a subject that sorts behind a full drain budget
    // still carries its marker when the read answers. That is the row the money rail is about.
    const fillers = Array.from(
      { length: SOURCE_REPAIR_LIMIT * (DUE_WORK_READ_DRAIN_BUDGET.sourcePages + 1) },
      (_, index) => `aa-filler-${String(index).padStart(3, "0")}`,
    );
    for (const trackId of [...fillers, "zz-vetoed-track"]) {
      await seedCatalogueTrack(db, { trackId });
      await withAudio(trackId);
    }
    await setSetting(TRACK_WORK_DUE_CUTOVER_ENABLED_KEY, "true");

    // Project the row and serve it once, so the queue holds a real ready row for it.
    await db.execute(
      markDueWorkSourceRepairsStatement([{ subjectId: "zz-vetoed-track", subjectType: "track" }], {
        now: NOW,
        producer: "test-veto",
      }),
    );
    expect(
      (await runWithDatabaseRequestScope(() => listTrackWork({ kind: "embed", limit: 100 }))).map(
        (item) => item.trackId,
      ),
    ).toEqual(["zz-vetoed-track"]);

    // Move that row's eligibility behind a burst its marker sorts last in. Its projected row still
    // reads as eligible; the marker is the only thing that knows better, and it survives the drain.
    await db.execute({
      args: [NOW.toISOString(), "zz-vetoed-track"],
      sql: `update tracks set dismissed_at = ? where track_id = ?`,
    });
    await db.execute(
      markDueWorkSourceRepairsStatement(
        [...fillers, "zz-vetoed-track"].map((subjectId) => ({ subjectId, subjectType: "track" })),
        { now: NOW, producer: "test-veto" },
      ),
    );

    const served = (
      await runWithDatabaseRequestScope(() => listTrackWork({ kind: "embed", limit: 100 }))
    ).map((item) => item.trackId);
    expect(served).not.toContain("zz-vetoed-track");
    expect(served.length).toBeGreaterThan(0);
  });

  // THE SCOPING IS BY SUBJECT, AND A SUBJECT CARRIES ITS TYPE. Withholding is keyed on the marker's
  // own primary key — `(work_kind, subject_type, subject_id)` — so a label-typed or artist-typed
  // marker never withholds a track row that happens to share its id. The rulings that DO owe a
  // track something say so in track-typed markers, in the same transaction.
  it("serves a track a label-typed marker cannot own", async () => {
    const { listTrackWork } = await import("./track-work");
    const { markDueWorkSourceRepairsStatement } = await import("./due-work");

    await seedCatalogueTrack(db, { trackId: "shared-id" });
    await withAudio("shared-id");
    await setSetting(TRACK_WORK_DUE_CUTOVER_ENABLED_KEY, "true");

    // Project the track first, so the queue holds a real ready row for it.
    await db.execute(
      markDueWorkSourceRepairsStatement([{ subjectId: "shared-id", subjectType: "track" }], {
        now: NOW,
        producer: "test-label-scope",
      }),
    );
    expect(
      (await runWithDatabaseRequestScope(() => listTrackWork({ kind: "embed", limit: 10 }))).map(
        (item) => item.trackId,
      ),
    ).toEqual(["shared-id"]);

    // A label ruling's own entity marker, standing beside that ready track row and wearing the
    // SAME subject id. It owes the label's projections a repair and owes this track nothing.
    await db.execute(
      markDueWorkSourceRepairsStatement([{ subjectId: "shared-id", subjectType: "label" }], {
        now: NOW,
        producer: "test-label-scope",
      }),
    );

    expect(
      (await runWithDatabaseRequestScope(() => listTrackWork({ kind: "embed", limit: 10 }))).map(
        (item) => item.trackId,
      ),
    ).toEqual(["shared-id"]);
  });

  it("withholds a ruled label's tracks through the track-typed markers the same ruling mints", async () => {
    const { listTrackWork } = await import("./track-work");
    const { updateLabelSeedState } = await import("./labels");

    await db.execute({
      args: [NOW.toISOString(), NOW.toISOString()],
      sql: `insert into labels (id, slug, name, seed_state, created_at, updated_at)
            values ('lbl-ruled', 'ruled-imprint', 'Ruled Imprint', 'undecided', ?, ?)`,
    });
    for (const trackId of ["ruled-a", "ruled-b"]) {
      await seedCatalogueTrack(db, { trackId });
      await withAudio(trackId);
      await db.execute({
        args: [trackId],
        sql: `update tracks set label = 'Ruled Imprint', label_id = 'lbl-ruled' where track_id = ?`,
      });
    }
    await setSetting(TRACK_WORK_DUE_CUTOVER_ENABLED_KEY, "true");

    // The ruling itself. It changes what Fluncle may spend on these rows, so it re-stales their
    // rank AND marks each track individually — a label marker alone would never reach them.
    await updateLabelSeedState("lbl-ruled", "disabled");

    const marked = await db.execute(
      `select subject_id from due_work
       where work_kind = 'source-repair' and subject_type = 'track'
         and subject_id in ('ruled-a', 'ruled-b')
       order by subject_id`,
    );
    expect(marked.rows.map((row) => row.subject_id)).toEqual(["ruled-a", "ruled-b"]);

    // Those markers are the withholding: a capture worklist read serves neither until the ruling's
    // repair has converged them.
    expect(
      (await runWithDatabaseRequestScope(() => listTrackWork({ kind: "capture", limit: 10 }))).map(
        (item) => item.trackId,
      ),
    ).not.toContain("ruled-a");
  });
});
