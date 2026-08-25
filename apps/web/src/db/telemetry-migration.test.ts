import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATIONS = fileURLToPath(new URL("../../drizzle-telemetry", import.meta.url));

function statements(name: string): string[] {
  return readFileSync(`${MIGRATIONS}/${name}`, "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

describe("telemetry observability migration", () => {
  it("preserves old run rows and backfills only facts the ledger already knew", async () => {
    const client = createClient({ url: ":memory:" });

    try {
      for (const statement of statements("0000_fantastic_emma_frost.sql")) {
        await client.execute(statement);
      }

      for (const [id, ok] of [
        ["old-success", 1],
        ["old-failure", 0],
      ] as const) {
        await client.execute({
          args: [
            id,
            "2026-01-01T00:00:02.000Z",
            "2026-01-01T00:00:01.000Z",
            0,
            "[]",
            "2026-01-01T00:00:00.000Z",
            ok,
            "parsed",
            "legacy-unit",
            "[]",
          ],
          sql: `insert into run_events (
                  id, created_at, ended_at, exit_code, missing_fields,
                  occurred_at, ok, summary_status, unit, unrecognised_fields
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        });
      }

      for (const statement of statements("0001_right_miek.sql")) {
        await client.execute(statement);
      }

      // A rolling-deploy writer may still issue the old insert after expansion. Its
      // classification stays unknown and outcome stays NULL rather than defaulting to a
      // false verdict; the API reader derives that compatibility value from stored `ok`.
      await client.execute({
        args: [
          "rolling-success",
          "2026-01-01T00:01:02.000Z",
          "2026-01-01T00:01:01.000Z",
          0,
          "[]",
          "2026-01-01T00:01:00.000Z",
          1,
          "parsed",
          "legacy-unit",
          "[]",
        ],
        sql: `insert into run_events (
                id, created_at, ended_at, exit_code, missing_fields,
                occurred_at, ok, summary_status, unit, unrecognised_fields
              ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      });

      const result = await client.execute({
        args: ["old-success", "old-failure", "rolling-success"],
        sql: `select id, access_class, attempt_count, batch_count, operation_id,
                    outcome, release, unit
             from run_events
             where id in (?, ?, ?)
             order by id`,
      });

      expect(result.rows).toEqual([
        {
          access_class: null,
          attempt_count: null,
          batch_count: null,
          id: "old-failure",
          operation_id: null,
          outcome: "failure",
          release: "unknown",
          unit: "legacy-unit",
        },
        {
          access_class: null,
          attempt_count: null,
          batch_count: null,
          id: "old-success",
          operation_id: null,
          outcome: "success",
          release: "unknown",
          unit: "legacy-unit",
        },
        {
          access_class: null,
          attempt_count: null,
          batch_count: null,
          id: "rolling-success",
          operation_id: null,
          outcome: null,
          release: "unknown",
          unit: "legacy-unit",
        },
      ]);
    } finally {
      client.close();
    }
  });
});
