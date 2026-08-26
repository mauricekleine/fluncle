import { Database, type SQLQueryBindings } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type DeviceGeneration,
  type DeviceSqlValue,
  type DeviceTargetClient,
  inspectDeviceGeneration,
  type LibsqlStatement,
  publishDeviceGeneration,
  type QueryResult,
  syncSourceReplica,
} from "./device-mirror";
import {
  DEVICE_DB_COLUMNS,
  DEVICE_DB_INDEXES,
  DEVICE_DB_PRIMARY_KEYS,
  DEVICE_DB_SCHEMA_VERSION,
  DEVICE_SOURCE_TABLES,
  quoteDeviceDbIdentifier,
} from "./device-db-derivation";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "device-mirror-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function binding(value: DeviceSqlValue): SQLQueryBindings {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }

  return value;
}

class LocalTargetClient implements DeviceTargetClient {
  readonly database: Database;
  beforeBatch?: (statements: readonly LibsqlStatement[], mode: "read" | "write") => void;

  constructor(path: string) {
    this.database = new Database(path, { create: true, strict: true });
  }

  batch(statements: readonly LibsqlStatement[], mode: "read" | "write"): Promise<QueryResult[]> {
    this.beforeBatch?.(statements, mode);
    const run = this.database.transaction(() =>
      statements.map((statement) => {
        const args = (statement.args ?? []).map(binding);
        const trimmed = statement.sql.trimStart().toUpperCase();

        if (trimmed.startsWith("SELECT") || trimmed.startsWith("PRAGMA")) {
          const query = this.database.query(statement.sql);
          const rows = query
            .values(...args)
            .map((row) =>
              row.map((value) => (typeof value === "boolean" ? Number(value) : value)),
            ) as DeviceSqlValue[][];

          return { affectedRows: 0, columns: query.columnNames, rows };
        }

        const result = this.database.run(statement.sql, ...args);
        return { affectedRows: result.changes, columns: [], rows: [] };
      }),
    );

    return Promise.resolve(mode === "write" ? run.immediate() : run.deferred());
  }

  close(): void {
    this.database.close();
  }
}

function createDeviceTables(database: Database): void {
  for (const table of DEVICE_SOURCE_TABLES) {
    const definitions = DEVICE_DB_COLUMNS[table].map((column) => quoteDeviceDbIdentifier(column));
    definitions.push(
      `PRIMARY KEY (${DEVICE_DB_PRIMARY_KEYS[table].map(quoteDeviceDbIdentifier).join(", ")})`,
    );
    database.run(
      `CREATE TABLE ${quoteDeviceDbIdentifier(table)} (${definitions.join(", ")}) WITHOUT ROWID`,
    );
  }

  database.run(`CREATE TABLE device_sync_meta (
    schema_version INTEGER NOT NULL,
    cut_name TEXT NOT NULL,
    derived_at TEXT NOT NULL,
    source_watermark TEXT NOT NULL
  )`);

  for (const index of DEVICE_DB_INDEXES) {
    database.run(
      `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${quoteDeviceDbIdentifier(index.name)}
       ON ${quoteDeviceDbIdentifier(index.table)}
       (${index.columns.map(quoteDeviceDbIdentifier).join(", ")})`,
    );
  }
}

function insertTrack(database: Database, trackId: string, title: string): void {
  const columns = DEVICE_DB_COLUMNS.tracks;
  const row = Object.fromEntries(columns.map((column) => [column, null])) as Record<
    string,
    DeviceSqlValue
  >;
  row.track_id = trackId;
  row.title = title;
  database
    .query(
      `INSERT INTO tracks (${columns.map(quoteDeviceDbIdentifier).join(", ")})
       VALUES (${columns.map(() => "?").join(", ")})`,
    )
    .run(...columns.map((column) => binding(row[column] ?? null)));
}

function generationFixture(rowCount: number, name = `generation-${rowCount}`): DeviceGeneration {
  const directory = temporaryDirectory();
  const path = join(directory, `${name}.db`);
  const database = new Database(path, { create: true, strict: true });
  createDeviceTables(database);

  for (let index = 0; index < rowCount; index += 1) {
    insertTrack(database, `track-${String(index).padStart(4, "0")}`, `Track ${index}`);
  }

  database
    .query("INSERT INTO device_sync_meta VALUES (?, ?, ?, ?)")
    .run(DEVICE_DB_SCHEMA_VERSION, "anchored", "2026-08-25T12:00:00.000Z", "source");
  database.run("VACUUM");
  database.close();
  return inspectDeviceGeneration(path);
}

function targetFixture(includeOldTrack = true): { client: LocalTargetClient; path: string } {
  const directory = temporaryDirectory();
  const path = join(directory, "target.db");
  const client = new LocalTargetClient(path);
  createDeviceTables(client.database);
  if (includeOldTrack) {
    insertTrack(client.database, "old-track", "Last good");
  }
  client.database
    .query("INSERT INTO device_sync_meta VALUES (?, ?, ?, ?)")
    .run(DEVICE_DB_SCHEMA_VERSION, "anchored", "2026-08-24T12:00:00.000Z", "old-fingerprint");
  return { client, path };
}

function liveTracks(client: LocalTargetClient): string[] {
  return (
    client.database.query("SELECT track_id FROM tracks ORDER BY track_id").all() as {
      track_id: string;
    }[]
  ).map((row) => row.track_id);
}

function createReplicaSchema(path: string): void {
  const database = new Database(path, { create: true });

  for (const table of [...DEVICE_SOURCE_TABLES, "track_embeddings"] as const) {
    database.run(`CREATE TABLE ${quoteDeviceDbIdentifier(table)} (id TEXT)`);
  }

  database.close();
}

describe("embedded source replica", () => {
  test("rebuilds corrupt local state before making exactly one explicit sync call", async () => {
    const path = join(temporaryDirectory(), "replica.db");
    writeFileSync(path, "corrupt");
    let syncCalls = 0;
    const result = await syncSourceReplica(
      { authToken: "test", path, syncUrl: "libsql://source.invalid" },
      () => ({
        close: () => {},
        sync: async () => {
          syncCalls += 1;
          createReplicaSchema(path);
          return { frame_no: 42, frames_synced: 42 };
        },
      }),
    );

    expect(syncCalls).toBe(1);
    expect(result.rebuildCause).not.toBeNull();
    expect(result.frameNo).toBe(42);
  });

  test("a sync interruption preserves restartable state and the next run converges", async () => {
    const path = join(temporaryDirectory(), "replica.db");
    createReplicaSchema(path);
    let failedCalls = 0;

    expect(
      await rejectionMessage(
        syncSourceReplica({ authToken: "test", path, syncUrl: "libsql://source.invalid" }, () => ({
          close: () => {},
          sync: async () => {
            failedCalls += 1;
            throw new Error("sync interrupted");
          },
        })),
      ),
    ).toContain("sync interrupted");
    expect(failedCalls).toBe(1);

    let restartCalls = 0;
    const restarted = await syncSourceReplica(
      { authToken: "test", path, syncUrl: "libsql://source.invalid" },
      () => ({
        close: () => {},
        sync: async () => {
          restartCalls += 1;
          return { frame_no: 43, frames_synced: 1 };
        },
      }),
    );

    expect(restartCalls).toBe(1);
    expect(restarted.frameNo).toBe(43);
  });

  test("the explicit full-local rebuild is a convergent escape hatch", async () => {
    const path = join(temporaryDirectory(), "replica.db");
    createReplicaSchema(path);
    const result = await syncSourceReplica(
      {
        authToken: "test",
        forceRebuild: true,
        path,
        syncUrl: "libsql://source.invalid",
      },
      () => ({
        close: () => {},
        sync: async () => {
          createReplicaSchema(path);
          return { frame_no: 50, frames_synced: 50 };
        },
      }),
    );

    expect(result.rebuildCause).toBe("full_rebuild");
    expect(result.frameNo).toBe(50);
  });
});

describe("staged target publication", () => {
  test("upload, pre-cutover, and in-transaction failures leave the old live artifact intact", async () => {
    const generation = generationFixture(4);

    for (const failure of ["upload", "before", "during"] as const) {
      const { client } = targetFixture();
      let injected = false;

      if (failure === "upload") {
        client.beforeBatch = (statements, mode) => {
          if (
            !injected &&
            mode === "write" &&
            statements.some((statement) => statement.sql.includes("_device_mirror_stage_tracks"))
          ) {
            injected = true;
            throw new Error("upload interrupted");
          }
        };
      }

      const publication = publishDeviceGeneration(client, generation, 2, {
        beforeCutover:
          failure === "before"
            ? () => {
                throw new Error("before cutover");
              }
            : undefined,
        cutoverFailureAfterStatement: failure === "during" ? 3 : undefined,
      });

      expect(await rejectionMessage(publication)).not.toBe("");
      expect(liveTracks(client), failure).toEqual(["old-track"]);
      client.close();
    }
  });

  test("a lost response after cutover is a complete generation and restart is a no-op replay", async () => {
    const generation = generationFixture(3);
    const { client } = targetFixture();

    expect(
      await rejectionMessage(
        publishDeviceGeneration(client, generation, 2, {
          afterCutover: () => {
            throw new Error("cutover response lost");
          },
        }),
      ),
    ).toContain("cutover response lost");
    expect(liveTracks(client)).toEqual(["track-0000", "track-0001", "track-0002"]);

    const replay = await publishDeviceGeneration(client, generation, 2);
    expect(replay.replayed).toBe(true);
    expect(replay.writtenRows).toBe(0);
    expect(liveTracks(client)).toEqual(["track-0000", "track-0001", "track-0002"]);
    client.close();
  });

  test("detects a corrupt same-count stage, rebuilds it, and publishes verified rows", async () => {
    const generation = generationFixture(4);
    const { client } = targetFixture();
    let corrupted = false;
    client.database.run(`CREATE TABLE "_device_mirror_stage_tracks" (broken TEXT)`);

    client.beforeBatch = (statements, mode) => {
      if (
        !corrupted &&
        mode === "read" &&
        statements.some((statement) =>
          statement.sql.includes('SELECT count(*) AS count FROM "_device_mirror_stage_tracks"'),
        )
      ) {
        corrupted = true;
        client.database.run(
          `UPDATE "_device_mirror_stage_tracks" SET title = 'corrupt'
           WHERE track_id = 'track-0000'`,
        );
      }
    };

    const result = await publishDeviceGeneration(client, generation, 2);
    expect(corrupted).toBe(true);
    expect(result.stageRebuilt).toBe(true);
    expect(liveTracks(client)).toEqual(["track-0000", "track-0001", "track-0002", "track-0003"]);
    client.close();
  });

  test("keeps page memory fixed and database growth bounded at 1x, 2x, and 4x", async () => {
    const sizes: number[] = [];
    const incremental = targetFixture();

    for (const rows of [8, 16, 32]) {
      const generation = generationFixture(rows, `scale-${rows}`);
      const result = await publishDeviceGeneration(incremental.client, generation, 5);
      const fullRebuild = targetFixture(false);
      const rebuilt = await publishDeviceGeneration(fullRebuild.client, generation, 5);

      expect(result.maxBufferedRows).toBeLessThanOrEqual(5);
      expect(rebuilt.maxBufferedRows).toBeLessThanOrEqual(5);
      expect(liveTracks(incremental.client)).toEqual(liveTracks(fullRebuild.client));
      expect(liveTracks(incremental.client)).toHaveLength(rows);
      incremental.client.database.run("VACUUM");
      sizes.push(Bun.file(incremental.path).size);
      fullRebuild.client.close();
    }

    expect(sizes[1] ?? Infinity).toBeLessThanOrEqual((sizes[0] ?? 0) * 2);
    expect(sizes[2] ?? Infinity).toBeLessThanOrEqual((sizes[0] ?? 0) * 4);
    incremental.client.close();
  });
});
