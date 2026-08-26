import { createClient, type Client, type Transaction } from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createIntegrationDb } from "./integration-db";
import {
  canonicalOperationJson,
  digestOperationRequest,
  executeReceiptBackedOperation,
  inspectOperationReceipt,
  type JsonValue,
  type OperationReceiptClient,
  reconcileOperationReceipt,
  repairStaleOperationReceipts,
} from "./operation-receipts";

describe("operation receipts", () => {
  it("canonicalizes finite JSON before hashing or persistence", async () => {
    const first = Object.fromEntries([
      ["z", 1],
      [
        "a",
        Object.fromEntries([
          ["b", 2],
          ["a", 3],
        ]),
      ],
      [
        "list",
        [
          3,
          Object.fromEntries([
            ["y", 2],
            ["x", 1],
          ]),
        ],
      ],
      ["zero", -0],
    ]) as JsonValue;
    const second = { a: { a: 3, b: 2 }, list: [3, { x: 1, y: 2 }], z: 1, zero: 0 };

    expect(canonicalOperationJson(first)).toBe(
      '{"a":{"a":3,"b":2},"list":[3,{"x":1,"y":2}],"z":1,"zero":0}',
    );
    await expect(digestOperationRequest(first)).resolves.toBe(await digestOperationRequest(second));
    expect(() => canonicalOperationJson({ value: Number.POSITIVE_INFINITY })).toThrow(/finite/);
    expect(() => canonicalOperationJson({ value: undefined } as unknown as JsonValue)).toThrow(
      /finite JSON/,
    );
  });

  it("replays the exact stored terminal result for the same key and digest", async () => {
    await withFileDb(async (client) => {
      const digest = await digestOperationRequest({ action: "publish", trackId: "track-1" });
      let effects = 0;
      const run = () =>
        executeReceiptBackedOperation({
          client,
          effect: async () => {
            effects += 1;
            return {
              result: { a: [2, 1], z: true },
              resultIdentity: "finding:track-1",
              state: "committed",
            };
          },
          operationId: "publish-track",
          operationKey: "publish:track-1",
          requestDigest: digest,
        });

      const first = await run();
      const replay = await run();

      expect(first).toMatchObject({ outcome: "committed", replayed: false });
      expect(replay).toEqual({
        outcome: "committed",
        replayed: true,
        result: { a: [2, 1], z: true },
        resultIdentity: "finding:track-1",
        resultJson: '{"a":[2,1],"z":true}',
        state: "committed",
      });
      expect(effects).toBe(1);
    });
  });

  it("reports a conflict when the same key carries another request digest", async () => {
    await withFileDb(async (client) => {
      const firstDigest = await digestOperationRequest({ value: 1 });
      const secondDigest = await digestOperationRequest({ value: 2 });
      let secondEffectRan = false;

      await executeReceiptBackedOperation({
        client,
        effect: () => committed("result:first", { value: 1 }),
        operationId: "test-operation",
        operationKey: "stable-key",
        requestDigest: firstDigest,
      });
      const conflict = await executeReceiptBackedOperation({
        client,
        effect: () => {
          secondEffectRan = true;
          return committed("result:second", { value: 2 });
        },
        operationId: "test-operation",
        operationKey: "stable-key",
        requestDigest: secondDigest,
      });

      expect(conflict).toEqual({ outcome: "conflict", replayed: false });
      expect(secondEffectRan).toBe(false);
    });
  });

  it("rejects a same-key replay from a different operation", async () => {
    await withFileDb(async (client) => {
      const digest = await digestOperationRequest({ value: 1 });
      await executeReceiptBackedOperation({
        client,
        effect: () => committed("result:first", { value: 1 }),
        operationId: "first-operation",
        operationKey: "globally-owned-key",
        requestDigest: digest,
      });

      await expect(
        executeReceiptBackedOperation({
          client,
          effect: () => committed("result:second", { value: 1 }),
          operationId: "second-operation",
          operationKey: "globally-owned-key",
          requestDigest: digest,
        }),
      ).resolves.toEqual({ outcome: "conflict", replayed: false });
    });
  });

  it("is safely retryable when transport fails before the primary transaction", async () => {
    await withFileDb(async (client) => {
      const digest = await digestOperationRequest({ value: 1 });
      const unavailable = overrideClient(client, {
        transaction: async () => {
          throw new Error("timeout before primary");
        },
      });

      const outcome = await executeReceiptBackedOperation({
        client: unavailable,
        effect: () => committed("never", null),
        operationId: "test-operation",
        operationKey: "before-primary",
        requestDigest: digest,
      });

      expect(outcome).toEqual({ outcome: "safely-retryable", replayed: false });
      expect(await receiptCount(client, "before-primary")).toBe(0);
    });
  });

  it("recovers the committed result when commit succeeds before response loss", async () => {
    await withFileDb(async (client) => {
      const digest = await digestOperationRequest({ value: 1 });
      const responseLosingClient = overrideClient(client, {
        transaction: async (mode?: "write" | "read" | "deferred") => {
          const transaction = await client.transaction(mode);
          return commitThenLoseResponse(transaction);
        },
      });
      let effects = 0;

      const outcome = await executeReceiptBackedOperation({
        client: responseLosingClient,
        effect: () => {
          effects += 1;
          return committed("result:durable", { durable: true });
        },
        operationId: "test-operation",
        operationKey: "lost-commit-response",
        requestDigest: digest,
      });

      expect(outcome).toMatchObject({
        outcome: "committed",
        replayed: true,
        result: { durable: true },
        resultIdentity: "result:durable",
      });
      expect(effects).toBe(1);
      expect(await receiptCount(client, "lost-commit-response")).toBe(1);
    });
  });

  it("collapses duplicate callers onto one effect", async () => {
    await withFileDb(async (client) => {
      const digest = await digestOperationRequest({ value: "same" });
      let effects = 0;
      let winner: Awaited<ReturnType<typeof executeReceiptBackedOperation>> | undefined;
      const racingClient = overrideClient(client, {
        transaction: async (mode?: "write" | "read" | "deferred") => {
          winner = await executeReceiptBackedOperation({
            client,
            effect: async () => {
              effects += 1;
              return committed("result:once", { call: effects });
            },
            operationId: "test-operation",
            operationKey: "duplicate-callers",
            requestDigest: digest,
          });
          return client.transaction(mode);
        },
      });

      const reconciledCaller = await executeReceiptBackedOperation({
        client: racingClient,
        effect: async () => {
          effects += 1;
          return committed("result:once", { call: effects });
        },
        operationId: "test-operation",
        operationKey: "duplicate-callers",
        requestDigest: digest,
      });

      expect(effects).toBe(1);
      expect(winner).toMatchObject({ outcome: "committed", replayed: false });
      expect(reconciledCaller).toMatchObject({ outcome: "committed", replayed: true });
      expect(await receiptCount(client, "duplicate-callers")).toBe(1);
    });
  });

  it("rolls back an accepted receipt when the effect fails", async () => {
    await withFileDb(async (client) => {
      const digest = await digestOperationRequest({ value: "rollback" });
      await client.execute(
        "create table operation_receipt_rollback_effects (effect_key text primary key)",
      );
      const outcome = await executeReceiptBackedOperation({
        client,
        effect: async (transaction) => {
          await transaction.execute(
            "insert into operation_receipt_rollback_effects (effect_key) values ('rolled-back')",
          );
          throw new Error("effect failed");
        },
        operationId: "test-operation",
        operationKey: "rolled-back",
        requestDigest: digest,
      });

      expect(outcome).toEqual({ outcome: "safely-retryable", replayed: false });
      expect(await receiptCount(client, "rolled-back")).toBe(0);
      const effects = await client.execute(
        "select count(*) as count from operation_receipt_rollback_effects",
      );
      expect(Number(effects.rows[0]?.count ?? 0)).toBe(0);
    });
  });

  it("repairs only the bounded stale accepted page", async () => {
    await withFileDb(async (client) => {
      const digest = await digestOperationRequest({ value: "stale" });
      await insertAccepted(client, "stale-key", digest, "2020-01-01T00:00:00.000Z");
      await insertAccepted(
        client,
        "fresh-key",
        digest,
        "2020-01-01T00:00:00.000Z",
        "2030-01-01T00:00:00.000Z",
      );

      const repair = await repairStaleOperationReceipts({
        client,
        limit: 1,
        staleBefore: "2021-01-01T00:00:00.000Z",
      });
      const repaired = await reconcileOperationReceipt({
        client,
        operationId: "test-operation",
        operationKey: "stale-key",
        requestDigest: digest,
      });

      expect(repair).toEqual({ repaired: 1, scanned: 1 });
      expect(repaired).toMatchObject({
        outcome: "rejected",
        replayed: true,
        result: { code: "stale_in_progress" },
      });
      expect(repaired.outcome === "rejected" ? repaired.resultIdentity : "not-terminal").toMatch(
        /^operation-receipt-repair:[0-9a-f]{64}$/,
      );
      expect(
        await reconcileOperationReceipt({
          client,
          operationId: "test-operation",
          operationKey: "fresh-key",
          requestDigest: digest,
        }),
      ).toEqual({ outcome: "in-progress", replayed: false, state: "accepted" });
    });
  });

  it("inspects only public-safe receipt coordinates", async () => {
    await withFileDb(async (client) => {
      const digest = await digestOperationRequest({ privatePayload: "never returned" });
      await executeReceiptBackedOperation({
        client,
        effect: () => committed("result:safe-identity", { privateResult: "also hidden" }),
        operationId: "test-operation",
        operationKey: "inspect-key",
        requestDigest: digest,
      });

      const inspection = await inspectOperationReceipt(client, "inspect-key");
      expect(inspection).toMatchObject({
        operationId: "test-operation",
        outcome: "found",
        resultIdentity: "result:safe-identity",
        state: "committed",
      });
      expect(JSON.stringify(inspection)).not.toContain("private");
      await expect(inspectOperationReceipt(client, "missing-key")).resolves.toEqual({
        outcome: "not-found",
      });
    });
  });

  it("enforces storage byte bounds before starting a transaction", async () => {
    await withFileDb(async (client) => {
      const digest = await digestOperationRequest({ value: 1 });
      await expect(
        executeReceiptBackedOperation({
          client,
          effect: () => committed("never", null),
          operationId: "test-operation",
          operationKey: "é".repeat(129),
          requestDigest: digest,
        }),
      ).rejects.toThrow(/256 bytes/);
    });
  });

  it("reports lookup failure after one failed reconciliation lookup", async () => {
    await withFileDb(async (client) => {
      const digest = await digestOperationRequest({ value: 1 });
      let lookups = 0;
      const baseExecute = client.execute.bind(client);
      const broken = overrideClient(client, {
        execute: async (statement) => {
          lookups += 1;
          if (lookups === 2) {
            throw new Error("lookup unavailable");
          }
          return baseExecute(statement);
        },
        transaction: async () => {
          throw new Error("primary unavailable");
        },
      });

      const outcome = await executeReceiptBackedOperation({
        client: broken,
        effect: () => committed("never", null),
        operationId: "test-operation",
        operationKey: "lookup-failure",
        requestDigest: digest,
      });

      expect(outcome).toEqual({ outcome: "lookup-failed", replayed: false });
      expect(lookups).toBe(2);
    });
  });

  it("replays after a file-database restart without a duplicate or false commit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fluncle-operation-receipts-restart-"));
    const url = `file:${join(directory, "receipts.db")}`;
    const digest = await digestOperationRequest({ value: "restart" });
    const firstClient = await createIntegrationDb({ url });

    try {
      await firstClient.execute(
        "create table operation_receipt_test_effects (effect_key text primary key)",
      );
      const first = await executeReceiptBackedOperation({
        client: firstClient,
        effect: async (transaction) => {
          await transaction.execute(
            "insert into operation_receipt_test_effects (effect_key) values ('once')",
          );
          return committed("result:restart", { committed: true });
        },
        operationId: "test-operation",
        operationKey: "restart-key",
        requestDigest: digest,
      });
      expect(first).toMatchObject({ outcome: "committed", replayed: false });
      firstClient.close();

      const restarted = createClient({ url });
      try {
        const replay = await executeReceiptBackedOperation({
          client: restarted,
          effect: async (transaction) => {
            await transaction.execute(
              "insert into operation_receipt_test_effects (effect_key) values ('duplicate')",
            );
            return committed("result:false-commit", { committed: false });
          },
          operationId: "test-operation",
          operationKey: "restart-key",
          requestDigest: digest,
        });
        const effects = await restarted.execute(
          "select count(*) as count from operation_receipt_test_effects",
        );

        expect(replay).toMatchObject({
          outcome: "committed",
          replayed: true,
          result: { committed: true },
          resultIdentity: "result:restart",
        });
        expect(Number(effects.rows[0]?.count ?? 0)).toBe(1);
      } finally {
        restarted.close();
      }
    } finally {
      firstClient.close();
      await rm(directory, { force: true, recursive: true });
    }
  });
});

async function withFileDb(run: (client: Client) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "fluncle-operation-receipts-"));
  const client = await createIntegrationDb({ url: `file:${join(directory, "receipts.db")}` });

  try {
    await run(client);
  } finally {
    client.close();
    await rm(directory, { force: true, recursive: true });
  }
}

function committed(resultIdentity: string, result: JsonValue) {
  return { result, resultIdentity, state: "committed" as const };
}

function overrideClient(
  client: Client,
  overrides: Partial<OperationReceiptClient>,
): OperationReceiptClient {
  return {
    execute: overrides.execute ?? client.execute.bind(client),
    transaction: overrides.transaction ?? client.transaction.bind(client),
  };
}

function commitThenLoseResponse(transaction: Transaction): Transaction {
  return {
    batch: transaction.batch.bind(transaction),
    close: transaction.close.bind(transaction),
    get closed() {
      return transaction.closed;
    },
    commit: async () => {
      await transaction.commit();
      throw new Error("commit response lost");
    },
    execute: transaction.execute.bind(transaction),
    executeMultiple: transaction.executeMultiple.bind(transaction),
    rollback: transaction.rollback.bind(transaction),
  };
}

async function receiptCount(client: Client, operationKey: string): Promise<number> {
  const result = await client.execute({
    args: [operationKey],
    sql: "select count(*) as count from operation_receipts where operation_key = ?",
  });
  return Number(result.rows[0]?.count ?? 0);
}

async function insertAccepted(
  client: Client,
  operationKey: string,
  requestDigest: string,
  timestamp: string,
  updatedAt = timestamp,
): Promise<void> {
  await client.execute({
    args: [operationKey, "test-operation", requestDigest, "accepted", timestamp, updatedAt],
    sql: `insert into operation_receipts
      (operation_key, operation_id, request_digest, state, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?)`,
  });
}
