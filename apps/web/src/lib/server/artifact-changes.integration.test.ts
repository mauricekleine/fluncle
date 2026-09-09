import { ARTIFACT_SUPPORTED_CONTRACTS } from "@fluncle/contracts/orpc";
import { type Client, type InStatement } from "@libsql/client";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  acknowledgeArtifactChanges,
  activateArtifactConsumer,
  ARTIFACT_CHANGE_MAX_READ_LIMIT,
  ARTIFACT_CONTRACTS,
  ARTIFACT_SNAPSHOT_MAX_LIMIT,
  ARTIFACT_VECTOR_BYTES,
  artifactBytesToBase64,
  artifactContract,
  buildArtifactConsumerPurgeCandidateStatement,
  buildArtifactChangeInsertStatement,
  buildArtifactSnapshotStatement,
  canonicalArtifactJson,
  checkpointArtifactRebuild,
  compactArtifactChanges,
  getArtifactConsumerStatus,
  inactivateArtifactConsumer,
  insertArtifactChange,
  insertArtifactChangeInTransaction,
  listArtifactConsumerPurgeCandidates,
  listArtifactChanges,
  listArtifactSnapshot,
  prepareArtifactChange,
  registerArtifactConsumer,
  type ArtifactChangeInput,
  type ArtifactContract,
} from "./artifact-changes";
import {
  createIntegrationDb,
  seedCatalogueTrack,
  seedEmbedding,
  seedTrack,
} from "./integration-db";

type CanonicalPayloadFixture = {
  expectedDigest: string;
  expectedPayloadJson: string;
  inputBpm: string | null;
  inputNearestFindingScore?: string;
  name: string;
  subjectId: string;
};

const CANONICAL_PAYLOAD_FIXTURES = JSON.parse(
  readFileSync(
    new URL("../../../../sonar/tests/fixtures/canonical-sonar-payloads.json", import.meta.url),
    "utf8",
  ),
) as CanonicalPayloadFixture[];

let db: Client;
let fixtureDirectory: string | undefined;

beforeEach(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "fluncle-artifact-changes-"));
  db = await createIntegrationDb({ url: `file:${join(fixtureDirectory, "fixture.db")}` });
});

afterEach(async () => {
  db.close();

  if (fixtureDirectory !== undefined) {
    await rm(fixtureDirectory, { force: true, recursive: true });
    fixtureDirectory = undefined;
  }
});

function vectorBytes(seed = 0): Uint8Array {
  const bytes = new Uint8Array(ARTIFACT_VECTOR_BYTES);
  const view = new DataView(bytes.buffer);

  for (let index = 0; index < 1024; index += 1) {
    view.setFloat32(index * Float32Array.BYTES_PER_ELEMENT, seed + index / 1024, true);
  }

  return bytes;
}

function sonarPayload(overrides: Record<string, unknown> = {}) {
  return {
    anchored: true,
    bpm: 174.25,
    certified: true,
    dismissed: false,
    durationMs: 245_000,
    hasFinding: true,
    isDuplicate: false,
    key: "Amin",
    nearestFindingScore: 0.8125,
    ...overrides,
  };
}

function sonarChange(
  revision: number,
  overrides: Partial<ArtifactChangeInput> = {},
): ArtifactChangeInput {
  return {
    ...artifactContract("sonar.track"),
    createdAt: `2026-01-${String(revision).padStart(2, "0")}T00:00:00.000Z`,
    operation: "upsert",
    payload: sonarPayload(),
    payloadBlob: vectorBytes(revision),
    producer: "artifact-test",
    revision,
    subjectId: "track:a",
    subjectType: "track",
    ...overrides,
  };
}

async function insertRawArtifactChangeRow(input: {
  revision: number;
  stream: string;
  streamVersion: number;
  subjectId: string;
  subjectType: string;
}): Promise<void> {
  await db.execute({
    args: [
      "2026-03-01T00:00:00.000Z",
      input.revision,
      input.stream,
      input.streamVersion,
      input.subjectId,
      input.subjectType,
    ],
    sql: `insert into artifact_changes
      (created_at, format_version, operation, payload_blob, payload_json, producer, revision,
       stream, stream_version, subject_id, subject_type)
      values (?, 1, 'upsert', null, '{}', 'artifact-test-fixture', ?, ?, ?, ?, ?)`,
  });
}

async function insertRawArtifactRevisionReceipt(input: {
  eventSeq: number;
  revision: number;
  stream: string;
  streamVersion: number;
  subjectId: string;
  subjectType: string;
}): Promise<void> {
  await db.execute({
    args: [
      `fixture-digest-${input.eventSeq}`,
      "2026-03-01T00:00:00.000Z",
      input.eventSeq,
      "artifact-test-fixture",
      input.revision,
      input.stream,
      input.streamVersion,
      input.subjectId,
      input.subjectType,
    ],
    sql: `insert into artifact_change_revisions
      (content_digest, created_at, event_seq, producer, revision, stream, stream_version,
       subject_id, subject_type)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  });
}

async function finishSnapshot(
  consumerId: string,
  contract: ArtifactContract,
  limit = ARTIFACT_SNAPSHOT_MAX_LIMIT,
): Promise<void> {
  let consumerItemCount = 0;

  for (;;) {
    const page = await listArtifactSnapshot(db, {
      consumerId,
      limit,
      stream: contract.stream,
      streamVersion: contract.streamVersion,
    });
    consumerItemCount += page.itemCount;
    await checkpointArtifactRebuild(db, {
      consumerDigest: page.sourceDigest,
      consumerId,
      consumerItemCount,
      generation: page.generation,
      pageDigest: page.pageDigest,
      pageLimit: limit,
      stream: contract.stream,
      streamVersion: contract.streamVersion,
    });

    if (page.complete) {
      return;
    }
  }
}

async function bootstrapConsumer(
  consumerId: string,
  contracts: readonly ArtifactContract[] = [artifactContract("sonar.track")],
): Promise<void> {
  await registerArtifactConsumer(db, { consumerId, contracts }, { now: "2026-02-01T00:00:00Z" });

  for (const contract of contracts) {
    await finishSnapshot(consumerId, contract);
  }

  await activateArtifactConsumer(db, consumerId, { now: "2026-02-01T00:01:00Z" });
}

async function ackPage(consumerId: string, limit = ARTIFACT_CHANGE_MAX_READ_LIMIT) {
  const page = await listArtifactChanges(db, { consumerId, limit });

  if (page.events.length === 0) {
    throw new Error("expected an artifact page to acknowledge");
  }

  return acknowledgeArtifactChanges(
    db,
    {
      batchDigest: page.batchDigest,
      consumerId,
      eventCount: page.events.length,
      fromSeq: page.fromSeq,
      throughSeq: page.throughSeq,
    },
    { now: "2026-02-01T00:02:00Z" },
  );
}

describe("artifact producer registry and immutable sequence", () => {
  it("matches the externally declared consumer contracts exactly", () => {
    expect(ARTIFACT_CONTRACTS).toEqual(ARTIFACT_SUPPORTED_CONTRACTS);
  });

  it("is fail-closed on stream/version/subject/payload and emits canonical JSON", () => {
    const statement = buildArtifactChangeInsertStatement(
      sonarChange(1, {
        payload: {
          anchored: true,
          bpm: 172,
          certified: true,
          dismissed: false,
          durationMs: 240_000,
          hasFinding: true,
          isDuplicate: false,
          key: "Cmin",
          nearestFindingScore: 0.5,
        },
      }),
    );

    expect(statement).toMatchObject({
      args: expect.arrayContaining([
        canonicalArtifactJson({
          anchored: true,
          bpm: 172,
          certified: true,
          dismissed: false,
          durationMs: 240_000,
          hasFinding: true,
          isDuplicate: false,
          key: "Cmin",
          nearestFindingScore: 0.5,
        }),
      ]),
    });

    expect(() =>
      buildArtifactChangeInsertStatement({
        ...sonarChange(1),
        stream: "sonar.unknown" as "sonar.track",
      }),
    ).toThrow(/Unsupported artifact stream/);
    expect(() =>
      buildArtifactChangeInsertStatement({ ...sonarChange(1), streamVersion: 2 }),
    ).toThrow(/Unsupported artifact contract/);
    expect(() =>
      buildArtifactChangeInsertStatement({ ...sonarChange(1), subjectType: "artist" }),
    ).toThrow(/subjectType/);
    expect(() =>
      buildArtifactChangeInsertStatement({
        ...sonarChange(1),
        payload: { ...sonarPayload(), surprise: true },
      }),
    ).toThrow(/payload keys/);
    expect(() =>
      buildArtifactChangeInsertStatement({
        ...sonarChange(1),
        payloadBlob: new Uint8Array(8),
      }),
    ).toThrow(/exactly 4096 bytes/);
  });

  it("makes duplicate retries idempotent, revisions monotonic, and bytes exact", async () => {
    const first = await insertArtifactChange(db, sonarChange(1));
    const retry = await insertArtifactChange(db, {
      ...sonarChange(1),
      createdAt: undefined,
      producer: "retry-producer",
    });
    const second = await insertArtifactChange(
      db,
      sonarChange(2, { payloadBlob: vectorBytes(22), subjectId: "track:b" }),
    );

    expect(first.inserted).toBe(true);
    expect(retry).toMatchObject({ event: { seq: first.event.seq }, inserted: false });
    expect(second.event.seq).toBeGreaterThan(first.event.seq);
    expect(first.event.payloadBlobBase64).toBe(artifactBytesToBase64(vectorBytes(1)));

    await expect(
      insertArtifactChange(db, sonarChange(1, { payload: sonarPayload({ bpm: 170 }) })),
    ).rejects.toThrow(/different immutable content/);
    await insertArtifactChange(db, sonarChange(3));
    await expect(insertArtifactChange(db, sonarChange(2))).rejects.toThrow(/greater than/);

    const stored = await db.execute({
      args: [first.event.seq],
      sql: "select payload_blob from artifact_changes where seq = ?",
    });
    const blob = stored.rows[0]?.payload_blob;

    expect(blob instanceof ArrayBuffer || ArrayBuffer.isView(blob)).toBe(true);
    expect(artifactBytesToBase64(blob as ArrayBuffer | ArrayBufferView)).toBe(
      artifactBytesToBase64(vectorBytes(1)),
    );
  });

  it("accepts revision-bearing receipts written before prepared content digests", async () => {
    const input = sonarChange(1, { subjectId: "track:legacy-receipt" });
    const prepared = await prepareArtifactChange(input);

    await db.execute({
      args: [
        prepared.legacyContentDigest,
        "2026-03-01T00:00:00.000Z",
        77,
        "legacy-producer",
        1,
        "sonar.track",
        1,
        "track:legacy-receipt",
        "track",
      ],
      sql: `insert into artifact_change_revisions
        (content_digest, created_at, event_seq, producer, revision, stream, stream_version,
         subject_id, subject_type)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    });

    await expect(insertArtifactChange(db, input)).resolves.toMatchObject({
      event: { producer: "legacy-producer", seq: 77 },
      inserted: false,
    });
    expect(
      (await db.execute("select count(*) as count from artifact_changes")).rows[0]?.count,
    ).toBe(0);
  });

  it("bounds latest revision lookup to one indexed maximum per history table", async () => {
    const prepared = await prepareArtifactChange(sonarChange(1));
    const transaction = await db.transaction("write");
    const execute = vi.spyOn(transaction, "execute");

    try {
      await insertArtifactChangeInTransaction(transaction, prepared);
      await transaction.commit();
    } finally {
      transaction.close();
    }

    const latestStatement = execute.mock.calls
      .map(([statement]) => statement)
      .find(
        (statement): statement is Extract<InStatement, { sql: string }> =>
          typeof statement !== "string" &&
          statement !== undefined &&
          statement.sql.includes("select max(revision) as revision") &&
          statement.sql.includes("from artifact_change_revisions"),
      );

    expect(latestStatement).toBeDefined();
    expect(latestStatement?.args).toEqual([
      "sonar.track",
      1,
      "track",
      "track:a",
      "sonar.track",
      1,
      "track",
      "track:a",
    ]);
    expect(latestStatement?.sql.match(/select max\(revision\) as revision/g)).toHaveLength(3);
    const plan = await db.execute({
      args: latestStatement?.args ?? [],
      sql: `explain query plan ${latestStatement?.sql ?? ""}`,
    });
    const details = plan.rows
      .map((row) =>
        typeof row.detail === "string" ? row.detail : (JSON.stringify(row.detail ?? null) ?? ""),
      )
      .join("\n");

    expect(details).toMatch(
      /SEARCH artifact_change_revisions USING COVERING INDEX sqlite_autoindex_artifact_change_revisions_1/i,
    );
    expect(details).toMatch(/SEARCH artifact_changes USING.*artifact_changes_revision_idx/i);
    expect(details).not.toMatch(/\bSCAN (?:artifact_change_revisions|artifact_changes)\b/i);
    expect(details).not.toMatch(/USE TEMP B-TREE/i);
  });

  it("matches the former whole-history union across empty, split, and isolated histories", async () => {
    const prepared = await prepareArtifactChange(
      sonarChange(1, { subjectId: "track:query-template" }),
    );
    const transaction = await db.transaction("write");
    const execute = vi.spyOn(transaction, "execute");

    try {
      await insertArtifactChangeInTransaction(transaction, prepared);
      await transaction.commit();
    } finally {
      transaction.close();
    }

    const boundedStatement = execute.mock.calls
      .map(([statement]) => statement)
      .find(
        (statement): statement is Extract<InStatement, { sql: string }> =>
          typeof statement !== "string" &&
          statement !== undefined &&
          statement.sql.includes("select max(revision) as revision") &&
          statement.sql.includes("from artifact_change_revisions"),
      );

    if (boundedStatement === undefined) {
      throw new Error("latest artifact revision statement was not executed");
    }

    await insertRawArtifactChangeRow({
      revision: 4,
      stream: "sonar.track",
      streamVersion: 1,
      subjectId: "track:live-only",
      subjectType: "track",
    });
    await insertRawArtifactRevisionReceipt({
      eventSeq: 7_001,
      revision: 7,
      stream: "sonar.track",
      streamVersion: 1,
      subjectId: "track:receipt-only",
      subjectType: "track",
    });
    await insertRawArtifactChangeRow({
      revision: 3,
      stream: "sonar.track",
      streamVersion: 1,
      subjectId: "track:split",
      subjectType: "track",
    });
    await insertRawArtifactRevisionReceipt({
      eventSeq: 8_001,
      revision: 8,
      stream: "sonar.track",
      streamVersion: 1,
      subjectId: "track:split",
      subjectType: "track",
    });
    await insertRawArtifactChangeRow({
      revision: 90,
      stream: "device.track",
      streamVersion: 1,
      subjectId: "track:isolated",
      subjectType: "track",
    });
    await insertRawArtifactRevisionReceipt({
      eventSeq: 91_001,
      revision: 91,
      stream: "sonar.track",
      streamVersion: 2,
      subjectId: "track:isolated",
      subjectType: "track",
    });

    const legacySql = `select max(revision) as revision
      from (
        select revision from artifact_change_revisions
        where stream = ? and stream_version = ? and subject_type = ? and subject_id = ?
        union all
        select revision from artifact_changes
        where stream = ? and stream_version = ? and subject_type = ? and subject_id = ?
      )`;

    for (const subjectId of [
      "track:empty",
      "track:live-only",
      "track:receipt-only",
      "track:split",
      "track:isolated",
    ]) {
      const args = ["sonar.track", 1, "track", subjectId, "sonar.track", 1, "track", subjectId];
      const bounded = await db.execute({ args, sql: boundedStatement.sql });
      const legacy = await db.execute({ args, sql: legacySql });

      expect(bounded.rows[0]?.revision ?? null).toBe(legacy.rows[0]?.revision ?? null);
    }
  });

  it("allocates across empty, live-only, split, and isolated revision histories", async () => {
    const empty = await insertArtifactChange(db, sonarChange(1, { subjectId: "track:empty" }));
    expect(empty).toMatchObject({ event: { revision: 1 }, inserted: true });

    await db.execute(
      buildArtifactChangeInsertStatement(sonarChange(4, { subjectId: "track:live-only" })),
    );
    const liveOnly = await insertArtifactChange(
      db,
      sonarChange(5, { subjectId: "track:live-only" }),
    );
    expect(liveOnly).toMatchObject({ event: { revision: 5 }, inserted: true });

    await insertArtifactChange(db, sonarChange(2, { subjectId: "track:split" }));
    await db.execute(
      buildArtifactChangeInsertStatement(sonarChange(7, { subjectId: "track:split" })),
    );
    const split = await insertArtifactChange(db, sonarChange(8, { subjectId: "track:split" }));
    expect(split).toMatchObject({ event: { revision: 8 }, inserted: true });

    await insertRawArtifactChangeRow({
      revision: 90,
      stream: "device.track",
      streamVersion: 99,
      subjectId: "track:isolated",
      subjectType: "track",
    });
    await insertRawArtifactRevisionReceipt({
      eventSeq: 9_001,
      revision: 91,
      stream: "sonar.track",
      streamVersion: 99,
      subjectId: "track:isolated",
      subjectType: "track",
    });
    await insertRawArtifactChangeRow({
      revision: 92,
      stream: "sonar.track",
      streamVersion: 1,
      subjectId: "track:other",
      subjectType: "track",
    });
    const isolated = await insertArtifactChange(
      db,
      sonarChange(1, { subjectId: "track:isolated" }),
    );
    expect(isolated).toMatchObject({ event: { revision: 1 }, inserted: true });
  });

  it("can append beside its source write and safely retries after transaction rollback", async () => {
    await seedTrack(db, { logId: "001.1.01", title: "Before", trackId: "track:a" });
    const prepared = await prepareArtifactChange(sonarChange(1));
    const abandoned = await db.transaction("write");

    try {
      await abandoned.execute({
        args: ["Abandoned", "track:a"],
        sql: "update tracks set title = ? where track_id = ?",
      });
      await insertArtifactChangeInTransaction(abandoned, prepared);
      await abandoned.rollback();
    } finally {
      abandoned.close();
    }

    expect(
      (await db.execute("select title from tracks where track_id = 'track:a'")).rows[0]?.title,
    ).toBe("Before");
    expect(
      (await db.execute("select count(*) as count from artifact_changes")).rows[0]?.count,
    ).toBe(0);

    const committed = await db.transaction("write");

    try {
      await committed.execute({
        args: ["Committed", "track:a"],
        sql: "update tracks set title = ? where track_id = ?",
      });
      const event = await insertArtifactChangeInTransaction(committed, prepared);
      expect(event.inserted).toBe(true);
      await committed.commit();
    } finally {
      committed.close();
    }

    expect(
      (await db.execute("select title from tracks where track_id = 'track:a'")).rows[0]?.title,
    ).toBe("Committed");
    expect((await insertArtifactChange(db, sonarChange(1))).inserted).toBe(false);
    expect(
      (await db.execute("select count(*) as count from artifact_changes")).rows[0]?.count,
    ).toBe(1);
  });

  it("represents visibility loss and deletion as immutable tombstones", async () => {
    await insertArtifactChange(db, sonarChange(1));
    const tombstone = await insertArtifactChange(
      db,
      sonarChange(2, { operation: "delete", payload: {}, payloadBlob: null }),
    );

    expect(tombstone.event).toMatchObject({
      operation: "delete",
      payloadBlobBase64: null,
      payloadJson: "{}",
      revision: 2,
    });
    await expect(
      insertArtifactChange(
        db,
        sonarChange(3, { operation: "delete", payload: {}, payloadBlob: vectorBytes(3) }),
      ),
    ).rejects.toThrow(/cannot carry a vector/);
  });

  it("validates complete device rows and canonical composite tombstone subjects", () => {
    const trackArtist = {
      artist_id: "artist:a",
      position: 1,
      role: null,
      track_id: "track:a",
    };
    const subjectId = canonicalArtifactJson(["track:a", "artist:a"]);
    const statement = buildArtifactChangeInsertStatement({
      ...artifactContract("device.track-artist"),
      operation: "upsert",
      payload: trackArtist,
      producer: "device-test",
      revision: 1,
      subjectId,
      subjectType: "track_artist",
    });

    expect(statement).toMatchObject({ args: expect.arrayContaining([subjectId]) });
    expect(() =>
      buildArtifactChangeInsertStatement({
        ...artifactContract("device.track-artist"),
        operation: "delete",
        payload: { artist_id: "artist:a", track_id: "track:a" },
        producer: "device-test",
        revision: 2,
        subjectId: "track:a",
        subjectType: "track_artist",
      }),
    ).toThrow(/does not match/);
  });
});

describe("artifact source snapshots and rebuild lifecycle", () => {
  it("matches the shared ECMAScript number and digest goldens", async () => {
    for (const fixture of CANONICAL_PAYLOAD_FIXTURES) {
      await seedCatalogueTrack(db, {
        durationMs: 123,
        trackId: fixture.subjectId,
      });
      await seedEmbedding(
        db,
        fixture.subjectId,
        Array.from({ length: 1024 }, () => 0),
      );
      await db.execute({
        args: [
          fixture.inputBpm === null ? null : Number(fixture.inputBpm),
          fixture.inputNearestFindingScore === undefined
            ? null
            : Number(fixture.inputNearestFindingScore),
          fixture.subjectId,
        ],
        sql: "update tracks set bpm = ?, nearest_finding_score = ? where track_id = ?",
      });
    }
    await registerArtifactConsumer(db, {
      consumerId: "canonical-number-reader",
      contracts: [artifactContract("sonar.track")],
    });

    const page = await listArtifactSnapshot(db, {
      consumerId: "canonical-number-reader",
      stream: "sonar.track",
      streamVersion: 1,
    });

    expect(page.items).toHaveLength(CANONICAL_PAYLOAD_FIXTURES.length);
    for (const fixture of CANONICAL_PAYLOAD_FIXTURES) {
      const item = page.items.find(({ subjectId }) => subjectId === fixture.subjectId);
      expect(item?.payloadJson, fixture.name).toBe(fixture.expectedPayloadJson);
      expect(item?.payloadDigest, fixture.name).toBe(fixture.expectedDigest);
    }
  });

  it("keeps snapshot wire assembly out of the rebuild-checkpoint transaction", async () => {
    await seedTrack(db, { logId: "001.A.AA", trackId: "track:checkpoint-work" });
    await seedEmbedding(
      db,
      "track:checkpoint-work",
      Array.from({ length: 1024 }, (_, index) => index / 1024),
    );
    await registerArtifactConsumer(db, {
      consumerId: "checkpoint-work-reader",
      contracts: [artifactContract("sonar.track")],
    });
    const page = await listArtifactSnapshot(db, {
      consumerId: "checkpoint-work-reader",
      stream: "sonar.track",
      streamVersion: 1,
    });
    const base64 = vi.spyOn(globalThis, "btoa");
    const parse = vi.spyOn(JSON, "parse");

    try {
      await checkpointArtifactRebuild(db, {
        consumerDigest: page.sourceDigest,
        consumerId: "checkpoint-work-reader",
        consumerItemCount: page.itemCount,
        generation: page.generation,
        pageDigest: page.pageDigest,
        pageLimit: ARTIFACT_SNAPSHOT_MAX_LIMIT,
        stream: "sonar.track",
        streamVersion: 1,
      });

      expect(base64.mock.calls.some(([value]) => value.length === ARTIFACT_VECTOR_BYTES)).toBe(
        false,
      );
      expect(
        parse.mock.calls.some(
          ([value]) => typeof value === "string" && value === page.items[0]?.payloadJson,
        ),
      ).toBe(false);
    } finally {
      base64.mockRestore();
      parse.mockRestore();
    }
  });

  it("snapshots the exact current Sonar projection behind a no-gap fence", async () => {
    await seedTrack(db, { logId: "001.A.AA", trackId: "track:a" });
    const vector = Array.from({ length: 1024 }, (_, index) => index / 1024);
    await seedEmbedding(db, "track:a", vector);
    await db.execute({
      args: [174.125, "Fmin", "track:a"],
      sql: "update tracks set bpm = ?, key = ? where track_id = ?",
    });
    const registration = await registerArtifactConsumer(db, {
      consumerId: "sonar-box",
      contracts: [artifactContract("sonar.track")],
    });
    const fence = registration.snapshotSeq;

    expect(fence).toBe(0);

    const sourceBlob = await db.execute({
      args: ["track:a"],
      sql: "select embedding_blob from track_embeddings where track_id = ?",
    });
    const blob = sourceBlob.rows[0]?.embedding_blob as ArrayBuffer | ArrayBufferView;
    await db.batch(
      [
        { args: [176, "track:a"], sql: "update tracks set bpm = ? where track_id = ?" },
        buildArtifactChangeInsertStatement(
          sonarChange(1, {
            payload: sonarPayload({ bpm: 176, key: "Fmin" }),
            payloadBlob: blob,
          }),
        ),
      ],
      "write",
    );

    const page = await listArtifactSnapshot(db, {
      consumerId: "sonar-box",
      stream: "sonar.track",
      streamVersion: 1,
    });

    expect(page).toMatchObject({ complete: true, snapshotSeq: 0 });
    expect(page.items).toHaveLength(1);
    expect(JSON.parse(page.items[0]?.payloadJson ?? "{}")).toMatchObject({
      bpm: 176,
      certified: true,
      hasFinding: true,
      key: "Fmin",
    });
    expect(page.items[0]?.payloadBlobBase64).toBe(artifactBytesToBase64(blob));

    await checkpointArtifactRebuild(db, {
      consumerDigest: page.sourceDigest,
      consumerId: "sonar-box",
      consumerItemCount: 1,
      generation: page.generation,
      pageDigest: page.pageDigest,
      pageLimit: ARTIFACT_SNAPSHOT_MAX_LIMIT,
      stream: "sonar.track",
      streamVersion: 1,
    });
    await activateArtifactConsumer(db, "sonar-box");
    const changes = await listArtifactChanges(db, { consumerId: "sonar-box" });

    expect(changes).toMatchObject({ fromSeq: 0, throughSeq: 1 });
    expect(changes.events[0]?.payloadBlobBase64).toBe(artifactBytesToBase64(blob));
  });

  it("pages deterministic device snapshots from the same registered allowlist", async () => {
    await seedTrack(db, { logId: "001.A.AA", trackId: "track:b" });
    await seedTrack(db, { logId: "001.A.AB", trackId: "track:a" });
    await registerArtifactConsumer(db, {
      consumerId: "device-builder",
      contracts: [artifactContract("device.track")],
    });
    const first = await listArtifactSnapshot(db, {
      consumerId: "device-builder",
      limit: 1,
      stream: "device.track",
      streamVersion: 1,
    });

    expect(first).toMatchObject({ complete: false, itemCount: 1 });
    expect(first.items[0]?.subjectId).toBe("track:a");
    expect(Object.keys(JSON.parse(first.items[0]?.payloadJson ?? "{}"))).toEqual(
      Object.keys(JSON.parse(first.items[0]?.payloadJson ?? "{}")).sort(),
    );

    await checkpointArtifactRebuild(db, {
      consumerDigest: first.sourceDigest,
      consumerId: "device-builder",
      consumerItemCount: 1,
      generation: first.generation,
      pageDigest: first.pageDigest,
      pageLimit: 1,
      stream: "device.track",
      streamVersion: 1,
    });
    const second = await listArtifactSnapshot(db, {
      consumerId: "device-builder",
      limit: 1,
      stream: "device.track",
      streamVersion: 1,
    });

    expect(second.items[0]?.subjectId).toBe("track:b");
    expect(second.complete).toBe(true);
  });

  it("rejects stale snapshot acknowledgements and activates only complete matching rebuilds", async () => {
    await seedTrack(db, { logId: "001.A.AA", trackId: "track:a" });
    const status = await registerArtifactConsumer(db, {
      consumerId: "crashy-builder",
      contracts: [artifactContract("device.track")],
    });
    const page = await listArtifactSnapshot(db, {
      consumerId: "crashy-builder",
      stream: "device.track",
      streamVersion: 1,
    });

    await expect(activateArtifactConsumer(db, "crashy-builder")).rejects.toThrow(/must finish/);
    await expect(
      checkpointArtifactRebuild(db, {
        consumerDigest: page.sourceDigest,
        consumerId: "crashy-builder",
        consumerItemCount: 1,
        generation: `${page.generation}:stale`,
        pageDigest: page.pageDigest,
        pageLimit: ARTIFACT_SNAPSHOT_MAX_LIMIT,
        stream: "device.track",
        streamVersion: 1,
      }),
    ).rejects.toThrow(/generation is stale/);
    await expect(
      checkpointArtifactRebuild(db, {
        consumerDigest: page.sourceDigest,
        consumerId: "crashy-builder",
        consumerItemCount: 1,
        generation: page.generation,
        pageDigest: "0".repeat(64),
        pageLimit: ARTIFACT_SNAPSHOT_MAX_LIMIT,
        stream: "device.track",
        streamVersion: 1,
      }),
    ).rejects.toThrow(/does not match exact source bytes/);

    await checkpointArtifactRebuild(db, {
      consumerDigest: page.sourceDigest,
      consumerId: "crashy-builder",
      consumerItemCount: 1,
      generation: page.generation,
      pageDigest: page.pageDigest,
      pageLimit: ARTIFACT_SNAPSHOT_MAX_LIMIT,
      stream: "device.track",
      streamVersion: 1,
    });
    const active = await activateArtifactConsumer(db, "crashy-builder");

    expect(active).toMatchObject({ appliedThroughSeq: status.snapshotSeq, state: "active" });
  });

  it("supports every registered contract and rejects unknown registrations and hard limits", async () => {
    const registration = await registerArtifactConsumer(db, {
      consumerId: "all-contracts",
      contracts: ARTIFACT_CONTRACTS,
    });

    expect(registration.contracts).toEqual(ARTIFACT_CONTRACTS);
    await expect(
      registerArtifactConsumer(db, {
        consumerId: "bad-contract",
        contracts: [{ formatVersion: 2, stream: "sonar.track", streamVersion: 1 }],
      }),
    ).rejects.toThrow(/Unsupported artifact contract/);
    await expect(
      listArtifactSnapshot(db, {
        consumerId: "all-contracts",
        limit: ARTIFACT_SNAPSHOT_MAX_LIMIT + 1,
        stream: "sonar.track",
        streamVersion: 1,
      }),
    ).rejects.toThrow(/between 1 and/);
  });
});

describe("artifact ordered reads and acknowledgements", () => {
  it("keeps change wire envelopes out of the acknowledgement transaction", async () => {
    await bootstrapConsumer("raw-ack-reader");
    await insertArtifactChange(db, sonarChange(1));
    const page = await listArtifactChanges(db, { consumerId: "raw-ack-reader" });
    const base64 = vi.spyOn(globalThis, "btoa");
    const parse = vi.spyOn(JSON, "parse");

    try {
      await acknowledgeArtifactChanges(db, {
        batchDigest: page.batchDigest,
        consumerId: "raw-ack-reader",
        eventCount: page.events.length,
        fromSeq: page.fromSeq,
        throughSeq: page.throughSeq,
      });

      expect(base64).not.toHaveBeenCalled();
      expect(
        parse.mock.calls.some(
          ([value]) => typeof value === "string" && value === page.events[0]?.payloadJson,
        ),
      ).toBe(false);
    } finally {
      base64.mockRestore();
      parse.mockRestore();
    }
  });

  it("reads only the next bounded primary-key range with no temp sort", async () => {
    await bootstrapConsumer("bounded-reader");

    for (let revision = 1; revision <= 4; revision += 1) {
      await insertArtifactChange(db, sonarChange(revision));
    }

    const page = await listArtifactChanges(db, { consumerId: "bounded-reader", limit: 2 });

    expect(page.events.map(({ seq }) => seq)).toEqual([1, 2]);
    expect(page).toMatchObject({ fromSeq: 0, hasMore: true, throughSeq: 2 });
    await expect(
      listArtifactChanges(db, {
        consumerId: "bounded-reader",
        limit: ARTIFACT_CHANGE_MAX_READ_LIMIT + 1,
      }),
    ).rejects.toThrow(/between 1 and/);

    const plan = await db.execute(
      `explain query plan select seq from artifact_changes where seq > 0 order by seq limit 10`,
    );
    const details = plan.rows
      .map((row) =>
        typeof row.detail === "string" ? row.detail : JSON.stringify(row.detail ?? null),
      )
      .join("\n");

    expect(details).toMatch(/SEARCH artifact_changes USING INTEGER PRIMARY KEY/);
    expect(details).not.toMatch(/TEMP B-TREE/i);
  });

  it("rejects regression, ahead, skipped, unknown-version, and incompatible-version acks", async () => {
    await bootstrapConsumer("strict-reader");
    await insertArtifactChange(db, sonarChange(1));
    await insertArtifactChange(db, sonarChange(2));
    const page = await listArtifactChanges(db, { consumerId: "strict-reader", limit: 2 });

    await expect(
      acknowledgeArtifactChanges(db, {
        batchDigest: page.batchDigest,
        consumerId: "strict-reader",
        eventCount: 1,
        fromSeq: 1,
        throughSeq: 2,
      }),
    ).rejects.toThrow(/durable checkpoint is 0/);
    await expect(
      acknowledgeArtifactChanges(db, {
        batchDigest: page.batchDigest,
        consumerId: "strict-reader",
        eventCount: 1,
        fromSeq: 0,
        throughSeq: 2,
      }),
    ).rejects.toThrow(/exact next observed/);
    await expect(
      acknowledgeArtifactChanges(db, {
        batchDigest: page.batchDigest,
        consumerId: "strict-reader",
        eventCount: 2,
        fromSeq: 0,
        throughSeq: page.headSeq + 1,
      }),
    ).rejects.toThrow(/exact next observed/);

    await db.execute({
      args: ["2026-03-01T00:00:00Z", "{}", "test", 1, "future.stream", 99, "future:a", "future"],
      sql: `insert into artifact_changes
        (created_at, format_version, operation, payload_json, producer, revision,
         stream, stream_version, subject_id, subject_type)
        values (?, 99, 'upsert', ?, ?, ?, ?, ?, ?, ?)`,
    });
    const unknownPage = await listArtifactChanges(db, { consumerId: "strict-reader", limit: 3 });

    expect(unknownPage.events.at(-1)?.formatRegistered).toBe(false);
    await expect(
      acknowledgeArtifactChanges(db, {
        batchDigest: unknownPage.batchDigest,
        consumerId: "strict-reader",
        eventCount: unknownPage.events.length,
        fromSeq: unknownPage.fromSeq,
        throughSeq: unknownPage.throughSeq,
      }),
    ).rejects.toThrow(/Cannot acknowledge unregistered contract/);

    await db.execute({
      args: ["strict-reader"],
      sql: `update artifact_change_consumer_contracts
        set format_version = 2 where consumer_id = ? and stream = 'sonar.track'`,
    });
    const incompatiblePage = await listArtifactChanges(db, {
      consumerId: "strict-reader",
      limit: 1,
    });
    await expect(
      acknowledgeArtifactChanges(db, {
        batchDigest: incompatiblePage.batchDigest,
        consumerId: "strict-reader",
        eventCount: 1,
        fromSeq: incompatiblePage.fromSeq,
        throughSeq: incompatiblePage.throughSeq,
      }),
    ).rejects.toThrow(/Consumer cannot acknowledge/);
  });

  it("re-delivers an unacked page after process death and rejects a duplicate ack", async () => {
    await bootstrapConsumer("restart-reader");
    await insertArtifactChange(db, sonarChange(1));
    await insertArtifactChange(db, sonarChange(2));
    const beforeCrash = await listArtifactChanges(db, { consumerId: "restart-reader" });
    const afterRestart = await listArtifactChanges(db, { consumerId: "restart-reader" });

    expect(afterRestart).toEqual(beforeCrash);
    await acknowledgeArtifactChanges(db, {
      batchDigest: beforeCrash.batchDigest,
      consumerId: "restart-reader",
      eventCount: beforeCrash.events.length,
      fromSeq: beforeCrash.fromSeq,
      throughSeq: beforeCrash.throughSeq,
    });
    await expect(
      acknowledgeArtifactChanges(db, {
        batchDigest: beforeCrash.batchDigest,
        consumerId: "restart-reader",
        eventCount: beforeCrash.events.length,
        fromSeq: beforeCrash.fromSeq,
        throughSeq: beforeCrash.throughSeq,
      }),
    ).rejects.toThrow(/durable checkpoint is 2/);
  });

  it("inactivation removes every barrier and re-registration always fences a new rebuild", async () => {
    await bootstrapConsumer("lifecycle-reader");
    await insertArtifactChange(db, sonarChange(1));
    await ackPage("lifecycle-reader");
    const inactive = await inactivateArtifactConsumer(db, "lifecycle-reader");

    expect(inactive).toMatchObject({
      appliedThroughSeq: null,
      checkpointedAt: null,
      rebuilds: [],
      snapshotSeq: null,
      state: "inactive",
    });
    await expect(listArtifactChanges(db, { consumerId: "lifecycle-reader" })).rejects.toThrow(
      /must be active/,
    );

    const rebuilt = await registerArtifactConsumer(db, {
      consumerId: "lifecycle-reader",
      contracts: [artifactContract("sonar.track")],
    });

    expect(rebuilt).toMatchObject({ appliedThroughSeq: null, snapshotSeq: 1, state: "rebuilding" });
  });
});

describe("artifact consumer retention candidates", () => {
  it("lists only inactive identities older than the fence through a bounded keyset page", async () => {
    const contract = [artifactContract("sonar.track")];

    await registerArtifactConsumer(
      db,
      { consumerId: "active-a", contracts: contract },
      { now: "2026-01-01T00:00:00.000Z" },
    );
    await registerArtifactConsumer(
      db,
      { consumerId: "inactive-old", contracts: contract },
      { now: "2026-01-01T00:00:00.000Z" },
    );
    await inactivateArtifactConsumer(db, "inactive-old", {
      now: "2026-02-01T00:00:00.000Z",
    });
    await registerArtifactConsumer(
      db,
      { consumerId: "inactive-recent", contracts: contract },
      { now: "2026-03-01T00:00:00.000Z" },
    );
    await inactivateArtifactConsumer(db, "inactive-recent", {
      now: "2026-04-01T00:00:00.000Z",
    });

    const first = await listArtifactConsumerPurgeCandidates(db, {
      inactiveBefore: "2026-03-01T00:00:00.000Z",
      limit: 2,
    });
    const second = await listArtifactConsumerPurgeCandidates(db, {
      cursor: first.nextCursor ?? undefined,
      inactiveBefore: "2026-03-01T00:00:00.000Z",
      limit: 2,
    });

    expect(first).toEqual({
      candidates: [
        {
          checkpointCount: 0,
          consumerId: "inactive-old",
          contractCount: 1,
          registeredAt: "2026-01-01T00:00:00.000Z",
          stateChangedAt: "2026-02-01T00:00:00.000Z",
          updatedAt: "2026-02-01T00:00:00.000Z",
        },
      ],
      hasMore: true,
      nextCursor: "inactive-old",
      scannedCount: 2,
    });
    expect(second).toEqual({
      candidates: [],
      hasMore: false,
      nextCursor: "inactive-recent",
      scannedCount: 1,
    });
  });

  it("pins the candidate window and child counts to primary-key searches", async () => {
    const statement = buildArtifactConsumerPurgeCandidateStatement({ limit: 10 });
    const plan = await db.execute({
      args: statement.args,
      sql: `explain query plan ${statement.sql}`,
    });
    const details = plan.rows
      .map((row) =>
        typeof row.detail === "string" ? row.detail : (JSON.stringify(row.detail ?? null) ?? ""),
      )
      .join("\n");

    expect(details).toMatch(
      /SEARCH c USING INDEX sqlite_autoindex_artifact_change_consumers_1 \(consumer_id>\?\)/i,
    );
    expect(details).toMatch(
      /SEARCH checkpoint USING COVERING INDEX sqlite_autoindex_artifact_change_checkpoints_1 \(consumer_id=\?\)/i,
    );
    expect(details).toMatch(
      /SEARCH contract USING COVERING INDEX sqlite_autoindex_artifact_change_consumer_contracts_1 \(consumer_id=\?\)/i,
    );
    expect(details).not.toMatch(/USE TEMP B-TREE/i);
    expect(details).not.toMatch(/\bSCAN artifact_change_/i);
  });
});

describe("artifact compaction", () => {
  it("compacts nothing without a safe active or rebuilding barrier", async () => {
    await insertArtifactChange(db, sonarChange(1));
    expect(await compactArtifactChanges(db)).toEqual({
      barrier: null,
      deletedCount: 0,
      deletedFromSeq: null,
      deletedThroughSeq: null,
      reason: "no_safe_barrier",
    });

    await registerArtifactConsumer(db, {
      consumerId: "inactive-only",
      contracts: [artifactContract("sonar.track")],
    });
    await inactivateArtifactConsumer(db, "inactive-only");
    expect((await compactArtifactChanges(db)).reason).toBe("no_safe_barrier");
  });

  it("continues from a durable revision receipt after every body is compacted", async () => {
    await bootstrapConsumer("receipt-reader");
    await insertArtifactChange(db, sonarChange(1, { subjectId: "track:compacted" }));
    await insertArtifactChange(db, sonarChange(2, { subjectId: "track:compacted" }));
    await ackPage("receipt-reader");

    expect(await compactArtifactChanges(db)).toMatchObject({
      barrier: 2,
      deletedCount: 2,
      reason: "compacted",
    });
    expect(
      (
        await db.execute({
          args: ["track:compacted"],
          sql: "select count(*) as count from artifact_changes where subject_id = ?",
        })
      ).rows[0]?.count,
    ).toBe(0);
    expect(
      (
        await db.execute({
          args: ["track:compacted"],
          sql: "select count(*) as count from artifact_change_revisions where subject_id = ?",
        })
      ).rows[0]?.count,
    ).toBe(2);

    const next = await insertArtifactChange(db, sonarChange(3, { subjectId: "track:compacted" }));
    expect(next).toMatchObject({ event: { revision: 3 }, inserted: true });
  });

  it("never deletes past the slowest active consumer and preserves later tombstones", async () => {
    await bootstrapConsumer("fast-reader");
    await bootstrapConsumer("slow-reader");

    for (let revision = 1; revision <= 4; revision += 1) {
      await insertArtifactChange(db, sonarChange(revision));
    }
    await insertArtifactChange(
      db,
      sonarChange(5, { operation: "delete", payload: {}, payloadBlob: null }),
    );

    await ackPage("fast-reader");
    await ackPage("slow-reader", 2);
    const compacted = await compactArtifactChanges(db, { limit: 100 });

    expect(compacted).toEqual({
      barrier: 2,
      deletedCount: 2,
      deletedFromSeq: 1,
      deletedThroughSeq: 2,
      reason: "compacted",
    });
    const remaining = await db.execute("select seq, operation from artifact_changes order by seq");

    expect(remaining.rows).toEqual([
      { operation: "upsert", seq: 3 },
      { operation: "upsert", seq: 4 },
      { operation: "delete", seq: 5 },
    ]);
    const compactedRetry = await insertArtifactChange(db, sonarChange(1));

    expect(compactedRetry).toMatchObject({ event: { seq: 1 }, inserted: false });
    expect(
      (await db.execute("select count(*) as count from artifact_changes")).rows[0]?.count,
    ).toBe(3);
    await expect(
      insertArtifactChange(db, sonarChange(1, { payload: sonarPayload({ bpm: 170 }) })),
    ).rejects.toThrow(/different immutable content/);
  });

  it("holds the prefix when a rebuilding consumer's fence is the slowest requirement", async () => {
    await bootstrapConsumer("active-reader");
    await registerArtifactConsumer(db, {
      consumerId: "rebuilding-reader",
      contracts: [artifactContract("sonar.track")],
    });
    await insertArtifactChange(db, sonarChange(1));
    await insertArtifactChange(db, sonarChange(2));
    await ackPage("active-reader");
    const compacted = await compactArtifactChanges(db);

    expect(compacted).toMatchObject({ barrier: 0, deletedCount: 0, reason: "empty" });
    expect(
      (await db.execute("select count(*) as count from artifact_changes")).rows[0]?.count,
    ).toBe(2);
  });

  it("uses the minimum across mixed active/rebuilding consumers in one bounded pass", async () => {
    await bootstrapConsumer("active-a");
    await bootstrapConsumer("active-b");

    for (let revision = 1; revision <= 6; revision += 1) {
      await insertArtifactChange(db, sonarChange(revision));
    }

    await ackPage("active-a");
    await ackPage("active-b", 4);
    await registerArtifactConsumer(db, {
      consumerId: "rebuilding-at-six",
      contracts: [artifactContract("sonar.track")],
    });
    await bootstrapConsumer("inactive-later");
    await inactivateArtifactConsumer(db, "inactive-later");
    const first = await compactArtifactChanges(db, { limit: 2 });
    const second = await compactArtifactChanges(db, { limit: 10 });

    expect(first).toMatchObject({ barrier: 4, deletedCount: 2, deletedThroughSeq: 2 });
    expect(second).toMatchObject({ barrier: 4, deletedCount: 2, deletedThroughSeq: 4 });
    const status = await getArtifactConsumerStatus(db, "active-b");

    expect(status).toMatchObject({ compactionBarrier: 4, earliestSeq: 5, headSeq: 6 });
  });

  it("caps compaction and snapshot builders before a query is built", async () => {
    await expect(compactArtifactChanges(db, { limit: 1_001 })).rejects.toThrow(
      /between 1 and 1000/,
    );
    expect(() =>
      buildArtifactSnapshotStatement("sonar.track", null, ARTIFACT_SNAPSHOT_MAX_LIMIT + 1),
    ).toThrow(/between 1 and 200/);
  });
});
