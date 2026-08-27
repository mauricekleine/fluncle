import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";

import { createIntegrationDb } from "./integration-db";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

let db: Client;

beforeEach(async () => {
  db = await createIntegrationDb();
});

async function insertAccepted(
  operationKey: string,
  requestDigest: string,
  operationId = "health.snapshot",
): Promise<void> {
  await db.execute({
    args: [operationKey, operationId, requestDigest],
    sql: `insert into operation_receipts
      (operation_key, operation_id, request_digest, state, created_at, updated_at)
      values (?, ?, ?, 'accepted', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  });
}

describe("operation receipt schema", () => {
  it("creates the receipt table and its bounded lookup indexes", async () => {
    const table = await db.execute(
      `select sql from sqlite_master where type = 'table' and name = 'operation_receipts'`,
    );
    const indexes = await db.execute(
      `select name, sql from sqlite_master
       where type = 'index' and tbl_name = 'operation_receipts'
       order by name`,
    );

    expect(table.rows[0]?.sql).toContain("operation_receipts_lifecycle_check");
    expect(indexes.rows.map((row) => row.name)).toEqual([
      "operation_receipts_stale_accepted_idx",
      "sqlite_autoindex_operation_receipts_1",
    ]);
    expect(
      indexes.rows.find((row) => row.name === "operation_receipts_stale_accepted_idx")?.sql,
    ).toContain("`state`,`updated_at`,`operation_key`");
  });

  it("moves accepted receipts to either complete terminal state", async () => {
    await insertAccepted("commit-key", DIGEST_A);
    await insertAccepted("reject-key", DIGEST_B);

    await db.execute({
      args: ["commit-key"],
      sql: `update operation_receipts
        set state = 'committed', result_identity = 'post:1',
            result_json = '{"status":"published"}',
            terminal_at = '2026-01-01T00:01:00.000Z',
            updated_at = '2026-01-01T00:01:00.000Z'
        where operation_key = ?`,
    });
    await db.execute({
      args: ["reject-key"],
      sql: `update operation_receipts
        set state = 'rejected', result_identity = 'rejection:1',
            result_json = '{"code":"invalid_request"}',
            terminal_at = '2026-01-01T00:02:00.000Z',
            updated_at = '2026-01-01T00:02:00.000Z'
        where operation_key = ?`,
    });

    const receipts = await db.execute(
      `select operation_key, result_identity, result_json, state, terminal_at
       from operation_receipts order by operation_key`,
    );

    expect(receipts.rows).toEqual([
      {
        operation_key: "commit-key",
        result_identity: "post:1",
        result_json: '{"status":"published"}',
        state: "committed",
        terminal_at: "2026-01-01T00:01:00.000Z",
      },
      {
        operation_key: "reject-key",
        result_identity: "rejection:1",
        result_json: '{"code":"invalid_request"}',
        state: "rejected",
        terminal_at: "2026-01-01T00:02:00.000Z",
      },
    ]);
  });

  it.each([
    ["short", "a".repeat(63)],
    ["uppercase", `${"a".repeat(63)}A`],
    ["non-hex", `${"a".repeat(63)}g`],
  ])("rejects a %s SHA-256 digest", async (_label, digest) => {
    await expect(insertAccepted(`bad-digest-${_label}`, digest)).rejects.toThrow(/constraint/i);
  });

  it("rejects rows whose result fields disagree with their lifecycle", async () => {
    await expect(
      db.execute({
        args: [DIGEST_A],
        sql: `insert into operation_receipts
          (operation_key, operation_id, request_digest, state, result_identity, result_json,
           terminal_at, created_at, updated_at)
          values ('accepted-with-result', 'health.snapshot', ?, 'accepted', 'health:1', '{}',
                  '2026-01-01T00:01:00.000Z', '2026-01-01T00:00:00.000Z',
                  '2026-01-01T00:01:00.000Z')`,
      }),
    ).rejects.toThrow(/constraint/i);

    await expect(
      db.execute({
        args: [DIGEST_B],
        sql: `insert into operation_receipts
          (operation_key, operation_id, request_digest, state, created_at, updated_at)
          values ('committed-without-result', 'health.snapshot', ?, 'committed',
                  '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z')`,
      }),
    ).rejects.toThrow(/constraint/i);
  });

  it("bounds identifiers and terminal results", async () => {
    await expect(insertAccepted("k".repeat(257), DIGEST_A)).rejects.toThrow(/constraint/i);
    await expect(insertAccepted("bounded-key", DIGEST_A, "o".repeat(65))).rejects.toThrow(
      /constraint/i,
    );

    await insertAccepted("terminal-bounds", DIGEST_A);
    await expect(
      db.execute({
        args: ["i".repeat(513), JSON.stringify("j".repeat(16384))],
        sql: `update operation_receipts
          set state = 'committed', result_identity = ?, result_json = ?,
              terminal_at = '2026-01-01T00:01:00.000Z',
              updated_at = '2026-01-01T00:01:00.000Z'
          where operation_key = 'terminal-bounds'`,
      }),
    ).rejects.toThrow(/constraint/i);
  });

  it("keeps operation keys unique while allowing distinct keys for the same request digest", async () => {
    await insertAccepted("key-a", DIGEST_A, "health.snapshot");

    await expect(insertAccepted("key-a", DIGEST_B, "health.snapshot")).rejects.toThrow(/unique/i);
    await insertAccepted("key-b", DIGEST_A, "health.snapshot");
    await insertAccepted("key-c", DIGEST_A, "catalogue.rank");

    const count = await db.execute(`select count(*) as n from operation_receipts`);

    expect(Number(count.rows[0]?.n ?? 0)).toBe(3);
  });
});
