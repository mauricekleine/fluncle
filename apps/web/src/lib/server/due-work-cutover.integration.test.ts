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
});
