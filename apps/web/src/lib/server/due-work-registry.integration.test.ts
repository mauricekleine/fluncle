import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createIntegrationDb, seedCatalogueTrack, seedTrack } from "./integration-db";
import {
  DUE_WORK_BACKFILLS,
  DUE_WORK_REGISTERED_KINDS,
  dueWorkRepairDefinitions,
} from "./due-work-registry";
import {
  compareDueWorkRows,
  markDueWorkRepair,
  readDueWorkProjectionChunk,
  repairDueWorkChunk,
  runDueWorkRebuildChunk,
  runDueWorkRebuildToCompletion,
  startDueWorkRebuild,
  upsertDueWork,
  type DueWorkProjection,
  type DueWorkRebuildDefinition,
  type DueWorkRebuildSource,
} from "./due-work";

const NOW = new Date("2026-08-26T12:00:00.000Z");
const GENERATION_ONE = "registry-generation-1";
const GENERATION_TWO = "registry-generation-2";

let db: Client;

beforeEach(async () => {
  db = await createIntegrationDb();
  await seedRegistrySources();
});

afterEach(() => {
  db.close();
});

async function seedRegistrySources(): Promise<void> {
  await db.batch(
    ["artist-1", "artist-2"].map((id, index) => ({
      args: [
        id,
        `Artist ${index + 1}`,
        `artist-${index + 1}-slug`,
        index === 0 ? "https://example.test/artist.jpg" : null,
        index === 1 ? "spotify-artist-2" : null,
        NOW.toISOString(),
        NOW.toISOString(),
      ],
      sql: `insert into artists
        (id, name, slug, image_url, spotify_artist_id, created_at, updated_at,
         renderable_track_count)
        values (?, ?, ?, ?, ?, ?, ?, 3)`,
    })),
    "write",
  );
  await db.batch(
    ["album-1", "album-2"].map((id, index) => ({
      args: [
        id,
        `Album ${index + 1}`,
        `album-${index + 1}-slug`,
        NOW.toISOString(),
        NOW.toISOString(),
      ],
      sql: `insert into albums
        (id, name, slug, created_at, updated_at, renderable_track_count)
        values (?, ?, ?, ?, ?, 3)`,
    })),
    "write",
  );
  await db.batch(
    ["label-1", "label-2"].map((id, index) => ({
      args: [
        id,
        `Label ${index + 1}`,
        `label-${index + 1}-slug`,
        NOW.toISOString(),
        NOW.toISOString(),
      ],
      sql: `insert into labels
        (id, name, slug, created_at, updated_at, renderable_track_count)
        values (?, ?, ?, ?, ?, 3)`,
    })),
    "write",
  );

  await seedTrack(db, {
    addedAt: "2026-08-01T00:00:00.000Z",
    addedToSpotify: true,
    logId: "LOG-F1",
    postedToTelegram: true,
    trackId: "finding-1",
  });
  await seedTrack(db, {
    addedAt: "2026-08-02T00:00:00.000Z",
    logId: "LOG-F2",
    trackId: "finding-2",
  });
  await seedTrack(db, {
    addedAt: "2026-08-03T00:00:00.000Z",
    logId: "LOG-F3",
    trackId: "finding-3",
  });
  await seedCatalogueTrack(db, { trackId: "catalogue-1" });
  await seedCatalogueTrack(db, { trackId: "mb_catalogue-2" });
  await seedCatalogueTrack(db, { trackId: "catalogue-3" });

  await db.batch(
    [
      {
        args: ["finding-1"],
        sql: `update tracks set source_audio_key = 'audio-f1', capture_status = 'pending',
          isrc = 'GB-FLU-26-00001', has_isrc = 1 where track_id = ?`,
      },
      {
        args: [NOW.toISOString(), "finding-2"],
        sql: `update tracks set source_audio_key = 'audio-f2', capture_status = 'pending',
          youtube_video_id = 'video-f2', youtube_video_official = 0,
          artist_edges_backfilled_at = ? where track_id = ?`,
      },
      {
        args: ["finding-3"],
        sql: `update tracks set source_audio_key = 'audio-f3', capture_status = 'pending'
          where track_id = ?`,
      },
      {
        args: ["catalogue-1"],
        sql: `update tracks set spotify_uri = null, spotify_url = null,
          source_audio_key = 'audio-c1', capture_status = 'pending', capture_priority = 10,
          isrc = 'GB-FLU-26-00002', has_isrc = 1 where track_id = ?`,
      },
      {
        args: ["mb_catalogue-2"],
        sql: `update tracks set spotify_uri = null, spotify_url = null,
          capture_priority = 9 where track_id = ?`,
      },
      {
        args: ["catalogue-3"],
        sql: `update tracks set spotify_uri = null, spotify_url = null,
          capture_priority = 8, mb_recording_id = 'recording-3',
          youtube_video_id = 'video-c3', youtube_video_official = 0 where track_id = ?`,
      },
      {
        args: ["finding-2"],
        sql: `update findings set context_note = 'context' where track_id = ?`,
      },
      {
        args: ["finding-3"],
        sql: `update findings set context_note = 'context',
          observation_audio_url = 'https://example.test/observation.mp3' where track_id = ?`,
      },
    ],
    "write",
  );
}

function identity(definition: { subjectType: string; workKind: string }): string {
  return `${definition.subjectType}:${definition.workKind}`;
}

async function allSources(
  definition: DueWorkRebuildDefinition<string, DueWorkRebuildSource>,
): Promise<DueWorkRebuildSource[]> {
  const sources: DueWorkRebuildSource[] = [];
  let after: null | string = null;
  for (;;) {
    const chunk = await definition.readSourceChunk({ after, client: db, limit: 2 });
    sources.push(...chunk);
    if (chunk.length < 2) {
      return sources;
    }
    const cursor = chunk.at(-1)?.cursor;
    if (cursor === undefined) {
      throw new Error("registry source chunk lost its cursor");
    }
    after = cursor;
  }
}

async function allAuditSources(
  definition: DueWorkRebuildDefinition<string, DueWorkRebuildSource>,
): Promise<DueWorkRebuildSource[]> {
  const reader = definition.readAuditSourceChunk ?? definition.readSourceChunk;
  const sources: DueWorkRebuildSource[] = [];
  let after: null | string = null;
  for (;;) {
    const chunk = await reader({ after, client: db, limit: 2 });
    sources.push(...chunk);
    if (chunk.length < 2) {
      return sources;
    }
    const cursor = chunk.at(-1)?.cursor;
    if (cursor === undefined) {
      throw new Error("registry audit source chunk lost its cursor");
    }
    after = cursor;
  }
}

async function expectedProjection(
  definition: DueWorkRebuildDefinition<string, DueWorkRebuildSource>,
  generation: string,
): Promise<DueWorkProjection<string>[]> {
  return (await allSources(definition)).flatMap((source) => {
    const projection = definition.project(source, {
      generation,
      now: NOW.toISOString(),
    });
    return projection === null ? [] : [projection];
  });
}

async function secondPrimaryKey(definition: {
  subjectType: string;
  workKind: string;
}): Promise<string> {
  const source = definition.workKind.startsWith("finding.")
    ? { column: "track_id", table: "findings" }
    : definition.subjectType === "track"
      ? { column: "track_id", table: "tracks" }
      : { column: "id", table: `${definition.subjectType}s` };
  const result = await db.execute(
    `select ${source.column} as id from ${source.table} order by ${source.column} limit 1 offset 1`,
  );
  const id = result.rows[0]?.id;
  if (typeof id !== "string") {
    throw new Error(`missing second primary key for ${identity(definition)}`);
  }
  return id;
}

describe("due-work registry", () => {
  it("registers every evaluator exactly once with a matching repair definition", () => {
    const rebuilds = DUE_WORK_BACKFILLS.map(identity);
    const repairs = dueWorkRepairDefinitions(db).map(identity);
    const inventory = [...DUE_WORK_REGISTERED_KINDS].map((workKind) => {
      const definition = DUE_WORK_BACKFILLS.find((candidate) => candidate.workKind === workKind);
      if (definition === undefined) {
        throw new Error(`missing rebuild definition for ${workKind}`);
      }
      return identity(definition);
    });

    expect(rebuilds).toHaveLength(41);
    expect(new Set(rebuilds).size).toBe(rebuilds.length);
    expect(rebuilds.sort()).toEqual(inventory.sort());
    expect(repairs.sort()).toEqual(inventory.sort());
  });

  it("resumes every definition from zero through a primary-key midpoint to completion", async () => {
    for (const definition of DUE_WORK_BACKFILLS) {
      const zero = await startDueWorkRebuild(db, definition, {
        generation: GENERATION_ONE,
        newGeneration: true,
        now: () => NOW,
      });
      expect(zero, identity(definition)).toMatchObject({
        cursor: null,
        projectedCount: 0,
        scannedCount: 0,
        state: "running",
      });

      const midpoint = await runDueWorkRebuildChunk(db, definition, {
        limit: 2,
        now: () => NOW,
      });
      expect(midpoint, identity(definition)).toMatchObject({
        complete: false,
        noOp: false,
        scanned: 2,
      });
      expect(midpoint.checkpoint.cursor, identity(definition)).toBe(
        await secondPrimaryKey(definition),
      );

      const complete = await runDueWorkRebuildToCompletion(db, definition, {
        limit: 2,
        now: () => NOW,
      });
      expect(complete.state, identity(definition)).toBe("complete");
      expect(complete.scannedCount, identity(definition)).toBe(
        (await allSources(definition)).length,
      );

      const restart = await runDueWorkRebuildChunk(db, definition, {
        limit: 2,
        now: () => NOW,
      });
      expect(restart, identity(definition)).toMatchObject({
        complete: true,
        noOp: true,
        projected: 0,
        scanned: 0,
      });
    }
  });

  it("pages slug-keyed definitions in canonical projected-subject order", async () => {
    await db.batch(
      [
        {
          args: ["zz-artist", "https://example.test/artist-1.jpg", "artist-1"],
          sql: `update artists set slug = ?, image_url = ? where id = ?`,
        },
        {
          args: ["aa-artist", "https://example.test/artist-2.jpg", "artist-2"],
          sql: `update artists set slug = ?, image_url = ? where id = ?`,
        },
        {
          args: ["zz-album", "album-1"],
          sql: `update albums set slug = ? where id = ?`,
        },
        {
          args: ["aa-album", "album-2"],
          sql: `update albums set slug = ? where id = ?`,
        },
        {
          args: ["zz-label", "label-1"],
          sql: `update labels set slug = ? where id = ?`,
        },
        {
          args: ["aa-label", "label-2"],
          sql: `update labels set slug = ? where id = ?`,
        },
      ],
      "write",
    );

    for (const [workKind, expectedSubjectIds] of [
      ["artist.cover-master", ["aa-artist", "zz-artist"]],
      ["album.cover-master", ["aa-album", "zz-album"]],
      ["label.image", ["aa-label", "zz-label"]],
    ] as const) {
      const definition = DUE_WORK_BACKFILLS.find((candidate) => candidate.workKind === workKind);
      if (definition === undefined) {
        throw new Error(`missing slug-keyed definition for ${workKind}`);
      }

      const sources = await allAuditSources(definition);
      expect(
        sources.map((source) => source.cursor),
        identity(definition),
      ).toEqual(expectedSubjectIds);
      expect(
        sources.map((source) => source.subjectId),
        identity(definition),
      ).toEqual(expectedSubjectIds);

      await runDueWorkRebuildToCompletion(db, definition, {
        generation: GENERATION_ONE,
        limit: 1,
        newGeneration: true,
        now: () => NOW,
      });
      const actual = await readDueWorkProjectionChunk(db, definition, {
        generation: GENERATION_ONE,
        limit: 500,
      });
      expect(
        actual.items.map((row) => row.subjectId),
        identity(definition),
      ).toEqual(expectedSubjectIds);
    }
  });

  it("detects injected drift, rebuilds every definition, and converges every repair", async () => {
    for (const definition of DUE_WORK_BACKFILLS) {
      await runDueWorkRebuildToCompletion(db, definition, {
        generation: GENERATION_ONE,
        limit: 2,
        newGeneration: true,
        now: () => NOW,
      });
      const expected = await expectedProjection(definition, GENERATION_ONE);
      const actual = await readDueWorkProjectionChunk(db, definition, {
        generation: GENERATION_ONE,
        limit: 500,
      });
      expect(compareDueWorkRows(expected, actual.items), identity(definition)).toEqual({
        mismatched: [],
        missing: [],
        unexpected: [],
      });

      await upsertDueWork(
        db,
        {
          generation: GENERATION_ONE,
          nextDueAt: NOW.toISOString(),
          sortKey: "drift",
          sourceVersion: "drift",
          state: "ready",
          subjectId: `unexpected-${definition.workKind}`,
          subjectType: definition.subjectType,
          workKind: definition.workKind,
        },
        { now: NOW },
      );
      const drifted = await readDueWorkProjectionChunk(db, definition, {
        generation: GENERATION_ONE,
        limit: 500,
      });
      expect(
        compareDueWorkRows(expected, drifted.items).unexpected,
        identity(definition),
      ).toHaveLength(1);

      await runDueWorkRebuildToCompletion(db, definition, {
        generation: GENERATION_TWO,
        limit: 2,
        newGeneration: true,
        now: () => NOW,
      });
      const rebuiltExpected = await expectedProjection(definition, GENERATION_TWO);
      const rebuiltActual = await readDueWorkProjectionChunk(db, definition, {
        generation: GENERATION_TWO,
        limit: 500,
      });
      expect(
        compareDueWorkRows(rebuiltExpected, rebuiltActual.items),
        identity(definition),
      ).toEqual({
        mismatched: [],
        missing: [],
        unexpected: [],
      });
    }

    const repairs = dueWorkRepairDefinitions(db);
    for (const definition of DUE_WORK_BACKFILLS) {
      const source = (await definition.readSourceChunk({ after: null, client: db, limit: 1 }))[0];
      if (source === undefined) {
        throw new Error(`missing repair source for ${identity(definition)}`);
      }
      await markDueWorkRepair(
        db,
        {
          sourceVersion: "repair-source-version",
          subjectId: source.subjectId,
          subjectType: definition.subjectType,
          workKind: definition.workKind,
        },
        { now: NOW },
      );
      const repair = repairs.find((candidate) => identity(candidate) === identity(definition));
      if (repair === undefined) {
        throw new Error(`missing repair definition for ${identity(definition)}`);
      }
      await repairDueWorkChunk(db, repair, { limit: 1, now: () => NOW });
      const remaining = await db.execute({
        args: [definition.workKind, definition.subjectType, source.subjectId],
        sql: `select state from due_work
          where work_kind = ? and subject_type = ? and subject_id = ? and state = 'repair'`,
      });
      expect(remaining.rows, identity(definition)).toEqual([]);
    }
  });
});
