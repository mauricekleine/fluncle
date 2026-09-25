import { Database, type SQLQueryBindings } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deriveDeviceDatabase } from "../../../../apps/web/scripts/derive-device-db";
import {
  createIntegrationDb,
  seedCatalogueTrack,
  seedEmbedding,
  seedTrack,
} from "../../../../apps/web/src/lib/server/integration-db";
import {
  calculateReplicaLagFrames,
  DEVICE_DELTA_MAX_ROWS,
  DEVICE_DELTA_MAX_SHARE,
  type DeviceGeneration,
  deviceDeltaCeiling,
  deviceRowDigest,
  type DeviceSqlValue,
  type DeviceTargetClient,
  inspectDeviceGeneration,
  isGenerationWatermark,
  type LibsqlStatement,
  DEFAULT_PUBLISH_INTERVAL_MS,
  publishCadence,
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
  aroundBatch?: (
    statements: readonly LibsqlStatement[],
    mode: "read" | "write",
    execute: (statements: readonly LibsqlStatement[], mode: "read" | "write") => QueryResult[],
  ) => QueryResult[];
  beforeBatch?: (statements: readonly LibsqlStatement[], mode: "read" | "write") => void;

  constructor(path: string) {
    this.database = new Database(path, { create: true, strict: true });
  }

  private executeBatch(
    statements: readonly LibsqlStatement[],
    mode: "read" | "write",
  ): QueryResult[] {
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

    return mode === "write" ? run.immediate() : run.deferred();
  }

  batch(statements: readonly LibsqlStatement[], mode: "read" | "write"): Promise<QueryResult[]> {
    this.beforeBatch?.(statements, mode);
    const execute = (delivered: readonly LibsqlStatement[], deliveredMode: "read" | "write") =>
      this.executeBatch(delivered, deliveredMode);

    return Promise.resolve(
      this.aroundBatch ? this.aroundBatch(statements, mode, execute) : execute(statements, mode),
    );
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

type TrackFixture = { id: string; title: string };

function trackGenerationFixture(tracks: readonly TrackFixture[], name: string): DeviceGeneration {
  const directory = temporaryDirectory();
  const path = join(directory, `${name}.db`);
  const database = new Database(path, { create: true, strict: true });
  createDeviceTables(database);

  for (const track of tracks) {
    insertTrack(database, track.id, track.title);
  }

  database
    .query("INSERT INTO device_sync_meta VALUES (?, ?, ?, ?)")
    .run(DEVICE_DB_SCHEMA_VERSION, "anchored", "2026-08-25T12:00:00.000Z", "source");
  database.run("VACUUM");
  database.close();
  return inspectDeviceGeneration(path);
}

function sequentialTracks(count: number): TrackFixture[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `track-${String(index).padStart(4, "0")}`,
    title: `Track ${index}`,
  }));
}

function recordCutoverBatch(client: LocalTargetClient): { statements: LibsqlStatement[] } {
  const record: { statements: LibsqlStatement[] } = { statements: [] };
  client.beforeBatch = (statements, mode) => {
    if (
      mode === "write" &&
      statements.some((statement) => statement.sql.includes("UPDATE device_sync_meta"))
    ) {
      record.statements = [...statements];
    }
  };
  return record;
}

function liveTitle(client: LocalTargetClient, trackId: string): string | undefined {
  const row = client.database.query("SELECT title FROM tracks WHERE track_id = ?").get(trackId) as {
    title: string;
  } | null;
  return row?.title ?? undefined;
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

function stageFootprint(client: LocalTargetClient): number {
  const stageTables = DEVICE_SOURCE_TABLES.map((table) => `_device_mirror_stage_${table}`);
  return [...stageTables, "_device_mirror_stage_checkpoint", "_device_mirror_stage_control"].reduce(
    (total, table) => {
      const row = client.database
        .query(`SELECT count(*) AS count FROM ${quoteDeviceDbIdentifier(table)}`)
        .get() as { count: number };
      return total + Number(row.count);
    },
    0,
  );
}

function createReplicaSchema(path: string): void {
  const database = new Database(path, { create: true });

  for (const table of [...DEVICE_SOURCE_TABLES, "track_embeddings"] as const) {
    database.run(`CREATE TABLE ${quoteDeviceDbIdentifier(table)} (id TEXT)`);
  }

  database.close();
}

async function scaledSourceFixture(scale: number): Promise<string> {
  const directory = temporaryDirectory();
  const source = join(directory, `source-${scale}.db`);
  const client = await createIntegrationDb({ url: `file:${source}` });
  const timestamp = "2026-08-25T12:00:00.000Z";

  await client.execute({
    args: ["label-parent", "Parent", "parent", timestamp, timestamp],
    sql: `INSERT INTO labels (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
  });

  for (let index = 0; index < scale; index += 1) {
    const suffix = String(index).padStart(2, "0");
    const certifiedTrackId = `certified-${suffix}`;
    const catalogueTrackId = `catalogue-${suffix}`;

    await seedTrack(client, {
      addedAt: timestamp,
      logId: `001.${String(index + 1).padStart(3, "0")}A`,
      title: `Certified ${index}`,
      trackId: certifiedTrackId,
    });
    await seedCatalogueTrack(client, {
      title: `Catalogue ${index}`,
      trackId: catalogueTrackId,
    });
    await seedEmbedding(client, catalogueTrackId, [0.1 + index, 0.2 + index]);

    await client.batch(
      [
        {
          args: [
            `label-child-${suffix}`,
            `Child ${index}`,
            `child-${suffix}`,
            "label-parent",
            timestamp,
            timestamp,
          ],
          sql: `INSERT INTO labels (id, name, slug, parent_label_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
        },
        {
          args: [`album-${suffix}`, `Album ${index}`, `album-${suffix}`, timestamp, timestamp],
          sql: `INSERT INTO albums (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
        },
        {
          args: [`artist-${suffix}`, `Artist ${index}`, `artist-${suffix}`, timestamp, timestamp],
          sql: `INSERT INTO artists (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
        },
        {
          args: [`album-${suffix}`, `label-child-${suffix}`, certifiedTrackId, catalogueTrackId],
          sql: `UPDATE tracks SET album_id = ?, label_id = ? WHERE track_id IN (?, ?)`,
        },
        {
          args: [certifiedTrackId, `artist-${suffix}`, 0],
          sql: `INSERT INTO track_artists (track_id, artist_id, position) VALUES (?, ?, ?)`,
        },
        {
          args: [catalogueTrackId, `artist-${suffix}`, 0],
          sql: `INSERT INTO track_artists (track_id, artist_id, position) VALUES (?, ?, ?)`,
        },
      ],
      "write",
    );
  }

  client.close();
  const database = new Database(source);
  database.run("PRAGMA wal_checkpoint(TRUNCATE)");
  database.close();
  return source;
}

function publicRows(database: Database): Record<string, unknown[]> {
  return Object.fromEntries(
    DEVICE_SOURCE_TABLES.map((table) => {
      const columns = DEVICE_DB_COLUMNS[table].map(quoteDeviceDbIdentifier).join(", ");
      const order = DEVICE_DB_PRIMARY_KEYS[table].map(quoteDeviceDbIdentifier).join(", ");
      return [
        table,
        database
          .query(`SELECT ${columns} FROM ${quoteDeviceDbIdentifier(table)} ORDER BY ${order}`)
          .all(),
      ];
    }),
  );
}

describe("the publish cadence gate", () => {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  test("a live replica younger than the interval is not republished", () => {
    const now = Date.parse("2026-01-01T12:00:00Z");
    const cadence = publishCadence("2026-01-01T09:00:00Z", now, DAY, false);
    expect(cadence.due).toBe(false);
    expect(cadence.ageMs).toBe(3 * HOUR);
  });
  test("a replica at or past the interval is due", () => {
    const now = Date.parse("2026-01-02T09:00:00Z");
    expect(publishCadence("2026-01-01T09:00:00Z", now, DAY, false).due).toBe(true);
  });
  test("the default interval keeps a live app's replica within the hour", () => {
    expect(DEFAULT_PUBLISH_INTERVAL_MS).toBe(HOUR);
  });
  test("a forced rebuild publishes regardless of age", () => {
    const now = Date.parse("2026-01-01T09:00:01Z");
    expect(publishCadence("2026-01-01T09:00:00Z", now, DAY, true).due).toBe(true);
  });
  test("a target that was never published (no parseable derived_at) is due", () => {
    expect(publishCadence("", Date.now(), DAY, false).due).toBe(true);
    expect(publishCadence("not a date", Date.now(), DAY, false).due).toBe(true);
  });
  test("a clock that reads before the last publish counts as age zero, not due", () => {
    const now = Date.parse("2026-01-01T08:00:00Z");
    const cadence = publishCadence("2026-01-01T09:00:00Z", now, DAY, false);
    expect(cadence.ageMs).toBe(0);
    expect(cadence.due).toBe(false);
  });
});

describe("embedded source replica", () => {
  test("reports zero post-sync lag only when the embedded sync result is measurable", () => {
    expect(calculateReplicaLagFrames({ frameNo: 43, framesSynced: 1 })).toBe(0);
    expect(calculateReplicaLagFrames({ frameNo: 43, framesSynced: 43 })).toBe(0);
    expect(calculateReplicaLagFrames({ frameNo: 43, framesSynced: 44 })).toBe(0);
    expect(calculateReplicaLagFrames({ frameNo: null, framesSynced: 0 })).toBeNull();
    expect(
      calculateReplicaLagFrames({ frameNo: Number.MAX_SAFE_INTEGER + 1, framesSynced: 1 }),
    ).toBeNull();
  });

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

  test("crosses replica sync, local derivation, and staged publication at 1x, 2x, and 4x", async () => {
    for (const scale of [1, 2, 4] as const) {
      const source = await scaledSourceFixture(scale);
      const replica = join(temporaryDirectory(), `replica-${scale}.db`);
      const rebuiltReplica = join(temporaryDirectory(), `rebuilt-replica-${scale}.db`);
      let syncCalls = 0;

      const synced = await syncSourceReplica(
        { authToken: "test", path: replica, syncUrl: "libsql://source.invalid" },
        () => ({
          close: () => {},
          sync: async () => {
            syncCalls += 1;
            copyFileSync(source, replica);
            return { frame_no: 100 + scale, frames_synced: 100 + scale };
          },
        }),
      );
      expect(syncCalls).toBe(1);
      expect(synced.rebuildCause).toBe("missing");
      expect(calculateReplicaLagFrames(synced)).toBe(0);

      const artifactPath = join(temporaryDirectory(), `device-${scale}.db`);
      const derivation = await deriveDeviceDatabase({
        cut: "anchored",
        out: artifactPath,
        source: replica,
      });
      const generation = inspectDeviceGeneration(artifactPath);
      const artifactRows = new Database(artifactPath, { readonly: true, strict: true });
      const semanticRows = publicRows(artifactRows);
      artifactRows.close();

      expect(derivation.bytes).toBe(generation.artifactBytes);
      expect(derivation.selectedTrackCount).toBe(scale * 2);
      expect(generation.rowCounts.tracks).toBe(scale * 2);

      const lastGoodBytes = readFileSync(artifactPath);
      expect(
        await rejectionMessage(
          deriveDeviceDatabase(
            { cut: "anchored", out: artifactPath, source: replica },
            {
              afterCopy: () => {
                throw new Error("synthetic rebuild interrupted");
              },
            },
          ),
        ),
      ).toContain("synthetic rebuild interrupted");
      expect(readFileSync(artifactPath)).toEqual(lastGoodBytes);

      const published = targetFixture();
      expect(
        await rejectionMessage(
          publishDeviceGeneration(published.client, generation, 2, {
            beforeCutover: () => {
              throw new Error("synthetic cutover interrupted");
            },
          }),
        ),
      ).toContain("synthetic cutover interrupted");
      expect(liveTracks(published.client)).toEqual(["old-track"]);

      const publication = await publishDeviceGeneration(published.client, generation, 2);
      expect(publication.published).toBe(true);
      expect(publication.restarted).toBe(true);
      expect(liveTracks(published.client)).toHaveLength(scale * 2);
      const publishedRows = publicRows(published.client.database);
      published.client.database.run("VACUUM");
      const publishedBytes = Bun.file(published.path).size;
      published.client.close();

      const rebuilt = await syncSourceReplica(
        {
          authToken: "test",
          forceRebuild: true,
          path: rebuiltReplica,
          syncUrl: "libsql://source.invalid",
        },
        () => ({
          close: () => {},
          sync: async () => {
            copyFileSync(source, rebuiltReplica);
            return { frame_no: 100 + scale, frames_synced: 100 + scale };
          },
        }),
      );
      expect(rebuilt.rebuildCause).toBe("full_rebuild");

      const rebuiltArtifactPath = join(temporaryDirectory(), `device-rebuilt-${scale}.db`);
      const rebuiltDerivation = await deriveDeviceDatabase({
        cut: "anchored",
        out: rebuiltArtifactPath,
        source: rebuiltReplica,
      });
      const rebuiltGeneration = inspectDeviceGeneration(rebuiltArtifactPath);
      const rebuiltArtifact = new Database(rebuiltArtifactPath, {
        readonly: true,
        strict: true,
      });
      const rebuiltSemanticRows = publicRows(rebuiltArtifact);
      rebuiltArtifact.close();

      expect(rebuiltDerivation.bytes).toBe(derivation.bytes);
      expect(rebuiltDerivation.sourceWatermark).toBe(derivation.sourceWatermark);
      expect(rebuiltGeneration.fingerprint).toBe(generation.fingerprint);
      expect(rebuiltGeneration.rowCounts).toEqual(generation.rowCounts);
      expect(rebuiltSemanticRows).toEqual(semanticRows);

      const fullTarget = targetFixture();
      const fullPublication = await publishDeviceGeneration(
        fullTarget.client,
        rebuiltGeneration,
        2,
      );
      expect(fullPublication.published).toBe(true);
      expect(fullPublication.writtenRows).toBe(publication.writtenRows);
      expect(publicRows(fullTarget.client.database)).toEqual(publishedRows);
      fullTarget.client.database.run("VACUUM");
      expect(Bun.file(fullTarget.path).size).toBe(publishedBytes);
      fullTarget.client.close();
    }
  }, 30_000);
});

describe("staged target publication", () => {
  test("duplicate and out-of-order staged deltas converge through derivation and publication", async () => {
    const source = await scaledSourceFixture(2);
    const artifactPath = join(temporaryDirectory(), "redelivery-generation.db");
    await deriveDeviceDatabase({ cut: "anchored", out: artifactPath, source });
    const generation = inspectDeviceGeneration(artifactPath);
    const artifact = new Database(artifactPath, { readonly: true, strict: true });
    const expectedRows = publicRows(artifact);
    artifact.close();
    const { client } = targetFixture();
    let firstTrackPage: readonly LibsqlStatement[] | null = null;
    let duplicateDeliveries = 0;
    let duplicateCheckpointRejected = false;
    let outOfOrderDeliveries = 0;
    let staleCheckpointRejected = false;

    client.aroundBatch = (statements, mode, execute) => {
      const isTrackPage =
        mode === "write" &&
        statements.some((statement) =>
          statement.sql.includes('INSERT INTO "_device_mirror_stage_tracks"'),
        );

      if (!isTrackPage) {
        return execute(statements, mode);
      }
      if (!firstTrackPage) {
        firstTrackPage = statements;
        const accepted = execute(statements, mode);
        const duplicate = execute(statements, mode);
        duplicateCheckpointRejected = duplicate.at(-1)?.affectedRows === 0;
        duplicateDeliveries += 1;
        return accepted;
      }
      if (outOfOrderDeliveries === 0) {
        const accepted = execute(statements, mode);
        const stale = execute(firstTrackPage, "write");
        staleCheckpointRejected = stale.at(-1)?.affectedRows === 0;
        outOfOrderDeliveries += 1;
        return accepted;
      }

      return execute(statements, mode);
    };

    const result = await publishDeviceGeneration(client, generation, 2);
    expect(duplicateDeliveries).toBe(1);
    expect(duplicateCheckpointRejected).toBe(true);
    expect(outOfOrderDeliveries).toBe(1);
    expect(staleCheckpointRejected).toBe(true);
    expect(result.published).toBe(true);
    expect(result.backlogRows).toBeGreaterThan(0);
    expect(publicRows(client.database)).toEqual(expectedRows);
    expect(client.database.query("SELECT source_watermark FROM device_sync_meta").get()).toEqual({
      source_watermark: generation.fingerprint,
    });
    expect(stageFootprint(client)).toBe(0);
    client.close();
  });

  test.each(["upload", "before", "during"] as const)(
    "failure at %s leaves the old live artifact intact",
    async (failure) => {
      const generation = generationFixture(4);
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
    },
  );

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

  test("reclaims a published stage only after last-good validation and converges on replay", async () => {
    const generation = generationFixture(4);
    const { client } = targetFixture();
    let interruptedReclamation = false;
    client.beforeBatch = (statements, mode) => {
      if (
        !interruptedReclamation &&
        mode === "write" &&
        statements.some((statement) =>
          statement.sql.includes('DELETE FROM "_device_mirror_stage_control"'),
        )
      ) {
        interruptedReclamation = true;
        throw new Error("stage reclamation interrupted");
      }
    };

    const first = await publishDeviceGeneration(client, generation, 2);
    const lastGoodRows = publicRows(client.database);
    expect(interruptedReclamation).toBe(true);
    expect(first.published).toBe(true);
    expect(first.stageRetained).toBe(true);
    expect(liveTracks(client)).toEqual(["track-0000", "track-0001", "track-0002", "track-0003"]);
    expect(stageFootprint(client)).toBeGreaterThan(0);

    client.beforeBatch = undefined;
    const replay = await publishDeviceGeneration(client, generation, 2);
    expect(replay.replayed).toBe(true);
    expect(replay.stageRetained).toBe(false);
    expect(publicRows(client.database)).toEqual(lastGoodRows);
    expect(stageFootprint(client)).toBe(0);
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
  }, 30_000);
});

describe("the diff-based publish", () => {
  const BASE = 100;

  async function publishedTarget(generation: DeviceGeneration): Promise<LocalTargetClient> {
    const { client } = targetFixture(false);
    const first = await publishDeviceGeneration(client, generation, 5);
    expect(first.publishPath).toBe("rewrite");
    expect(first.rewriteReason).toBe("no_prior_generation");
    return client;
  }

  test("the delta ceiling is a share of the generation with an absolute cap", () => {
    expect(DEVICE_DELTA_MAX_SHARE).toBe(0.05);
    expect(deviceDeltaCeiling(100)).toBe(5);
    expect(deviceDeltaCeiling(97_000)).toBe(4_850);
    expect(deviceDeltaCeiling(10_000_000)).toBe(DEVICE_DELTA_MAX_ROWS);
    expect(deviceDeltaCeiling(0)).toBe(1);
  });

  test("only a content fingerprint counts as a prior generation to diff against", () => {
    expect(isGenerationWatermark(`sha256:${"a".repeat(64)}`)).toBe(true);
    expect(isGenerationWatermark("old-fingerprint")).toBe(false);
    expect(isGenerationWatermark("")).toBe(false);
    expect(isGenerationWatermark(`sha256:${"a".repeat(63)}`)).toBe(false);
  });

  test("the row digest is derived from the shipped column list, so a value change moves it", () => {
    const row = Object.fromEntries(
      DEVICE_DB_COLUMNS.tracks.map((column) => [column, null]),
    ) as Record<string, DeviceSqlValue>;
    row.track_id = "track-0000";
    row.title = "Track 0";

    const before = deviceRowDigest("tracks", row);
    expect(deviceRowDigest("tracks", { ...row, title: "Track 0" })).toBe(before);
    expect(deviceRowDigest("tracks", { ...row, title: "Track 0 (VIP)" })).not.toBe(before);

    for (const column of DEVICE_DB_COLUMNS.tracks) {
      expect(deviceRowDigest("tracks", { ...row, [column]: "moved" })).not.toBe(before);
    }
  });

  test("a first publish with no prior generation takes the rewrite path", async () => {
    const generation = trackGenerationFixture(sequentialTracks(BASE), "bootstrap");
    const { client } = targetFixture(false);

    const result = await publishDeviceGeneration(client, generation, 5);
    expect(result.publishPath).toBe("rewrite");
    expect(result.rewriteReason).toBe("no_prior_generation");
    expect(result.deltaRows).toBeNull();
    expect(result.stagedRows).toBe(BASE);
    expect(liveTracks(client)).toHaveLength(BASE);
    expect(stageFootprint(client)).toBe(0);
    client.close();
  }, 30_000);

  test("a second publish writes only the drifted rows, one statement each", async () => {
    const tracks = sequentialTracks(BASE);
    const client = await publishedTarget(trackGenerationFixture(tracks, "delta-base"));

    const drifted = tracks.map((track, index) =>
      index < 3 ? { ...track, title: `${track.title} (VIP)` } : track,
    );
    const next = trackGenerationFixture(drifted, "delta-next");
    const cutover = recordCutoverBatch(client);

    const result = await publishDeviceGeneration(client, next, 5);
    expect(result.publishPath).toBe("delta");
    expect(result.rewriteReason).toBeNull();
    expect(result.deltaRows).toBe(3);
    expect(result.stagedRows).toBe(0);

    expect(cutover.statements).toHaveLength(4);
    expect(result.writtenRows).toBe(3);
    expect(liveTitle(client, "track-0000")).toBe("Track 0 (VIP)");
    expect(liveTitle(client, "track-0003")).toBe("Track 3");
    expect(liveTracks(client)).toHaveLength(BASE);
    expect(stageFootprint(client)).toBe(0);
    expect(client.database.query("SELECT source_watermark FROM device_sync_meta").get()).toEqual({
      source_watermark: next.fingerprint,
    });
    client.close();
  }, 30_000);

  test("a deleted source row is deleted on the target and an added one is inserted", async () => {
    const tracks = sequentialTracks(BASE);
    const client = await publishedTarget(trackGenerationFixture(tracks, "removal-base"));

    const next = trackGenerationFixture(
      [...tracks.slice(1), { id: "track-9999", title: "Newcomer" }],
      "removal-next",
    );
    const cutover = recordCutoverBatch(client);

    const result = await publishDeviceGeneration(client, next, 5);
    expect(result.publishPath).toBe("delta");
    expect(result.deltaRows).toBe(2);

    expect(cutover.statements).toHaveLength(3);
    expect(liveTracks(client)).not.toContain("track-0000");
    expect(liveTracks(client)).toContain("track-9999");
    expect(liveTracks(client)).toHaveLength(BASE);
    client.close();
  }, 30_000);

  test("an identical generation republished after a watermark reset writes only the metadata", async () => {
    const tracks = sequentialTracks(BASE);
    const generation = trackGenerationFixture(tracks, "idempotent");
    const client = await publishedTarget(generation);

    const same = trackGenerationFixture(tracks, "idempotent-again");
    expect(same.fingerprint).toBe(generation.fingerprint);
    client.database.run("UPDATE device_sync_meta SET source_watermark = ?", [
      `sha256:${"0".repeat(64)}`,
    ]);
    const cutover = recordCutoverBatch(client);

    const result = await publishDeviceGeneration(client, same, 5);
    expect(result.publishPath).toBe("delta");
    expect(result.deltaRows).toBe(0);
    expect(result.writtenRows).toBe(0);
    expect(cutover.statements).toHaveLength(1);
    client.close();
  }, 30_000);

  test("a stale stage schema is an artifact-version change and forces a rewrite", async () => {
    const tracks = sequentialTracks(BASE);
    const client = await publishedTarget(trackGenerationFixture(tracks, "version-base"));

    client.database.run(`DROP TABLE "_device_mirror_stage_tracks"`);
    client.database.run(`CREATE TABLE "_device_mirror_stage_tracks" (stale TEXT)`);

    const next = trackGenerationFixture(
      tracks.map((track, index) => (index === 0 ? { ...track, title: "Moved" } : track)),
      "version-next",
    );
    const result = await publishDeviceGeneration(client, next, 5);
    expect(result.publishPath).toBe("rewrite");
    expect(result.rewriteReason).toBe("schema_change");
    expect(result.stagedRows).toBe(BASE);
    expect(liveTitle(client, "track-0000")).toBe("Moved");
    client.close();
  }, 30_000);

  test("a delta above the ceiling forces a rewrite instead of one huge transaction", async () => {
    const tracks = sequentialTracks(BASE);
    const client = await publishedTarget(trackGenerationFixture(tracks, "threshold-base"));

    const ceiling = deviceDeltaCeiling(BASE);
    const next = trackGenerationFixture(
      tracks.map((track, index) =>
        index <= ceiling ? { ...track, title: `${track.title} (VIP)` } : track,
      ),
      "threshold-next",
    );
    const result = await publishDeviceGeneration(client, next, 5);
    expect(result.publishPath).toBe("rewrite");
    expect(result.rewriteReason).toBe("delta_over_threshold");
    expect(result.deltaRows).toBeNull();
    expect(result.stagedRows).toBe(BASE);
    expect(liveTitle(client, "track-0000")).toBe("Track 0 (VIP)");
    expect(liveTitle(client, `track-${String(ceiling + 1).padStart(4, "0")}`)).toBe(
      `Track ${ceiling + 1}`,
    );
    client.close();
  }, 30_000);

  test("a delta interrupted before its transaction leaves the last generation live and converges", async () => {
    const tracks = sequentialTracks(BASE);
    const base = trackGenerationFixture(tracks, "interrupt-base");
    const client = await publishedTarget(base);
    const lastGood = publicRows(client.database);

    const next = trackGenerationFixture(
      tracks.map((track, index) => (index === 0 ? { ...track, title: "Half applied" } : track)),
      "interrupt-next",
    );

    expect(
      await rejectionMessage(
        publishDeviceGeneration(client, next, 5, {
          beforeCutover: () => {
            throw new Error("delta interrupted");
          },
        }),
      ),
    ).toContain("delta interrupted");
    expect(publicRows(client.database)).toEqual(lastGood);
    expect(client.database.query("SELECT source_watermark FROM device_sync_meta").get()).toEqual({
      source_watermark: base.fingerprint,
    });

    const converged = await publishDeviceGeneration(client, next, 5);
    expect(converged.publishPath).toBe("delta");
    expect(converged.deltaRows).toBe(1);
    expect(liveTitle(client, "track-0000")).toBe("Half applied");
    client.close();
  }, 30_000);

  test("a delta whose response is lost after commit replays as a complete generation", async () => {
    const tracks = sequentialTracks(BASE);
    const client = await publishedTarget(trackGenerationFixture(tracks, "lost-base"));
    const next = trackGenerationFixture(
      tracks.map((track, index) => (index === 0 ? { ...track, title: "Committed" } : track)),
      "lost-next",
    );

    expect(
      await rejectionMessage(
        publishDeviceGeneration(client, next, 5, {
          afterCutover: () => {
            throw new Error("delta response lost");
          },
        }),
      ),
    ).toContain("delta response lost");
    expect(liveTitle(client, "track-0000")).toBe("Committed");

    const replay = await publishDeviceGeneration(client, next, 5);
    expect(replay.publishPath).toBe("replay");
    expect(replay.writtenRows).toBe(0);
    expect(liveTitle(client, "track-0000")).toBe("Committed");
    client.close();
  }, 30_000);

  test("the delta walk reads the target one bounded page at a time", async () => {
    const tracks = sequentialTracks(BASE);
    const client = await publishedTarget(trackGenerationFixture(tracks, "paged-base"));
    const next = trackGenerationFixture(
      tracks.map((track, index) => (index === 42 ? { ...track, title: "Paged" } : track)),
      "paged-next",
    );

    const result = await publishDeviceGeneration(client, next, 5);
    expect(result.publishPath).toBe("delta");
    expect(result.maxBufferedRows).toBeLessThanOrEqual(5);
    expect(liveTitle(client, "track-0042")).toBe("Paged");
    client.close();
  }, 30_000);

  test("a real derived generation republishes its own drift as a delta", async () => {
    const source = await scaledSourceFixture(4);
    const artifactPath = join(temporaryDirectory(), "derived-delta-base.db");
    await deriveDeviceDatabase({ cut: "anchored", out: artifactPath, source });
    const generation = inspectDeviceGeneration(artifactPath);
    const client = await publishedTarget(generation);

    const sourceDatabase = new Database(source, { strict: true });
    sourceDatabase.run("UPDATE tracks SET title = 'Certified 0 (VIP)' WHERE track_id = ?", [
      "certified-00",
    ]);
    sourceDatabase.run("PRAGMA wal_checkpoint(TRUNCATE)");
    sourceDatabase.close();

    const nextPath = join(temporaryDirectory(), "derived-delta-next.db");
    await deriveDeviceDatabase({ cut: "anchored", out: nextPath, source });
    const next = inspectDeviceGeneration(nextPath);
    expect(next.fingerprint).not.toBe(generation.fingerprint);

    const result = await publishDeviceGeneration(client, next, 5);
    expect(result.publishPath).toBe("delta");
    expect(result.deltaRows).toBe(1);
    expect(result.writtenRows).toBe(1);

    const artifact = new Database(nextPath, { readonly: true, strict: true });
    const expectedRows = publicRows(artifact);
    artifact.close();
    expect(publicRows(client.database)).toEqual(expectedRows);
    client.close();
  }, 30_000);
});
