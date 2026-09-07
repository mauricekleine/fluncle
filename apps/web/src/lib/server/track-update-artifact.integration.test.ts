import { type Client } from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  activateArtifactConsumer,
  artifactBytesToBase64,
  artifactContract,
  checkpointArtifactRebuild,
  compactArtifactChanges,
  listArtifactSnapshot,
  registerArtifactConsumer,
} from "./artifact-changes";
import { CATALOGUE_RANK_MATERIAL_REVISION_KEY, CATALOGUE_RANK_STATE_KEY } from "./catalogue";
import {
  compareDueWorkRows,
  DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
  DUE_WORK_SOURCE_REPAIR_KIND,
  markDueWorkSourceRepairsStatement,
  readDueWorkProjectionChunk,
} from "./due-work";
import { DUE_WORK_BACKFILLS } from "./due-work-registry";
import { fanOutDueWorkSourceRepairs } from "./due-work-source-repair";
import {
  createIntegrationDb,
  seedArtist,
  seedCatalogueTrack,
  seedEmbedding,
  seedTrack,
} from "./integration-db";

let db: Client;
let fixtureDirectory: string | undefined;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

vi.mock("./edge-cache", () => ({ purgeLogCache: () => undefined }));

vi.mock("./entity-cache-purge", () => ({ purgeTrackEntityPages: () => undefined }));

const TRACK_ID = "artifact-track-00000001";

function embeddingJson(seed = 0): string {
  return JSON.stringify(Array.from({ length: 1024 }, (_, index) => seed + index / 1024));
}

function blobBase64(value: unknown): string {
  if (!(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)) {
    throw new Error("expected a vector blob");
  }

  return artifactBytesToBase64(value);
}

function parsedJson(value: unknown): unknown {
  if (typeof value !== "string") {
    throw new Error("expected JSON text");
  }

  return JSON.parse(value) as unknown;
}

async function rowCount(table: string): Promise<number> {
  const result = await db.execute(`select count(*) as count from ${table}`);

  return Number(result.rows[0]?.count ?? 0);
}

async function drainSourceRepairs(): Promise<void> {
  for (let step = 0; step < 10; step += 1) {
    const result = await fanOutDueWorkSourceRepairs(db, { limit: 100 });
    if (!result.hasMore) {
      return;
    }
  }
  throw new Error("source repairs did not drain within ten bounded actions");
}

beforeEach(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "fluncle-track-update-artifact-"));
  db = await createIntegrationDb({ url: `file:${join(fixtureDirectory, "fixture.db")}` });
  await seedTrack(db, { logId: "004.7.2I", trackId: TRACK_ID });
  await seedArtist(db, { id: "artifact-artist", name: "Artifact Artist", slug: "artifact-artist" });
  await db.execute({
    args: [TRACK_ID, "artifact-artist"],
    sql: `insert into track_artists (track_id, artist_id, position) values (?, ?, 1)`,
  });
});

afterEach(async () => {
  db.close();

  if (fixtureDirectory !== undefined) {
    await rm(fixtureDirectory, { force: true, recursive: true });
    fixtureDirectory = undefined;
  }
});

describe("updateTrack Sonar artifact coupling", () => {
  it("prepares vector bytes and content digest before opening one minimal write transaction", async () => {
    const { updateTrack } = await import("./track-update");
    const timeline: string[] = [];
    const originalFloat32From = Float32Array.from.bind(Float32Array);
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    const originalTransaction = db.transaction.bind(db);
    let insertedBlob: ArrayBuffer | ArrayBufferView | null = null;
    let preparedBlobBase64: string | null = null;
    let preparedReceiptDigest: string | null = null;
    let receiptDigest: string | null = null;
    let revisionLookupCount = 0;

    const float32From = vi.spyOn(Float32Array, "from").mockImplementation((values) => {
      timeline.push("bytes");
      const vector = originalFloat32From(values);
      preparedBlobBase64 = artifactBytesToBase64(
        new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength),
      );
      return vector;
    });
    const digest = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
      timeline.push("digest:start");
      const value = await originalDigest(algorithm, data);
      preparedReceiptDigest = `v2:${[...new Uint8Array(value)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("")}`;
      timeline.push("digest:complete");
      return value;
    });
    const transaction = vi.spyOn(db, "transaction").mockImplementation(async () => {
      timeline.push("transaction");
      const opened = await originalTransaction("write");
      const originalExecute = opened.execute.bind(opened);

      vi.spyOn(opened, "execute").mockImplementation(async (statement) => {
        if (typeof statement !== "string") {
          const statementArgs = Array.isArray(statement.args) ? statement.args : [];

          if (statement.sql.includes("select max(revision) as revision")) {
            revisionLookupCount += 1;
          }
          if (statement.sql.includes("insert into artifact_changes")) {
            insertedBlob = statementArgs[3] as ArrayBuffer | ArrayBufferView | null;
          }
          if (statement.sql.includes("insert into artifact_change_revisions")) {
            receiptDigest = typeof statementArgs[0] === "string" ? statementArgs[0] : null;
          }
        }

        return originalExecute(statement);
      });

      return opened;
    });

    try {
      await updateTrack(TRACK_ID, { embedding: embeddingJson(3) });

      expect(timeline).toEqual(["bytes", "digest:start", "digest:complete", "transaction"]);
      expect(float32From).toHaveBeenCalledTimes(1);
      expect(digest).toHaveBeenCalledTimes(1);
      expect(insertedBlob).not.toBeNull();
      expect(blobBase64(insertedBlob)).toBe(preparedBlobBase64);
      expect(receiptDigest).toBe(preparedReceiptDigest);
      expect(revisionLookupCount).toBe(1);
    } finally {
      transaction.mockRestore();
      digest.mockRestore();
      float32From.mockRestore();
    }
  });

  it("rejects malformed embedding material before opening a transaction", async () => {
    const { updateTrack } = await import("./track-update");
    const transaction = vi.spyOn(db, "transaction");

    try {
      await expect(updateTrack(TRACK_ID, { embedding: "[1]" })).rejects.toThrow(
        /1024 finite numbers/,
      );
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      transaction.mockRestore();
    }
  });

  it("commits a key write, aggregate repair, and one exact current-row upsert together", async () => {
    const { updateTrack } = await import("./track-update");

    await updateTrack(TRACK_ID, {
      bpm: 174.125,
      embedding: embeddingJson(),
      key: "Fmin",
    });

    const source = await db.execute({
      args: [TRACK_ID],
      sql: `select t.has_embedding, e.embedding_blob
        from tracks t
        left join track_embeddings e on e.track_id = t.track_id
        where t.track_id = ?`,
    });
    const event = await db.execute({
      args: [TRACK_ID],
      sql: `select format_version, operation, payload_blob, payload_json, revision, stream_version
        from artifact_changes
        where stream = 'sonar.track' and subject_id = ?`,
    });

    expect(source.rows[0]?.has_embedding).toBe(1);
    const artist = await db.execute(
      `select rankable_track_count as n from artists where id = 'artifact-artist'`,
    );
    expect(Number(artist.rows[0]?.n ?? -1)).toBe(1);
    expect(event.rows).toHaveLength(1);
    expect(event.rows[0]).toMatchObject({
      format_version: 1,
      operation: "upsert",
      revision: 1,
      stream_version: 1,
    });
    expect(parsedJson(event.rows[0]?.payload_json)).toEqual({
      anchored: true,
      bpm: 174.125,
      certified: true,
      dismissed: false,
      durationMs: 270_000,
      hasFinding: true,
      isDuplicate: false,
      key: "Fmin",
      nearestFindingScore: null,
    });
    expect(blobBase64(event.rows[0]?.payload_blob)).toBe(
      blobBase64(source.rows[0]?.embedding_blob),
    );
    expect(await rowCount("artifact_change_revisions")).toBe(1);
    expect(await rowCount("due_work")).toBe(2);
    expect(await rowCount("projection_repairs")).toBe(1);
    expect(await rowCount("public_aggregate_state")).toBe(1);
    expect(await rowCount("artist_qualification_state")).toBe(0);
  });

  it("keeps an uncoordinated finding unlit in both its incremental event and rebuild snapshot", async () => {
    const { updateTrack } = await import("./track-update");
    await db.execute({
      args: [TRACK_ID],
      sql: "update findings set log_id = null where track_id = ?",
    });

    await updateTrack(TRACK_ID, { embedding: embeddingJson() });
    const event = await db.execute({
      args: [TRACK_ID],
      sql: "select payload_json from artifact_changes where subject_id = ?",
    });
    await registerArtifactConsumer(db, {
      consumerId: "uncoordinated-snapshot",
      contracts: [artifactContract("sonar.track")],
    });
    const snapshot = await listArtifactSnapshot(db, {
      consumerId: "uncoordinated-snapshot",
      stream: "sonar.track",
      streamVersion: 1,
    });
    const incrementalPayload = parsedJson(event.rows[0]?.payload_json);
    const snapshotPayload = parsedJson(snapshot.items[0]?.payloadJson);

    expect(incrementalPayload).toEqual(snapshotPayload);
    expect(incrementalPayload).toMatchObject({ certified: false, hasFinding: true });
  });

  it("commits a clear as one delete tombstone beside both source halves", async () => {
    const { updateTrack } = await import("./track-update");
    await updateTrack(TRACK_ID, { embedding: embeddingJson() });

    await updateTrack(TRACK_ID, { embedding: "" });

    const source = await db.execute({
      args: [TRACK_ID, TRACK_ID],
      sql: `select has_embedding,
        (select count(*) from track_embeddings where track_id = ?) as satellite_count
        from tracks where track_id = ?`,
    });
    const events = await db.execute({
      args: [TRACK_ID],
      sql: `select operation, payload_blob, payload_json, revision
        from artifact_changes where stream = 'sonar.track' and subject_id = ? order by revision`,
    });

    expect(source.rows[0]).toMatchObject({ has_embedding: 0, satellite_count: 0 });
    expect(events.rows).toHaveLength(2);
    expect(events.rows[1]).toEqual({
      operation: "delete",
      payload_blob: null,
      payload_json: "{}",
      revision: 2,
    });
  });

  it("allocates the next revision from compacted receipts as well as live events", async () => {
    const { updateTrack } = await import("./track-update");
    await updateTrack(TRACK_ID, { embedding: embeddingJson() });
    await registerArtifactConsumer(db, {
      consumerId: "sonar-compaction-proof",
      contracts: [artifactContract("sonar.track")],
    });
    const page = await listArtifactSnapshot(db, {
      consumerId: "sonar-compaction-proof",
      stream: "sonar.track",
      streamVersion: 1,
    });
    await checkpointArtifactRebuild(db, {
      consumerDigest: page.sourceDigest,
      consumerId: "sonar-compaction-proof",
      consumerItemCount: page.itemCount,
      generation: page.generation,
      pageDigest: page.pageDigest,
      pageLimit: 100,
      stream: "sonar.track",
      streamVersion: 1,
    });
    await activateArtifactConsumer(db, "sonar-compaction-proof");

    expect(await compactArtifactChanges(db)).toMatchObject({
      deletedCount: 1,
      deletedThroughSeq: 1,
      reason: "compacted",
    });
    expect(await rowCount("artifact_changes")).toBe(0);
    expect(await rowCount("artifact_change_revisions")).toBe(1);

    await updateTrack(TRACK_ID, { embedding: "" });

    const live = await db.execute({
      args: [TRACK_ID],
      sql: "select operation, revision from artifact_changes where subject_id = ?",
    });
    const receipts = await db.execute({
      args: [TRACK_ID],
      sql: `select revision from artifact_change_revisions
        where subject_id = ? order by revision`,
    });

    expect(live.rows).toEqual([{ operation: "delete", revision: 2 }]);
    expect(receipts.rows).toEqual([{ revision: 1 }, { revision: 2 }]);
  });

  it("rebuilds every catalogue-rank page when a finding vector is replaced in place", async () => {
    const { updateTrack } = await import("./track-update");
    for (const trackId of [
      "rank-replace-a",
      "rank-replace-b",
      "rank-replace-dismissed",
      "rank-replace-preaudio",
    ]) {
      await seedCatalogueTrack(db, { trackId });
    }
    for (const trackId of ["rank-replace-a", "rank-replace-b", "rank-replace-dismissed"]) {
      await seedEmbedding(db, trackId, JSON.parse(embeddingJson()) as number[]);
    }
    await db.execute(`update tracks set dismissed_at = '2026-01-01T00:00:00.000Z'
      where track_id = 'rank-replace-dismissed'`);
    await updateTrack(TRACK_ID, { embedding: embeddingJson(1) });
    await drainSourceRepairs();

    const state = await db.execute({
      args: [CATALOGUE_RANK_STATE_KEY],
      sql: "select value from settings where key = ?",
    });
    const stateValue = state.rows[0]?.value;
    if (typeof stateValue !== "string") {
      throw new Error("catalogue-rank state cache was not populated");
    }
    const cached = JSON.parse(stateValue) as { corpus?: string };
    if (cached.corpus === undefined) {
      throw new Error("catalogue-rank state cache was not populated");
    }
    await db.execute({
      args: [cached.corpus],
      sql: `update tracks set catalogue_rank_corpus = ?, nearest_finding_score = 0.25,
        capture_priority = null where track_id like 'rank-replace-%'`,
    });
    await db.execute("delete from due_work where work_kind = 'catalogue-rank'");
    const completed = await db.execute(`select generation from due_work_rebuilds
      where work_kind = 'catalogue-rank' and subject_type = 'track'`);
    const completedGeneration = completed.rows[0]?.generation;
    expect(typeof completedGeneration).toBe("string");

    await updateTrack(TRACK_ID, { embedding: embeddingJson(2) });
    const marker = await db.execute({
      args: [DUE_WORK_SOURCE_REPAIR_KIND, DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID],
      sql: `select source_version from due_work where work_kind = ? and subject_id = ?`,
    });
    expect(marker.rows[0]?.source_version).toMatch(/^track-update:/);
    expect(
      (
        await db.execute({
          args: [CATALOGUE_RANK_MATERIAL_REVISION_KEY],
          sql: "select value from settings where key = ?",
        })
      ).rows[0]?.value,
    ).toBe(marker.rows[0]?.source_version);

    expect(await fanOutDueWorkSourceRepairs(db, { limit: 100 })).toMatchObject({
      deferred: 1,
      rankRebuildScanned: 5,
    });
    const replacement = await db.execute(`select generation, scanned_count, state
      from due_work_rebuilds where work_kind = 'catalogue-rank' and subject_type = 'track'`);
    expect(replacement.rows[0]?.generation).not.toBe(completedGeneration);
    expect(replacement.rows[0]).toMatchObject({ scanned_count: 5, state: "running" });
    expect(
      Number(
        (
          await db.execute(`select count(*) as n from due_work
            where work_kind = 'catalogue-rank' and state = 'ready'`)
        ).rows[0]?.n ?? 0,
      ),
    ).toBe(2);
    const generationValue = replacement.rows[0]?.generation;
    if (typeof generationValue !== "string") {
      throw new Error("replacement catalogue-rank generation is missing");
    }
    const generation = generationValue;
    const definition = DUE_WORK_BACKFILLS.find(
      (candidate) => candidate.workKind === "catalogue-rank",
    );
    if (definition === undefined) {
      throw new Error("catalogue-rank rebuild definition is missing");
    }
    const actual = await readDueWorkProjectionChunk(db, definition, {
      generation,
      limit: 100,
    });
    const projectionNow = actual.items[0]?.nextDueAt;
    if (projectionNow === undefined) {
      throw new Error("material catalogue-rank projection is missing");
    }
    const sources = await definition.readSourceChunk({
      after: null,
      client: db,
      generation,
      limit: 100,
    });
    const expected = sources.flatMap((source) => {
      const projection = definition.project(source, {
        generation,
        now: projectionNow,
      });
      return projection === null ? [] : [projection];
    });
    expect(compareDueWorkRows(expected, actual.items)).toEqual({
      mismatched: [],
      missing: [],
      unexpected: [],
    });
    const replacementState = (
      await db.execute({
        args: [CATALOGUE_RANK_STATE_KEY],
        sql: "select value from settings where key = ?",
      })
    ).rows[0]?.value;
    expect(replacementState).not.toBe(state.rows[0]?.value);

    await db.execute(
      markDueWorkSourceRepairsStatement([{ subjectId: "rank-replace-a", subjectType: "track" }], {
        producer: "capture-verification",
      }),
    );
    await fanOutDueWorkSourceRepairs(db, { includeCatalogueRank: false, limit: 100 });
    expect(
      Number(
        (
          await db.execute(`select count(*) as n from due_work
            where work_kind = 'catalogue-rank' and state = 'ready'`)
        ).rows[0]?.n ?? 0,
      ),
    ).toBe(2);
    expect(
      (
        await db.execute({
          args: [CATALOGUE_RANK_STATE_KEY],
          sql: "select value from settings where key = ?",
        })
      ).rows[0]?.value,
    ).toBe(replacementState);
  });

  it("keeps catalogue-only vector writes on their row-local repair marker", async () => {
    const { updateTrack } = await import("./track-update");
    await seedCatalogueTrack(db, { trackId: "rank-catalogue-vector" });

    await updateTrack("rank-catalogue-vector", { embedding: embeddingJson(3) });

    const markers = await db.execute({
      args: [DUE_WORK_SOURCE_REPAIR_KIND],
      sql: `select subject_id, source_version from due_work
        where work_kind = ? order by subject_id`,
    });
    expect(markers.rows).toHaveLength(1);
    expect(markers.rows[0]?.subject_id).toBe("rank-catalogue-vector");
    expect(markers.rows[0]?.source_version).toMatch(/^track-update:/);
    expect(
      (
        await db.execute({
          args: [CATALOGUE_RANK_MATERIAL_REVISION_KEY],
          sql: "select value from settings where key = ?",
        })
      ).rows,
    ).toEqual([]);
  });

  it("does not advance rank material state for identical finding vector bytes", async () => {
    const { updateTrack } = await import("./track-update");
    const embedding = embeddingJson(4);
    await updateTrack(TRACK_ID, { embedding });
    await drainSourceRepairs();
    const revision = (
      await db.execute({
        args: [CATALOGUE_RANK_MATERIAL_REVISION_KEY],
        sql: "select value from settings where key = ?",
      })
    ).rows[0]?.value;

    await updateTrack(TRACK_ID, { embedding });

    expect(
      (
        await db.execute({
          args: [CATALOGUE_RANK_MATERIAL_REVISION_KEY],
          sql: "select value from settings where key = ?",
        })
      ).rows[0]?.value,
    ).toBe(revision);
    expect(
      (
        await db.execute({
          args: [DUE_WORK_SOURCE_REPAIR_KIND, DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID],
          sql: `select source_version from due_work where work_kind = ? and subject_id = ?`,
        })
      ).rows,
    ).toEqual([]);
  });

  it("rolls source, shadow, event, and receipt writes back when the event append fails", async () => {
    const { updateTrack } = await import("./track-update");
    await db.execute(`create trigger reject_sonar_artifact before insert on artifact_changes
      when new.stream = 'sonar.track'
      begin select raise(abort, 'reject sonar artifact'); end`);

    await expect(updateTrack(TRACK_ID, { bpm: 176, embedding: embeddingJson(1) })).rejects.toThrow(
      /reject sonar artifact/,
    );

    const source = await db.execute({
      args: [TRACK_ID],
      sql: "select bpm, has_embedding from tracks where track_id = ?",
    });

    expect(source.rows[0]).toEqual({ bpm: null, has_embedding: 0 });
    expect(await rowCount("track_embeddings")).toBe(0);
    expect(await rowCount("due_work")).toBe(0);
    expect(await rowCount("public_aggregate_state")).toBe(0);
    expect(await rowCount("artist_qualification_state")).toBe(0);
    expect(await rowCount("projection_repairs")).toBe(0);
    expect(await rowCount("artifact_changes")).toBe(0);
    expect(await rowCount("artifact_change_revisions")).toBe(0);

    await db.execute("drop trigger reject_sonar_artifact");
    await updateTrack(TRACK_ID, { bpm: 176, embedding: embeddingJson(1) });

    const retry = await db.execute("select revision from artifact_changes");
    expect(retry.rows).toEqual([{ revision: 1 }]);
  });

  it("emits nothing for a non-embedding update even when the track already has a vector", async () => {
    const { updateTrack } = await import("./track-update");
    await seedEmbedding(db, TRACK_ID, JSON.parse(embeddingJson()) as number[]);

    await updateTrack(TRACK_ID, { bpm: 172, features: '{"onsetRate":12}' });

    expect(await rowCount("artifact_changes")).toBe(0);
    expect(await rowCount("artifact_change_revisions")).toBe(0);
    expect(await rowCount("due_work")).toBe(1);
    expect(await rowCount("public_aggregate_state")).toBe(0);
    expect(await rowCount("artist_qualification_state")).toBe(0);
    expect(await rowCount("projection_repairs")).toBe(0);
  });
});
