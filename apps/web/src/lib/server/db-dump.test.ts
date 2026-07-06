import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";

import { type DumpManifest, type DumpTable, type SchemaObject } from "./db-dump";

import {
  buildDumpSql,
  chooseAnchor,
  quoteIdent,
  selectExpiredBackupKeys,
  spotCell,
  sqlLiteral,
  verifyManifest,
} from "./db-dump";

describe("sqlLiteral", () => {
  it("renders each value type as a valid SQLite literal", () => {
    expect(sqlLiteral(null)).toBe("NULL");
    expect(sqlLiteral(42)).toBe("42");
    expect(sqlLiteral(3.5)).toBe("3.5");
    expect(sqlLiteral(Number.POSITIVE_INFINITY)).toBe("NULL");
    expect(sqlLiteral(9007199254740993n)).toBe("9007199254740993"); // exact past Number range
    expect(sqlLiteral(true)).toBe("1");
    expect(sqlLiteral(false)).toBe("0");
    expect(sqlLiteral("plain")).toBe("'plain'");
    expect(sqlLiteral("O'Brien")).toBe("'O''Brien'"); // single-quote doubled
    expect(sqlLiteral(new Uint8Array([0, 255, 16]))).toBe("X'00ff10'");
    expect(sqlLiteral(new Uint8Array())).toBe("X''");
  });
});

describe("quoteIdent", () => {
  it("double-quotes and escapes identifiers", () => {
    expect(quoteIdent("tracks")).toBe('"tracks"');
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
  });
});

describe("buildDumpSql", () => {
  it("emits tables first, rows next, then indexes/triggers, in one transaction", () => {
    const schema: SchemaObject[] = [
      { name: "t", sql: 'CREATE TABLE "t" (id integer primary key, name text)', type: "table" },
      { name: "t_name", sql: 'CREATE INDEX "t_name" ON "t" (name)', type: "index" },
    ];
    const tables: DumpTable[] = [
      {
        columns: ["id", "name"],
        name: "t",
        rows: [
          [1, "a"],
          [2, null],
        ],
      },
    ];

    const sql = buildDumpSql(schema, tables, "-- header");
    const lines = sql.trim().split("\n");

    expect(lines[0]).toBe("-- header");
    expect(lines[1]).toBe("PRAGMA foreign_keys=OFF;");
    expect(lines[2]).toBe("BEGIN TRANSACTION;");
    // table DDL comes before its INSERTs, index DDL after the rows, COMMIT last.
    const tableIdx = lines.findIndex((line) => line.startsWith("CREATE TABLE"));
    const insertIdx = lines.findIndex((line) => line.startsWith("INSERT INTO"));
    const indexIdx = lines.findIndex((line) => line.startsWith("CREATE INDEX"));
    expect(tableIdx).toBeLessThan(insertIdx);
    expect(insertIdx).toBeLessThan(indexIdx);
    expect(lines.at(-1)).toBe("COMMIT;");
    expect(sql).toContain(`INSERT INTO "t" ("id", "name") VALUES (2, NULL);`);
  });

  it("skips INSERTs for empty tables but keeps their DDL", () => {
    const schema: SchemaObject[] = [
      { name: "empty", sql: 'CREATE TABLE "empty" (id integer)', type: "table" },
    ];
    const sql = buildDumpSql(schema, [{ columns: ["id"], name: "empty", rows: [] }]);

    expect(sql).toContain("CREATE TABLE");
    expect(sql).not.toContain("INSERT INTO");
  });
});

describe("chooseAnchor", () => {
  it("prefers tracks, then most rows, then name; skips empty tables", () => {
    expect(
      chooseAnchor([
        { firstColumn: "id", name: "sessions", rowCount: 900 },
        { firstColumn: "track_id", name: "tracks", rowCount: 46 },
      ]),
    ).toEqual({ column: "track_id", table: "tracks" });

    expect(
      chooseAnchor([
        { firstColumn: "id", name: "aaa", rowCount: 5 },
        { firstColumn: "id", name: "bbb", rowCount: 10 },
      ]),
    ).toEqual({ column: "id", table: "bbb" });

    expect(chooseAnchor([{ firstColumn: "id", name: "empty", rowCount: 0 }])).toBeNull();
    expect(chooseAnchor([])).toBeNull();
  });
});

describe("spotCell", () => {
  it("stringifies values and passes null through", () => {
    expect(spotCell(null)).toBeNull();
    expect(spotCell(undefined)).toBeNull();
    expect(spotCell(7)).toBe("7");
    expect(spotCell("z")).toBe("z");
  });
});

describe("verifyManifest", () => {
  const base = {
    spot: { column: "id", count: 2, max: "b", min: "a", table: "t" },
    tableCount: 1,
    tables: { t: 2 },
  };

  it("passes when the restored shape matches", () => {
    expect(verifyManifest(base, base).ok).toBe(true);
  });

  it("flags a wrong table count", () => {
    const report = verifyManifest(base, { ...base, tableCount: 2 });
    expect(report.ok).toBe(false);
    expect(report.problems[0]).toContain("table count");
  });

  it("flags a missing table, a wrong row count, and an unexpected table", () => {
    expect(verifyManifest(base, { ...base, tables: {} }).problems).toContain(
      'table "t" missing after restore',
    );
    expect(verifyManifest(base, { ...base, tables: { t: 1 } }).problems[0]).toContain("row count");
    expect(verifyManifest(base, { ...base, tables: { extra: 1, t: 2 } }).problems).toContain(
      'unexpected table "extra" after restore',
    );
  });

  it("flags a drifted spot value", () => {
    const report = verifyManifest(base, {
      ...base,
      spot: { ...base.spot, max: "c" },
    });
    expect(report.ok).toBe(false);
    expect(report.problems[0]).toContain("drifted");
  });
});

describe("selectExpiredBackupKeys", () => {
  const options = {
    dailyPrefix: "db-backups/daily/",
    keepDaily: 2,
    keepMonthly: 2,
    monthlyPrefix: "db-backups/monthly/",
  };

  it("keeps the newest N folders per tier and prunes the rest, dump + manifest together", () => {
    const keys = [
      "db-backups/daily/2026-07-06/fluncle.sql.gz",
      "db-backups/daily/2026-07-06/manifest.json",
      "db-backups/daily/2026-07-05/fluncle.sql.gz",
      "db-backups/daily/2026-07-05/manifest.json",
      "db-backups/daily/2026-07-04/fluncle.sql.gz",
      "db-backups/daily/2026-07-04/manifest.json",
      "db-backups/monthly/2026-07/fluncle.sql.gz",
      "db-backups/monthly/2026-06/fluncle.sql.gz",
      "db-backups/monthly/2026-05/fluncle.sql.gz",
    ];

    expect(selectExpiredBackupKeys(keys, options)).toEqual([
      "db-backups/daily/2026-07-04/fluncle.sql.gz",
      "db-backups/daily/2026-07-04/manifest.json",
      "db-backups/monthly/2026-05/fluncle.sql.gz",
    ]);
  });

  it("prunes nothing when under the retention limit", () => {
    expect(
      selectExpiredBackupKeys(["db-backups/daily/2026-07-06/fluncle.sql.gz"], options),
    ).toEqual([]);
  });

  it("never selects an unparseable or foreign key", () => {
    const keys = [
      "db-backups/daily/not-a-date/x.gz",
      "db-backups/daily/2026-07-06/fluncle.sql.gz",
      "db-backups/daily/2026-07-05/fluncle.sql.gz",
      "db-backups/daily/2026-07-04/fluncle.sql.gz",
      "some/other/object.mp4",
    ];
    const expired = selectExpiredBackupKeys(keys, options);
    expect(expired).toEqual(["db-backups/daily/2026-07-04/fluncle.sql.gz"]);
    expect(expired).not.toContain("db-backups/daily/not-a-date/x.gz");
    expect(expired).not.toContain("some/other/object.mp4");
  });
});

// ── The real round trip: source → dump → restore → verify (the drill, in miniature) ──

describe("dump/restore round trip", () => {
  it("restores a dump byte-faithfully and the manifest confirms it", async () => {
    const source = createClient({ url: ":memory:" });
    await source.executeMultiple(`
      CREATE TABLE tracks (track_id text primary key, title text, bpm real, art blob, note text);
      INSERT INTO tracks VALUES ('a1', 'O''Brien''s Anthem', 174.0, X'00ff10', NULL);
      INSERT INTO tracks VALUES ('b2', 'Sudden Change', 87.5, X'', 'why');
      CREATE TABLE tags (id integer primary key, label text);
      INSERT INTO tags VALUES (1, 'roller');
      CREATE INDEX tracks_title ON tracks (title);
    `);

    // Simulate the box's dump: read schema + every table's rows.
    const schemaResult = await source.execute(
      `SELECT type, name, sql FROM sqlite_master
       WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
       ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name`,
    );
    const schema: SchemaObject[] = schemaResult.rows.map((row) => ({
      name: row.name as string,
      sql: row.sql as string,
      type: row.type as string,
    }));
    const tableNames = schema
      .filter((object) => object.type === "table")
      .map((object) => object.name);

    const tables: DumpTable[] = [];
    const expectedCounts: Record<string, number> = {};

    for (const name of tableNames) {
      const result = await source.execute(`SELECT * FROM ${quoteIdent(name)}`);
      const columns = result.columns;
      tables.push({
        columns,
        name,
        rows: result.rows.map((row) => columns.map((column) => row[column] as never)),
      });
      expectedCounts[name] = result.rows.length;
    }

    const anchor = chooseAnchor(
      tables.map((table) => ({
        firstColumn: table.columns[0] ?? "",
        name: table.name,
        rowCount: table.rows.length,
      })),
    );
    expect(anchor).toEqual({ column: "track_id", table: "tracks" });

    const anchorSpot = await source.execute(
      `SELECT count(*) AS c, min(${quoteIdent(anchor?.column ?? "")}) AS mn, max(${quoteIdent(
        anchor?.column ?? "",
      )}) AS mx FROM ${quoteIdent(anchor?.table ?? "")}`,
    );
    const spotRow = anchorSpot.rows[0];

    const expected: DumpManifest = {
      generatedAt: new Date().toISOString(),
      source: "test",
      spot: {
        column: anchor?.column ?? "",
        count: Number(spotRow?.c),
        max: spotCell(spotRow?.mx),
        min: spotCell(spotRow?.mn),
        table: anchor?.table ?? "",
      },
      sqlBytes: 0,
      tableCount: tableNames.length,
      tables: expectedCounts,
    };

    const dumpSql = buildDumpSql(schema, tables);

    // Restore into a fresh scratch database (the drill's core move).
    const restored = createClient({ url: ":memory:" });
    await restored.executeMultiple(dumpSql);

    const restoredTables = await restored.execute(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
    );
    const actualCounts: Record<string, number> = {};
    for (const row of restoredTables.rows) {
      const name = row.name as string;
      const count = await restored.execute(`SELECT count(*) AS c FROM ${quoteIdent(name)}`);
      actualCounts[name] = Number(count.rows[0]?.c);
    }
    const actualSpot = await restored.execute(
      `SELECT count(*) AS c, min(track_id) AS mn, max(track_id) AS mx FROM tracks`,
    );

    const actual = {
      spot: {
        column: "track_id",
        count: Number(actualSpot.rows[0]?.c),
        max: spotCell(actualSpot.rows[0]?.mx),
        min: spotCell(actualSpot.rows[0]?.mn),
        table: "tracks",
      },
      tableCount: restoredTables.rows.length,
      tables: actualCounts,
    };

    expect(verifyManifest(expected, actual)).toEqual({ ok: true, problems: [] });

    // The blob and the escaped-quote string survived the round trip byte-for-byte.
    const check = await restored.execute(
      "SELECT title, hex(art) AS art FROM tracks WHERE track_id = 'a1'",
    );
    expect(check.rows[0]?.title).toBe("O'Brien's Anthem");
    expect(((check.rows[0]?.art ?? "") as string).toLowerCase()).toBe("00ff10");

    // Tamper the restored data — the manifest must now reject it.
    await restored.execute("DELETE FROM tracks WHERE track_id = 'b2'");
    const tampered = await restored.execute(`SELECT count(*) AS c FROM tracks`);
    const failing = verifyManifest(expected, {
      ...actual,
      tables: { ...actual.tables, tracks: Number(tampered.rows[0]?.c) },
    });
    expect(failing.ok).toBe(false);
  });
});
