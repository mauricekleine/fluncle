import { createClient } from "@libsql/client";
import { type MigrationMeta } from "drizzle-orm/migrator";
import { describe, expect, it } from "vitest";

import { LOCAL_DB_CONCURRENCY } from "../src/lib/database-concurrency";

import {
  type MigrationJournalEntry,
  type ProductionMigrationPlan,
} from "./guard-production-migrations";
import {
  applyProductionMigrationPlan,
  pairJournalWithMigrations,
  statementsForMigrationPlan,
} from "./migrate";

const ENTRIES: MigrationJournalEntry[] = [
  { idx: 0, tag: "0000_expansion", when: 100 },
  { idx: 1, tag: "0001_contraction", when: 200 },
];
const MIGRATIONS: MigrationMeta[] = [
  {
    bps: true,
    folderMillis: 100,
    hash: "expansion-hash",
    sql: ["create table expansion (id integer primary key);"],
  },
  {
    bps: true,
    folderMillis: 200,
    hash: "contraction-hash",
    sql: ["create table contraction (id integer primary key);"],
  },
];

function planFor(entries: MigrationJournalEntry[]): ProductionMigrationPlan {
  return {
    lastAppliedWhen: null,
    pendingEntries: entries,
    throughTag: entries.at(-1)?.tag ?? null,
  };
}

describe("production migration runner", () => {
  it("fails closed when Drizzle's loaded files do not match the parsed journal", () => {
    expect(() => pairJournalWithMigrations(ENTRIES, MIGRATIONS.slice(0, 1))).toThrow(
      /counts differ/,
    );
    expect(() =>
      pairJournalWithMigrations(ENTRIES, [{ ...MIGRATIONS[0], folderMillis: 101 }, MIGRATIONS[1]]),
    ).toThrow(/does not match/);
  });

  it("builds statements for every pending journal entry", () => {
    const pairs = pairJournalWithMigrations(ENTRIES, MIGRATIONS);
    const statements = statementsForMigrationPlan(pairs, planFor(ENTRIES));
    const sql = statements.map((statement) =>
      typeof statement === "string" ? statement : statement.sql,
    );

    expect(sql).toContain("create table expansion (id integer primary key);");
    expect(sql).toContain("create table contraction (id integer primary key);");
    expect(sql.filter((statement) => statement.includes("__drizzle_migrations"))).toHaveLength(2);
  });

  it("applies and stamps the complete pending journal in a real libSQL database", async () => {
    const client = createClient({ concurrency: LOCAL_DB_CONCURRENCY, url: ":memory:" });

    try {
      await applyProductionMigrationPlan(
        client,
        pairJournalWithMigrations(ENTRIES, MIGRATIONS),
        planFor(ENTRIES),
      );

      const tables = await client.execute(
        "select name from sqlite_master where type = 'table' order by name",
      );
      const ledger = await client.execute(
        "select hash, created_at from __drizzle_migrations order by created_at",
      );

      expect(tables.rows.map((row) => row.name)).toContain("expansion");
      expect(tables.rows.map((row) => row.name)).toContain("contraction");
      expect(ledger.rows).toEqual([
        { created_at: 100, hash: "expansion-hash" },
        { created_at: 200, hash: "contraction-hash" },
      ]);
    } finally {
      client.close();
    }
  });

  it("propagates a migration failure and atomically withholds its schema and ledger stamp", async () => {
    const client = createClient({ concurrency: LOCAL_DB_CONCURRENCY, url: ":memory:" });
    const failingMigrations: MigrationMeta[] = [
      {
        bps: true,
        folderMillis: 100,
        hash: "failing-hash",
        sql: ["create table should_rollback (id integer);", "this is not sql;"],
      },
    ];
    const entries = ENTRIES.slice(0, 1);

    try {
      await expect(
        applyProductionMigrationPlan(
          client,
          pairJournalWithMigrations(entries, failingMigrations),
          planFor(entries),
        ),
      ).rejects.toThrow();

      const table = await client.execute(
        "select name from sqlite_master where type = 'table' and name = 'should_rollback'",
      );
      const ledger = await client.execute("select created_at from __drizzle_migrations");

      expect(table.rows).toEqual([]);
      expect(ledger.rows).toEqual([]);
    } finally {
      client.close();
    }
  });
});
