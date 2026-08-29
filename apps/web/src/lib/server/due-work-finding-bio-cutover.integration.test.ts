import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { listAlbumsMissingBio } from "./albums";
import { listArtistsMissingBio } from "./artists";
import { readPromotedDueWorkPage, TRACK_WORK_DUE_CUTOVER_ENABLED_KEY } from "./due-work-cutover";
import { upsertDueWork, type DueWorkProjection, type DueWorkSubjectType } from "./due-work";
import { encodeDueWorkOrder } from "./due-work-order";
import { createIntegrationDb, seedAlbum, seedArtist, seedLabel, seedTrack } from "./integration-db";
import { listLabelsMissingBio } from "./labels";
import { setSetting } from "./settings";
import { decodeTrackCursor, listTracks } from "./tracks";

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return { ...actual, getDb: () => Promise.resolve(db) };
});

const NOW = new Date("2026-08-26T12:00:00.000Z");
const OLD = "2026-01-01T00:00:00.000Z";
const MIDDLE = "2026-02-01T00:00:00.000Z";
const NEW = "2026-03-01T00:00:00.000Z";

async function project(
  workKind: string,
  subjectType: DueWorkSubjectType,
  subjectId: string,
  sortKey: string,
  state: "ready" | "scheduled" = "ready",
): Promise<void> {
  const projection: DueWorkProjection<string> = {
    nextDueAt: state === "scheduled" ? "2020-01-01T00:00:00.000Z" : NOW.toISOString(),
    sortKey,
    sourceVersion: `test:${workKind}:${subjectId}`,
    state,
    subjectId,
    subjectType,
    workKind,
  };
  await upsertDueWork(db, projection, { now: NOW });
}

function findingSortKey(addedAt: string, trackId: string): string {
  return encodeDueWorkOrder([
    { direction: "asc", kind: "timestamp", nulls: "first", value: addedAt },
    { direction: "asc", kind: "text", value: trackId },
  ]);
}

beforeEach(async () => {
  db = await createIntegrationDb();
});

afterEach(() => {
  db.close();
});

const findingQueues = [
  {
    kind: "finding.enrich",
    options: { limit: 2, order: "asc", status: "queue" } as const,
    prepare: async () => undefined,
  },
  {
    kind: "finding.context",
    options: { hasContext: false, limit: 2, order: "asc" } as const,
    prepare: async () => undefined,
  },
  {
    kind: "finding.note",
    options: { hasContext: true, hasNote: false, limit: 2, order: "asc" } as const,
    prepare: async () => {
      await db.execute("update findings set context_note = 'context'");
    },
  },
  {
    kind: "finding.observe",
    options: { hasContext: true, hasObservation: false, limit: 2, order: "asc" } as const,
    prepare: async () => {
      await db.execute("update findings set context_note = 'context'");
    },
  },
  {
    kind: "finding.render",
    options: { hasContext: true, hasVideo: false, limit: 2, order: "asc" } as const,
    prepare: async () => {
      await db.execute("update findings set context_note = 'context'");
    },
  },
] as const;

describe("recurring finding selector Goal C cutovers", () => {
  for (const queue of findingQueues) {
    it(`${queue.kind} is flag-off/on compatible and hydrates only its bounded due IDs`, async () => {
      await seedTrack(db, { addedAt: NEW, logId: "003.0.0F", trackId: "track-new" });
      await seedTrack(db, { addedAt: OLD, logId: "001.0.0F", trackId: "track-old" });
      await seedTrack(db, { addedAt: MIDDLE, logId: "002.0.0F", trackId: "track-middle" });
      await queue.prepare();

      await project(queue.kind, "track", "track-new", findingSortKey(NEW, "track-new"));
      await project(queue.kind, "track", "track-old", findingSortKey(OLD, "track-old"));
      await project(
        queue.kind,
        "track",
        "track-middle",
        findingSortKey(MIDDLE, "track-middle"),
        "scheduled",
      );

      const legacy = await listTracks(queue.options);
      await setSetting(TRACK_WORK_DUE_CUTOVER_ENABLED_KEY, "true");
      const execute = vi.spyOn(db, "execute");
      const cutover = await listTracks(queue.options);

      expect(cutover).toEqual(legacy);
      expect(cutover.tracks.map((track) => track.trackId)).toEqual(["track-old", "track-middle"]);

      const cursor = decodeTrackCursor(cutover.nextCursor ?? null);
      expect(cursor).toBeDefined();
      await setSetting(TRACK_WORK_DUE_CUTOVER_ENABLED_KEY, "false");
      const legacyNext = await listTracks({ ...queue.options, cursor });
      await setSetting(TRACK_WORK_DUE_CUTOVER_ENABLED_KEY, "true");
      const cutoverNext = await listTracks({ ...queue.options, cursor });
      expect(cutoverNext.tracks).toEqual(legacyNext.tracks);
      expect(cutoverNext.nextCursor).toBe(legacyNext.nextCursor);
      expect(cutoverNext.tracks.map((track) => track.trackId)).toEqual(["track-new"]);

      const hydration = execute.mock.calls
        .map((call) => call[0] as unknown)
        .find(
          (statement): statement is { args?: unknown[]; sql: string } =>
            typeof statement === "object" &&
            statement !== null &&
            "sql" in statement &&
            typeof statement.sql === "string" &&
            statement.sql.includes("where tracks.track_id in (?, ?)"),
        );
      expect(hydration?.args).toEqual(["track-old", "track-middle"]);
      expect(hydration?.args).not.toContain("track-new");
    });
  }

  it("cuts over on-demand variants while descending probes stay visibly legacy", async () => {
    await seedTrack(db, { addedAt: OLD, logId: "001.0.0F", trackId: "legacy-only" });
    await db.execute("update findings set context_status = 'empty', context_note = null");
    await project(
      "finding.context.retry-empty",
      "track",
      "legacy-only",
      findingSortKey(OLD, "legacy-only"),
    );
    await setSetting(TRACK_WORK_DUE_CUTOVER_ENABLED_KEY, "true");

    expect(
      (
        await listTracks({
          hasContext: false,
          limit: 2,
          order: "asc",
          retryEmptyContext: true,
        })
      ).tracks.map((track) => track.trackId),
    ).toEqual(["legacy-only"]);

    await db.execute(
      `update findings
       set context_note = 'context', context_status = 'resolved',
           observation_audio_url = 'https://example.test/observation.mp3'`,
    );
    await project(
      "finding.render.requires-observation",
      "track",
      "legacy-only",
      findingSortKey(OLD, "legacy-only"),
    );
    expect(
      (
        await listTracks({
          hasContext: true,
          hasObservation: true,
          hasVideo: false,
          limit: 2,
          order: "asc",
        })
      ).tracks.map((track) => track.trackId),
    ).toEqual(["legacy-only"]);
    expect((await listTracks({ hasVideo: false, limit: 2 })).tracks).toHaveLength(1);
  });

  it("reports the exact projection-backed totalCount", async () => {
    const fixtures = [
      ["sentinel-a", "2026-01-01T00:00:00.000Z"],
      ["sentinel-b", "2026-01-02T00:00:00.000Z"],
      ["sentinel-c", "2026-01-03T00:00:00.000Z"],
      ["sentinel-d", "2026-01-04T00:00:00.000Z"],
    ] as const;

    for (const [trackId, addedAt] of fixtures) {
      await seedTrack(db, { addedAt, logId: null, trackId });
      await project("finding.enrich", "track", trackId, findingSortKey(addedAt, trackId));
    }

    await setSetting(TRACK_WORK_DUE_CUTOVER_ENABLED_KEY, "true");
    const execute = vi.spyOn(db, "execute");
    const page = await listTracks({ limit: 2, order: "asc", status: "queue" });

    expect(page.tracks.map((track) => track.trackId)).toEqual(["sentinel-a", "sentinel-b"]);
    expect(page.nextCursor).toBeDefined();
    expect(page.totalCount).toBe(fixtures.length);
    expect(
      execute.mock.calls.some((call) => {
        const statement: unknown = call[0];
        return (
          typeof statement === "object" &&
          statement !== null &&
          "sql" in statement &&
          String(statement.sql).includes("select count(*) as total_count")
        );
      }),
    ).toBe(false);
  });

  it("promotes a bounded scheduled page and seeks by continuation plus subject intersection", async () => {
    await project("finding.enrich", "track", "a", "01", "scheduled");
    await project("finding.enrich", "track", "b", "02", "scheduled");
    await project("finding.enrich", "track", "c", "03");

    const page = await readPromotedDueWorkPage(db, "finding.enrich", {
      continuation: { sortKey: "01", subjectId: "a" },
      limit: 1,
      now: () => NOW,
      subjectIds: ["a", "b", "c"],
    });

    expect(page).toEqual({ hasMore: true, subjectIds: ["b"] });
  });
});

const entityQueues = [
  {
    kind: "artist.bio",
    list: listArtistsMissingBio,
    seed: seedArtist,
    subjectType: "artist",
    table: "artists",
  },
  {
    kind: "album.bio",
    list: listAlbumsMissingBio,
    seed: seedAlbum,
    subjectType: "album",
    table: "albums",
  },
  {
    kind: "label.bio",
    list: listLabelsMissingBio,
    seed: seedLabel,
    subjectType: "label",
    table: "labels",
  },
] as const;

describe("entity bio selector Goal C cutovers", () => {
  for (const queue of entityQueues) {
    it(`${queue.kind} preserves legacy order and hydrates only selected entity IDs`, async () => {
      for (const [id, createdAt] of [
        ["entity-new", NEW],
        ["entity-old", OLD],
        ["entity-middle", MIDDLE],
      ] as const) {
        await queue.seed(db, { id, name: id, slug: id });
        await db.execute({
          args: [createdAt, id],
          sql: `update ${queue.table}
                set created_at = ?, certified_finding_count = 1
                where id = ?`,
        });
        await project(
          queue.kind,
          queue.subjectType,
          id,
          findingSortKey(createdAt, id),
          id === "entity-middle" ? "scheduled" : "ready",
        );
      }

      const legacy = await queue.list(2);
      await setSetting(TRACK_WORK_DUE_CUTOVER_ENABLED_KEY, "true");
      const execute = vi.spyOn(db, "execute");
      const cutover = await queue.list(2);

      expect(cutover).toEqual(legacy);
      expect(cutover.map((entity) => entity.id)).toEqual(["entity-old", "entity-middle"]);
      const hydration = execute.mock.calls
        .map((call) => call[0] as unknown)
        .find(
          (statement): statement is { args?: unknown[]; sql: string } =>
            typeof statement === "object" &&
            statement !== null &&
            "sql" in statement &&
            typeof statement.sql === "string" &&
            statement.sql.includes(`from ${queue.table}`) &&
            statement.sql.includes("where id in (?, ?)"),
        );
      expect(hydration?.args).toEqual(["entity-old", "entity-middle"]);
      expect(hydration?.args).not.toContain("entity-new");
    });
  }
});
