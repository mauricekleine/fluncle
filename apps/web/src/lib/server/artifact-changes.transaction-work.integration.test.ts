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

type StatementIntercept = (statement: InStatement, transaction: Transaction) => Promise<void>;

function statementSql(statement: InStatement): string {
  return typeof statement === "string" ? statement : statement.sql;
}

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

async function seedChangePage(count: number): Promise<void> {
  await db.batch(
    Array.from({ length: count }, (_, index) =>
      buildArtifactChangeInsertStatement(sonarChange(index + 1)),
    ),
    "write",
  );
}

async function seedSnapshotPage(count: number): Promise<void> {
  const transaction = await db.transaction("write");
  try {
    for (let index = 0; index < count; index += 1) {
      const trackId = `track:snapshot-${String(index).padStart(4, "0")}`;
      await seedTrack(transaction, {
        logId: `${String(index + 1).padStart(3, "0")}.A.AA`,
        trackId,
      });
      await seedEmbedding(
        transaction,
        trackId,
        Array.from({ length: 1024 }, (_, position) => index + position / 1024),
      );
    }
    await transaction.commit();
  } finally {
    transaction.close();
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

    expect(work?.statements).toBe(4);
    expect(work?.base64Inputs).toEqual([]);
    expect(work?.jsonParseInputs).toEqual([]);
    expect(work?.jsonParseInputs.some((input) => payloadJsons.has(input))).toBe(false);

    expect(work?.digestCalls).toBe(page.events.length + 1);

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

    await expect(acknowledgeArtifactChanges(client, input)).rejects.toMatchObject({
      code: "artifact_checkpoint_race",
      message: "Artifact checkpoint raced another acknowledgement",
      status: 409,
    });

    expect(raced).toBe(true);
    expect(client.work).toHaveLength(1);

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

    expect(work?.statements).toBe(4);

    expect(work?.base64Inputs.some((input) => input.length >= ARTIFACT_VECTOR_BYTES)).toBe(false);
    expect(work?.base64Inputs).toEqual([JSON.stringify([page.items.at(-1)?.subjectId])]);
    expect(work?.jsonParseInputs.some((input) => payloadJsons.has(input))).toBe(false);

    expect(work?.jsonParseInputs).toEqual([]);

    expect(work?.digestCalls).toBe(page.itemCount + 2);

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
