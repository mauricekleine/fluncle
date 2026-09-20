import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  listReadyDueWork,
  runDueWorkRebuildChunk,
  type DueWorkRebuildDefinition,
} from "./due-work";
import { rekeyDueWorkQueue, UnknownDueWorkQueueError } from "./due-work-rekey";
import { DUE_WORK_BACKFILLS } from "./due-work-registry";
import { createIntegrationDb, seedCatalogueTrack } from "./integration-db";
import { advanceProjectionFor, getProjectionStatusFor } from "./projection-operations";

let db: Client;

beforeEach(async () => {
  db = await createIntegrationDb();
});

afterEach(() => {
  db.close();
});

const CAPTURE_CATALOGUE = "capture-catalogue";

function captureDefinition(): DueWorkRebuildDefinition<string, never> {
  const definition = DUE_WORK_BACKFILLS.find((entry) => entry.workKind === CAPTURE_CATALOGUE);
  if (definition === undefined) {
    throw new Error("the capture-catalogue rebuild definition is missing");
  }
  return definition as unknown as DueWorkRebuildDefinition<string, never>;
}

/** Seed `count` catalogue rows the capture queue accepts, alternating the Spotify anchor. */
async function seedCaptureQueue(count: number): Promise<string[]> {
  const trackIds: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const trackId = `rekey-${String(index).padStart(3, "0")}`;
    trackIds.push(trackId);
    await seedCatalogueTrack(db, { trackId });
    await db.execute({
      args: [index % 2 === 0 ? null : `spotify:track:${trackId}`, trackId],
      sql: `update tracks set capture_priority = 5, capture_status = 'pending',
        source_audio_failures = 0, spotify_uri = ? where track_id = ?`,
    });
  }
  return trackIds;
}

async function rebuildCaptureQueue(): Promise<void> {
  const definition = captureDefinition();
  for (let step = 0; step < 50; step += 1) {
    const result = await runDueWorkRebuildChunk(db, definition, { limit: 100 });
    if (result.complete) {
      return;
    }
  }
  throw new Error("the capture-catalogue rebuild did not converge");
}

async function readCheckpoint(): Promise<Record<string, unknown> | undefined> {
  const result = await db.execute({
    args: [CAPTURE_CATALOGUE],
    sql: `select generation, state, definition_version from due_work_rebuilds
      where work_kind = ? and subject_type = 'track'`,
  });
  return result.rows[0] as Record<string, unknown> | undefined;
}

async function readSortKeys(): Promise<Map<string, string>> {
  const result = await db.execute({
    args: [CAPTURE_CATALOGUE],
    sql: `select subject_id, sort_key from due_work where work_kind = ? and subject_type = 'track'`,
  });
  return new Map(
    (result.rows as unknown as { sort_key: string; subject_id: string }[]).map((row) => [
      row.subject_id,
      row.sort_key,
    ]),
  );
}

describe("a due-work queue whose order definition changed", () => {
  it("reads incomplete, opens a fresh generation on the ordinary rebuild step, and re-keys its rows", async () => {
    await seedCaptureQueue(4);
    await rebuildCaptureQueue();

    const rebuilt = await readCheckpoint();
    expect(rebuilt?.state).toBe("complete");
    // The only checkpoint this fixture rebuilds is capture-catalogue's, so it is the one the
    // family status can count.
    expect((await getProjectionStatusFor(db)).projections.trackDueWork.rebuild.completed).toBe(1);
    expect(rebuilt?.definition_version).toBe(captureDefinition().definitionVersion);
    const currentKeys = await readSortKeys();
    expect(currentKeys.size).toBe(4);

    // Stand in for a deploy that changed this queue's order: the stored definition version is an
    // older one, and the projected rows carry that older definition's keys.
    await db.execute({
      args: [CAPTURE_CATALOGUE],
      sql: `update due_work_rebuilds set definition_version = 'dv1-previous'
        where work_kind = ? and subject_type = 'track'`,
    });
    await db.execute({
      args: [CAPTURE_CATALOGUE],
      sql: `update due_work set sort_key = 'stale' where work_kind = ? and subject_type = 'track'`,
    });

    // The family is not complete, though every checkpoint row still says `complete`.
    const status = await getProjectionStatusFor(db);
    expect(status.projections.trackDueWork.rebuild.complete).toBe(false);
    expect(status.projections.trackDueWork.rebuild.completed).toBe(0);

    // The ordinary rebuild step — no audit evidence, no `newGeneration`, no cutover flip.
    const staleGeneration = String(rebuilt?.generation);
    const restarted = await runDueWorkRebuildChunk(db, captureDefinition(), { limit: 100 });
    expect(restarted.noOp).toBe(false);
    expect(restarted.checkpoint.generation).not.toBe(staleGeneration);
    await rebuildCaptureQueue();

    const rekeyed = await readSortKeys();
    expect([...rekeyed.values()].every((key) => key !== "stale")).toBe(true);
    expect(rekeyed).toEqual(currentKeys);
    expect((await readCheckpoint())?.definition_version).toBe(
      captureDefinition().definitionVersion,
    );
  });

  it("holds its checkpoint complete while the definition is unchanged", async () => {
    await seedCaptureQueue(2);
    await rebuildCaptureQueue();
    const before = await readCheckpoint();

    const again = await runDueWorkRebuildChunk(db, captureDefinition(), { limit: 100 });

    expect(again.noOp).toBe(true);
    expect((await readCheckpoint())?.generation).toBe(before?.generation);
  });
});

describe("the targeted queue re-key", () => {
  it("reports a page without writing on a dry run", async () => {
    await seedCaptureQueue(5);
    await rebuildCaptureQueue();

    const dryRun = await rekeyDueWorkQueue(db, { limit: 3, workKind: CAPTURE_CATALOGUE });

    expect(dryRun.applied).toBe(false);
    expect(dryRun.matched).toBe(3);
    expect(dryRun.marked).toBe(0);
    expect(dryRun.remaining).toEqual({ count: 2, truncated: false });
    expect(dryRun.hasMore).toBe(true);
    const markers = await db.execute(`select count(*) as n from due_work where state = 'repair'`);
    expect(Number(markers.rows[0]?.n)).toBe(0);
  });

  it("pages, resumes from its cursor, and stops when the queue is exhausted", async () => {
    const trackIds = await seedCaptureQueue(5);
    await rebuildCaptureQueue();

    const first = await rekeyDueWorkQueue(db, {
      apply: true,
      limit: 3,
      workKind: CAPTURE_CATALOGUE,
    });
    expect(first.marked).toBe(3);
    expect(first.cursor).toBe(trackIds[2]);
    expect(first.remaining.count).toBe(2);

    const second = await rekeyDueWorkQueue(db, {
      apply: true,
      cursor: first.cursor,
      limit: 3,
      workKind: CAPTURE_CATALOGUE,
    });
    expect(second.marked).toBe(2);
    expect(second.hasMore).toBe(false);
    expect(second.remaining).toEqual({ count: 0, truncated: false });

    const marked = await db.execute({
      args: [CAPTURE_CATALOGUE],
      sql: `select count(*) as n from due_work where work_kind = ? and state = 'repair'`,
    });
    expect(Number(marked.rows[0]?.n)).toBe(5);
  });

  it("withholds only the marked subjects from the queue's read while the drain runs", async () => {
    const trackIds = await seedCaptureQueue(5);
    await rebuildCaptureQueue();
    const served = await listReadyDueWork(db, CAPTURE_CATALOGUE);
    expect(served.items.length).toBe(5);

    await rekeyDueWorkQueue(db, { apply: true, limit: 2, workKind: CAPTURE_CATALOGUE });

    const midDrain = await listReadyDueWork(db, CAPTURE_CATALOGUE);
    const remainingIds = midDrain.items.map((row) => row.subjectId).sort();
    expect(remainingIds).toEqual(trackIds.slice(2).sort());
  });

  it("returns every marked row to the queue once the maintenance repair drains it", async () => {
    await seedCaptureQueue(4);
    await rebuildCaptureQueue();
    const before = await readSortKeys();
    await db.execute({
      args: [CAPTURE_CATALOGUE],
      sql: `update due_work set sort_key = 'stale' where work_kind = ? and subject_type = 'track'`,
    });

    await rekeyDueWorkQueue(db, { apply: true, workKind: CAPTURE_CATALOGUE });
    for (let step = 0; step < 20; step += 1) {
      const outcome = await advanceProjectionFor(db, {
        action: "repair",
        includeStatus: false,
        limit: 500,
        target: "track_due_work",
      });
      if (outcome.complete) {
        break;
      }
    }

    expect(await readSortKeys()).toEqual(before);
    const served = await listReadyDueWork(db, CAPTURE_CATALOGUE);
    expect(served.items.length).toBe(4);
  });

  it("refuses a queue the registry does not hold", async () => {
    await expect(rekeyDueWorkQueue(db, { workKind: "not-a-queue" })).rejects.toBeInstanceOf(
      UnknownDueWorkQueueError,
    );
  });
});
