import {
  type Client,
  type InStatement,
  type Transaction,
  type TransactionMode,
} from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  acknowledgeArtifactChanges,
  activateArtifactConsumer,
  ARTIFACT_CHANGE_MAX_READ_LIMIT,
  ARTIFACT_SNAPSHOT_MAX_LIMIT,
  ARTIFACT_VECTOR_BYTES,
  artifactContract,
  buildArtifactChangeInsertStatement,
  checkpointArtifactRebuild,
  getArtifactConsumerStatus,
  listArtifactChanges,
  listArtifactSnapshot,
  registerArtifactConsumer,
  type ArtifactChangeInput,
} from "./artifact-changes";
import { createIntegrationDb, seedEmbedding, seedTrack } from "./integration-db";

/**
 * Everything one write transaction did between `client.transaction()` and its commit: the
 * statements it executed and the CPU work observed through the global primitives the wire
 * encoders use. Base64 is the vector encoder, `JSON.parse` is payload decoding, and each
 * `crypto.subtle.digest` call is one SHA-256 over stored bytes.
 */
type TransactionWork = {
  base64Inputs: string[];
  digestCalls: number;
  durationMs: number;
  jsonParseInputs: string[];
  statements: number;
};

type InstrumentedClient = Pick<Client, "batch" | "execute" | "transaction"> & {
  work: TransactionWork[];
};

/** Runs inside the open transaction before each statement it is about to execute. */
type StatementIntercept = (statement: InStatement, transaction: Transaction) => Promise<void>;

function statementSql(statement: InStatement): string {
  return typeof statement === "string" ? statement : statement.sql;
}

/**
 * Wrap a client so every transaction it opens is observed for its full open window only. The
 * spies install when the transaction opens and restore when it commits or rolls back, so work
 * before the transaction (input validation) and after it (response assembly) is never counted.
 * An intercept can run its own statements through the open transaction before a given statement,
 * which is how a test drives the row-guard branches a serialized write lock never reaches.
 */
function instrumentTransactions(
  client: Client,
  intercept?: StatementIntercept,
): InstrumentedClient {
  const work: TransactionWork[] = [];

  return {
    batch: (statements, mode) => client.batch(statements, mode),
    execute: (statement: InStatement) => client.execute(statement),
    transaction: async (mode?: TransactionMode): Promise<Transaction> => {
      const startedAt = performance.now();
      const inner = await client.transaction(mode);
      const record: TransactionWork = {
        base64Inputs: [],
        digestCalls: 0,
        durationMs: 0,
        jsonParseInputs: [],
        statements: 0,
      };
      const base64 = vi.spyOn(globalThis, "btoa");
      const digest = vi.spyOn(crypto.subtle, "digest");
      const parse = vi.spyOn(JSON, "parse");
      let finalized = false;
      const finalize = (): void => {
        if (finalized) {
          return;
        }

        finalized = true;
        record.durationMs = performance.now() - startedAt;
        record.base64Inputs = base64.mock.calls.map(([value]) => value);
        record.digestCalls = digest.mock.calls.length;
        record.jsonParseInputs = parse.mock.calls.map(([value]) => String(value));
        base64.mockRestore();
        digest.mockRestore();
        parse.mockRestore();
        work.push(record);
      };

      return {
        batch: (statements) => {
          record.statements += statements.length;

          return inner.batch(statements);
        },
        close: () => {
          finalize();
          inner.close();
        },
        get closed() {
          return inner.closed;
        },
        commit: async () => {
          await inner.commit();
          finalize();
        },
        execute: async (statement: InStatement) => {
          await intercept?.(statement, inner);
          record.statements += 1;

          return inner.execute(statement);
        },
        executeMultiple: (sql) => {
          record.statements += 1;

          return inner.executeMultiple(sql);
        },
        rollback: async () => {
          await inner.rollback();
          finalize();
        },
      };
    },
    work,
  };
}

let db: Client;
let fixtureDirectory: string | undefined;

beforeEach(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "fluncle-artifact-transaction-work-"));
  db = await createIntegrationDb({ url: `file:${join(fixtureDirectory, "fixture.db")}` });
});

afterEach(async () => {
  db.close();

  if (fixtureDirectory !== undefined) {
    await rm(fixtureDirectory, { force: true, recursive: true });
    fixtureDirectory = undefined;
  }
});

function vectorBytes(seed: number): Uint8Array {
  const bytes = new Uint8Array(ARTIFACT_VECTOR_BYTES);
  const view = new DataView(bytes.buffer);

  for (let index = 0; index < 1024; index += 1) {
    view.setFloat32(index * Float32Array.BYTES_PER_ELEMENT, seed + index / 1024, true);
  }

  return bytes;
}

function sonarChange(revision: number): ArtifactChangeInput {
  return {
    ...artifactContract("sonar.track"),
    createdAt: "2026-01-01T00:00:00.000Z",
    operation: "upsert",
    payload: {
      anchored: true,
      bpm: 174.25,
      certified: true,
      dismissed: false,
      durationMs: 245_000,
      hasFinding: true,
      isDuplicate: false,
      key: "Amin",
      nearestFindingScore: 0.8125,
    },
    payloadBlob: vectorBytes(revision),
    producer: "artifact-test",
    revision,
    subjectId: "track:a",
    subjectType: "track",
  };
}

/** A full maximum-size change page: every event carries one exact vector. */
async function seedChangePage(count: number): Promise<void> {
  await db.batch(
    Array.from({ length: count }, (_, index) =>
      buildArtifactChangeInsertStatement(sonarChange(index + 1)),
    ),
    "write",
  );
}

/** A full maximum-size sonar.track snapshot page: every track carries one exact vector. */
async function seedSnapshotPage(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const trackId = `track:snapshot-${String(index).padStart(4, "0")}`;
    await seedTrack(db, { logId: `${String(index + 1).padStart(3, "0")}.A.AA`, trackId });
    await seedEmbedding(
      db,
      trackId,
      Array.from({ length: 1024 }, (_, position) => index + position / 1024),
    );
  }
}

async function bootstrapActiveConsumer(consumerId: string): Promise<void> {
  await registerArtifactConsumer(db, {
    consumerId,
    contracts: [artifactContract("sonar.track")],
  });
  const page = await listArtifactSnapshot(db, {
    consumerId,
    stream: "sonar.track",
    streamVersion: 1,
  });
  await checkpointArtifactRebuild(db, {
    consumerDigest: page.sourceDigest,
    consumerId,
    consumerItemCount: page.itemCount,
    generation: page.generation,
    pageDigest: page.pageDigest,
    pageLimit: ARTIFACT_SNAPSHOT_MAX_LIMIT,
    stream: "sonar.track",
    streamVersion: 1,
  });
  await activateArtifactConsumer(db, consumerId);
}

describe("artifact write transactions carry digest work only", () => {
  it("acknowledges a full change page with per-row digests and no wire encoding", async () => {
    await bootstrapActiveConsumer("raw-ack-reader");
    await seedChangePage(ARTIFACT_CHANGE_MAX_READ_LIMIT);
    const page = await listArtifactChanges(db, {
      consumerId: "raw-ack-reader",
      limit: ARTIFACT_CHANGE_MAX_READ_LIMIT,
    });
    expect(page.events).toHaveLength(ARTIFACT_CHANGE_MAX_READ_LIMIT);
    const payloadJsons = new Set(page.events.map((event) => event.payloadJson));
    const client = instrumentTransactions(db);

    const status = await acknowledgeArtifactChanges(client, {
      batchDigest: page.batchDigest,
      consumerId: "raw-ack-reader",
      eventCount: page.events.length,
      fromSeq: page.fromSeq,
      throughSeq: page.throughSeq,
    });

    expect(client.work).toHaveLength(1);
    const [work] = client.work;
    // The durable consumer row, its declared contracts, the exact next page, and the checkpoint
    // advance. The response-only head read stays outside the transaction.
    expect(work?.statements).toBe(4);
    expect(work?.base64Inputs).toEqual([]);
    expect(work?.jsonParseInputs).toEqual([]);
    expect(work?.jsonParseInputs.some((input) => payloadJsons.has(input))).toBe(false);
    // One SHA-256 per stored row plus the ordered batch digest, nothing else.
    expect(work?.digestCalls).toBe(page.events.length + 1);
    // The receipt is the same durable status any later read observes.
    expect(status.appliedThroughSeq).toBe(page.throughSeq);
    expect(status).toEqual(await getArtifactConsumerStatus(db, "raw-ack-reader"));
  });

  it("rejects an acknowledgement whose durable checkpoint moved after the transaction read it", async () => {
    await bootstrapActiveConsumer("raced-ack-reader");
    await seedChangePage(2);
    const page = await listArtifactChanges(db, { consumerId: "raced-ack-reader", limit: 1 });
    expect(page.events).toHaveLength(1);
    const before = await getArtifactConsumerStatus(db, "raced-ack-reader");
    let raced = false;
    // The write lock serializes real acknowledgements, so a competing commit can never land
    // between this transaction's durable read and its guarded advance. The guard still exists
    // for any client whose read and write are not one connection; drive its zero-row branch by
    // moving the row through the open transaction right before the advance runs.
    const client = instrumentTransactions(db, async (statement, transaction) => {
      if (raced || !statementSql(statement).includes("set applied_through_seq = ?")) {
        return;
      }

      raced = true;
      await transaction.execute({
        args: [page.throughSeq + 1, "raced-ack-reader"],
        sql: `update artifact_change_consumers set applied_through_seq = ? where consumer_id = ?`,
      });
    });
    const input = {
      batchDigest: page.batchDigest,
      consumerId: "raced-ack-reader",
      eventCount: page.events.length,
      fromSeq: page.fromSeq,
      throughSeq: page.throughSeq,
    };

    await expect(acknowledgeArtifactChanges(client, input)).rejects.toThrow(
      /raced another acknowledgement/,
    );

    expect(raced).toBe(true);
    expect(client.work).toHaveLength(1);
    // The rejected transaction rolled back everything, the injected move included, so the
    // durable checkpoint is exactly what the consumer read before and the same input replays.
    expect(await getArtifactConsumerStatus(db, "raced-ack-reader")).toEqual(before);
    const replayed = await acknowledgeArtifactChanges(db, input);
    expect(replayed.appliedThroughSeq).toBe(page.throughSeq);
  });

  it("checkpoints a full snapshot page by hashing stored bytes and assembling no response", async () => {
    await seedSnapshotPage(ARTIFACT_SNAPSHOT_MAX_LIMIT);
    await registerArtifactConsumer(db, {
      consumerId: "raw-checkpoint-reader",
      contracts: [artifactContract("sonar.track")],
    });
    const page = await listArtifactSnapshot(db, {
      consumerId: "raw-checkpoint-reader",
      limit: ARTIFACT_SNAPSHOT_MAX_LIMIT,
      stream: "sonar.track",
      streamVersion: 1,
    });
    expect(page.itemCount).toBe(ARTIFACT_SNAPSHOT_MAX_LIMIT);
    const payloadJsons = new Set(page.items.map((item) => item.payloadJson));
    const client = instrumentTransactions(db);

    const checkpoint = await checkpointArtifactRebuild(client, {
      consumerDigest: page.sourceDigest,
      consumerId: "raw-checkpoint-reader",
      consumerItemCount: page.itemCount,
      generation: page.generation,
      pageDigest: page.pageDigest,
      pageLimit: ARTIFACT_SNAPSHOT_MAX_LIMIT,
      stream: "sonar.track",
      streamVersion: 1,
    });

    expect(client.work).toHaveLength(1);
    const [work] = client.work;
    // The consumer row, the rebuild checkpoint, the exact source page, and the cursor advance.
    expect(work?.statements).toBe(4);
    // No vector is base64-encoded. The one permitted encode is the durable keyset cursor of the
    // page tail, which the checkpoint row stores: the canonical JSON of the last item's key.
    expect(work?.base64Inputs.some((input) => input.length >= ARTIFACT_VECTOR_BYTES)).toBe(false);
    expect(work?.base64Inputs).toEqual([JSON.stringify([page.items.at(-1)?.subjectId])]);
    expect(work?.jsonParseInputs.some((input) => payloadJsons.has(input))).toBe(false);
    // This is the first page, so there is no stored cursor to decode. A later page legitimately
    // parses its stored cursor (the same few bytes of key JSON) once to build the keyset read;
    // only payload JSON must never be decoded here, which the assertion above pins.
    expect(work?.jsonParseInputs).toEqual([]);
    // One SHA-256 per source row plus the page digest and the running source digest.
    expect(work?.digestCalls).toBe(page.itemCount + 2);
    // The receipt is the same durable checkpoint any later read observes.
    expect(checkpoint.cursor).toBe(page.cursor);
    expect(checkpoint.sourceDigest).toBe(page.sourceDigest);
    expect(checkpoint.state).toBe(page.complete ? "complete" : "running");
    expect(checkpoint).toEqual(
      (await getArtifactConsumerStatus(db, "raw-checkpoint-reader")).rebuilds.find(
        (candidate) => candidate.stream === "sonar.track",
      ),
    );
  });
});
