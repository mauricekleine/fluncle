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
import { createIntegrationDb, seedArtist, seedEmbedding, seedTrack } from "./integration-db";

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
