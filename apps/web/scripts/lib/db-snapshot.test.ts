import { type Client, createClient, type InArgs, type ResultSet } from "@libsql/client";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LOCAL_DB_CONCURRENCY } from "../../src/lib/database-concurrency";
import { createIntegrationDb, seedCatalogueTrack } from "../../src/lib/server/integration-db";
import {
  devSnapshotPath,
  formatSnapshotReport,
  partialSnapshotPath,
  previousSnapshotPath,
  pullSnapshot,
  type SnapshotClient,
} from "./db-snapshot";

const VECTOR_BYTES = 4096;

let dir: string;
let source: Client;
let outPath: string;

function vector(seed: number): Uint8Array {
  const bytes = new Uint8Array(VECTOR_BYTES);

  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = (seed * 31 + index) % 256;
  }

  return bytes;
}

async function seedSource(client: Client): Promise<void> {
  await client.executeMultiple(`
    CREATE TABLE tracks (track_id text primary key, title text, bpm real, plays integer, embedding blob, note text);
    CREATE TABLE tags (id integer primary key, label text);
    CREATE TABLE pairs (kind text not null, key blob not null, weight real, PRIMARY KEY (kind, key)) WITHOUT ROWID;
    CREATE TABLE empty_shelf (id integer primary key, value text);
    CREATE INDEX tracks_title ON tracks (title);
    CREATE TRIGGER tags_touch AFTER UPDATE ON tags BEGIN SELECT 1; END;
  `);

  for (let index = 0; index < 7; index += 1) {
    await client.execute({
      args: [
        `track-${index}`,
        index === 3 ? "O'Brien's \"Anthem\"\nline two" : `Title ${index}`,
        170 + index / 2,
        index === 5 ? 9007199254740993n : index,
        vector(index),
        index % 2 === 0 ? null : "note",
      ],
      sql: "INSERT INTO tracks VALUES (?, ?, ?, ?, ?, ?)",
    });
  }

  await client.execute("DELETE FROM tracks WHERE track_id = 'track-2'");

  for (const id of [1, 2, 5, 9, 40]) {
    await client.execute({ args: [id, `tag ${id}`], sql: "INSERT INTO tags VALUES (?, ?)" });
  }

  for (let index = 0; index < 5; index += 1) {
    await client.execute({
      args: [index < 3 ? "a" : "b", new Uint8Array([index, 0, 255 - index]), index * 1.5],
      sql: "INSERT INTO pairs VALUES (?, ?, ?)",
    });
  }
}

async function rowsOf(client: Client, sql: string): Promise<unknown[]> {
  const result = await client.execute(sql);

  return result.rows.map((row) =>
    result.columns.map((_, index) => {
      const value = row[index];

      return value instanceof ArrayBuffer ? [...new Uint8Array(value)] : value;
    }),
  );
}

type Recorded = { args: InArgs; sql: string };

function recording(
  client: Client,
  onExecute: (call: Recorded, index: number) => Promise<void> | void = () => {},
): { calls: Recorded[]; wrapped: SnapshotClient } {
  const calls: Recorded[] = [];

  return {
    calls,
    wrapped: {
      execute: async (statement): Promise<ResultSet> => {
        const call =
          typeof statement === "string" ? { args: [], sql: statement } : { ...statement };

        calls.push(call);
        await onExecute(call, calls.length - 1);

        return client.execute(statement);
      },
    },
  };
}

function pageQueries(calls: Recorded[], table: string): Recorded[] {
  return calls.filter((call) => call.sql.includes(`FROM "${table}"`) && call.sql.includes("LIMIT"));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fluncle-db-snapshot-"));
  source = createClient({
    concurrency: LOCAL_DB_CONCURRENCY,
    intMode: "bigint",
    url: `file:${join(dir, "source.db")}`,
  });
  outPath = join(dir, "dev", "seed.sql");
  await seedSource(source);
});

afterEach(async () => {
  source.close();
  await rm(dir, { force: true, recursive: true });
});

describe("devSnapshotPath", () => {
  it("lives under the data directory, outside any checkout", () => {
    const previous = process.env.XDG_DATA_HOME;

    process.env.XDG_DATA_HOME = "/data";
    try {
      expect(devSnapshotPath()).toBe("/data/fluncle/seed.sql");
    } finally {
      if (previous === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previous;
      }
    }
  });
});

describe("pullSnapshot", () => {
  it("restores every table byte-faithfully across many small pages", async () => {
    const report = await pullSnapshot({
      client: source,
      header: "-- test snapshot",
      outPath,
      pageRows: 2,
    });

    const restored = createClient({
      concurrency: LOCAL_DB_CONCURRENCY,
      intMode: "bigint",
      url: `file:${join(dir, "restored.db")}`,
    });

    try {
      await restored.executeMultiple(await readFile(outPath, "utf8"));

      for (const sql of [
        "SELECT * FROM tracks ORDER BY track_id",
        "SELECT * FROM tags ORDER BY id",
        "SELECT * FROM pairs ORDER BY kind, key",
        "SELECT * FROM empty_shelf",
        "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
      ]) {
        expect(await rowsOf(restored, sql)).toEqual(await rowsOf(source, sql));
      }
    } finally {
      restored.close();
    }

    expect(report.tables).toEqual([
      { name: "empty_shelf", rows: 0 },
      { name: "pairs", rows: 5 },
      { name: "tags", rows: 5 },
      { name: "tracks", rows: 6 },
    ]);
    expect(report.totalRows).toBe(16);
    expect(report.bytes).toBe((await stat(outPath)).size);
  });

  it("bounds every page request and binds a BLOB key as a blob", async () => {
    const { calls, wrapped } = recording(source);

    await pullSnapshot({ client: wrapped, header: "-- test", outPath, pageRows: 2 });

    const reads = calls.filter((call) => /FROM "(tracks|tags|pairs|empty_shelf)"/.test(call.sql));

    expect(reads.length).toBeGreaterThan(0);

    for (const read of reads) {
      expect(read.sql).toMatch(/ORDER BY .+ LIMIT \?$/);
      expect(Array.isArray(read.args) ? read.args.at(-1) : undefined).toBe(2);
    }

    expect(pageQueries(calls, "tracks")).toHaveLength(4);
    expect(pageQueries(calls, "tags")).toHaveLength(3);

    const pairCursors = pageQueries(calls, "pairs")
      .slice(1)
      .map((call) => (Array.isArray(call.args) ? call.args[1] : undefined));

    expect(pairCursors.length).toBeGreaterThan(0);

    for (const cursor of pairCursors) {
      expect(cursor).toBeInstanceOf(ArrayBuffer);
    }
  });

  it("streams rows to disk while it pages instead of holding the dump in memory", async () => {
    const partial = partialSnapshotPath(outPath);
    const sizesBeforeTracksPages: number[] = [];
    const { wrapped } = recording(source, async (call) => {
      if (call.sql.includes('FROM "tracks"') && existsSync(partial)) {
        sizesBeforeTracksPages.push((await stat(partial)).size);
      }
    });

    await pullSnapshot({ client: wrapped, flushBytes: 1, header: "-- test", outPath, pageRows: 2 });

    const last = sizesBeforeTracksPages.at(-1) ?? 0;

    expect(sizesBeforeTracksPages.length).toBeGreaterThan(1);
    expect(last).toBeGreaterThan(2 * VECTOR_BYTES);
    expect(last).toBeGreaterThan(sizesBeforeTracksPages[0] ?? Number.POSITIVE_INFINITY);
  });

  it("replaces a previous snapshot only on full success and leaves no previous copy behind", async () => {
    await pullSnapshot({ client: source, header: "-- first", outPath, pageRows: 3 });
    await writeFile(outPath, "-- stale august dump\n", "utf8");

    await pullSnapshot({ client: source, header: "-- second", outPath, pageRows: 3 });

    const text = await readFile(outPath, "utf8");

    expect(text.startsWith("-- second\n")).toBe(true);
    expect(text.trimEnd().split("\n").at(-1)).toBe("-- Complete: 4 tables, 16 rows.");
    expect(existsSync(previousSnapshotPath(outPath))).toBe(false);
    expect(existsSync(partialSnapshotPath(outPath))).toBe(false);
  });

  it("fails loudly without leaving a partial or stale file posing as a fresh snapshot", async () => {
    await pullSnapshot({ client: source, header: "-- ok", outPath, pageRows: 2 });
    await writeFile(outPath, "-- stale august dump\n", "utf8");

    const { wrapped } = recording(source, (call) => {
      if (call.sql.includes('FROM "tags"') && call.sql.includes("WHERE")) {
        throw new Error("HTTP 500 from the database");
      }
    });

    await expect(
      pullSnapshot({ client: wrapped, header: "-- doomed", outPath, pageRows: 2 }),
    ).rejects.toThrow(
      /Snapshot failed.*previous snapshot stays at .*seed\.previous\.sql.*HTTP 500/s,
    );

    expect(existsSync(outPath)).toBe(false);
    expect(existsSync(partialSnapshotPath(outPath))).toBe(false);
    expect(await readFile(previousSnapshotPath(outPath), "utf8")).toBe("-- stale august dump\n");
  });

  it("reports per-table rows, total bytes, and elapsed time", async () => {
    let tick = 1_000;
    const report = await pullSnapshot({
      client: source,
      header: "-- test",
      now: () => {
        tick += 2_500;

        return tick;
      },
      outPath,
      pageRows: 100,
    });

    expect(report.elapsedMs).toBe(2_500);

    const text = formatSnapshotReport(report);

    expect(text).toContain(`Wrote ${outPath}`);
    expect(text).toMatch(/tracks\s+6/);
    expect(text).toMatch(/total\s+16/);
    expect(text).toContain(`4 tables, 16 rows, ${report.bytes} bytes`);
    expect(text).toContain("in 2.5s.");
  });

  it("dumps and restores the full migrated Fluncle schema, leaving the search index to db:migrate", async () => {
    const migrated = await createIntegrationDb();

    try {
      await seedCatalogueTrack(migrated, { title: "Keyed", trackId: "snap00000000000000000a" });
      await seedCatalogueTrack(migrated, { title: "Bare", trackId: "snap00000000000000000b" });

      const report = await pullSnapshot({
        client: migrated,
        header: "-- migrated",
        outPath,
        pageRows: 1,
      });
      const restored = createClient({ concurrency: LOCAL_DB_CONCURRENCY, url: ":memory:" });

      try {
        await restored.executeMultiple(await readFile(outPath, "utf8"));

        expect(report.tables.some((table) => table.name.startsWith("tracks_fts"))).toBe(false);
        expect(report.tables.find((table) => table.name === "tracks")?.rows).toBe(2);

        for (const table of report.tables) {
          const count = await restored.execute(`SELECT count(*) AS n FROM "${table.name}"`);

          expect({ name: table.name, rows: Number(count.rows[0]?.n) }).toEqual(table);
        }
      } finally {
        restored.close();
      }
    } finally {
      migrated.close();
    }
  });

  it("carries AUTOINCREMENT heads across a restore, including a compacted table with no rows left", async () => {
    await source.executeMultiple(`
      CREATE TABLE events (seq integer primary key autoincrement, body text);
      CREATE TABLE ledger (id integer primary key autoincrement, body text);
      INSERT INTO events (body) VALUES ('a'), ('b'), ('c');
      DELETE FROM events;
      INSERT INTO ledger (body) VALUES ('x'), ('y'), ('z'), ('w');
      DELETE FROM ledger WHERE id > 2;
    `);

    await pullSnapshot({ client: source, header: "-- sequences", outPath, pageRows: 2 });

    const restored = createClient({
      concurrency: LOCAL_DB_CONCURRENCY,
      intMode: "bigint",
      url: `file:${join(dir, "restored.db")}`,
    });
    const head = (client: Client, name: string) =>
      rowsOf(
        client,
        `select coalesce((select seq from sqlite_sequence where name = '${name}'), 0) as seq`,
      );

    try {
      await restored.executeMultiple(await readFile(outPath, "utf8"));

      expect(await head(source, "events")).toEqual([[3n]]);
      expect(await head(restored, "events")).toEqual([[3n]]);
      expect(await head(restored, "ledger")).toEqual([[4n]]);
      expect(await rowsOf(restored, "SELECT count(*) FROM events")).toEqual([[0n]]);

      await restored.execute("INSERT INTO events (body) VALUES ('d')");
      await restored.execute("INSERT INTO ledger (body) VALUES ('v')");

      expect(await rowsOf(restored, "SELECT seq FROM events")).toEqual([[4n]]);
      expect(await rowsOf(restored, "SELECT max(id) FROM ledger")).toEqual([[5n]]);
    } finally {
      restored.close();
    }
  });

  it("clears a previous copy stranded by an earlier failed pull once a pull succeeds", async () => {
    await pullSnapshot({ client: source, header: "-- first", outPath, pageRows: 2 });

    const { wrapped } = recording(source, (call) => {
      if (call.sql.includes('FROM "tags"')) {
        throw new Error("connection reset");
      }
    });

    await expect(
      pullSnapshot({ client: wrapped, header: "-- doomed", outPath, pageRows: 2 }),
    ).rejects.toThrow(/Snapshot failed/);

    expect(existsSync(outPath)).toBe(false);
    expect(existsSync(previousSnapshotPath(outPath))).toBe(true);

    await expect(
      pullSnapshot({ client: wrapped, header: "-- doomed again", outPath, pageRows: 2 }),
    ).rejects.toThrow(/previous snapshot stays at .*seed\.previous\.sql/s);

    await pullSnapshot({ client: source, header: "-- fresh", outPath, pageRows: 2 });

    expect((await readFile(outPath, "utf8")).startsWith("-- fresh\n")).toBe(true);
    expect(existsSync(previousSnapshotPath(outPath))).toBe(false);
    expect(existsSync(partialSnapshotPath(outPath))).toBe(false);
  });
});
