import { Database, type SQLQueryBindings } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDatabaseAdmissionPhaseAsync } from "./database-admission-phase";
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
  deviceMirrorTargetClient,
  inspectDeviceGeneration,
  isGenerationWatermark,
  type LibsqlStatement,
  LibsqlHttpClient,
  main,
  DEFAULT_PUBLISH_INTERVAL_MS,
  publishCadence,
  publishDeviceGeneration,
  type QueryResult,
  finalizeSourceReplica,
  prepareSourceReplica,
  syncSourceReplica,
  syncSourceReplicaAdmitted,
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

function admittedMirrorRig(metadataCorruptOnce = false) {
  const directory = temporaryDirectory();
  const runner = join(directory, "admission-runner.sh");
  const timeline = join(directory, "timeline");
  const lease = join(directory, "lease");
  const replicaFixture = join(directory, "replica-fixture.db");
  const metadataMarker = join(directory, "metadata-once");
  const yieldMarker = join(directory, "yield-source-sync");
  createReplicaSchema(replicaFixture);
  if (metadataCorruptOnce) {
    writeFileSync(metadataMarker, "retry");
  }
  writeFileSync(
    runner,
    `#!/usr/bin/env bash
set -uo pipefail
[ "\${1:-}" = phase ] || exit 2
[ "\${2:-}" = fluncle-device-mirror ] || exit 2
shift 2
if [ "\${1:-}" = -- ]; then shift; fi
[ "\${4:-}" = source-sync ] || exit 2
shift 4
[ "\${1:-}" = --replica-path ] || exit 2
if [ -f "$MIRROR_YIELD_SOURCE" ]; then
  printf '{"event":"database.admission.runner","yield_reason":"queue"}\\n' >&2
  exit 75
fi
mkdir "$MIRROR_LEASE_DIR" || exit 2
printf 'acquire\\n' >> "$MIRROR_TIMELINE"
if [ -f "$MIRROR_METADATA_ONCE" ]; then
  rm "$MIRROR_METADATA_ONCE"
  printf '{"kind":"metadata-corrupt"}\\n'
  rmdir "$MIRROR_LEASE_DIR"
  printf 'release\\n' >> "$MIRROR_TIMELINE"
  exit 0
fi
cp "$MIRROR_REPLICA_FIXTURE" "$2"
printf '{"frameNo":1,"framesSynced":1,"kind":"synced"}\\n'
rmdir "$MIRROR_LEASE_DIR"
printf 'release\\n' >> "$MIRROR_TIMELINE"
`,
  );
  chmodSync(runner, 0o755);
  const environment = {
    DATABASE_ADMISSION_RUNNER: runner,
    DEVICE_MIRROR_LOCK_DIR: join(directory, "mirror-lock"),
    DEVICE_MIRROR_PAGE_SIZE: "2",
    DEVICE_MIRROR_STATE_DIR: join(directory, "state"),
    DEVICE_TURSO_AUTH_TOKEN: "test",
    DEVICE_TURSO_DATABASE_URL: "libsql://target.invalid",
    MIRROR_LEASE_DIR: lease,
    MIRROR_METADATA_ONCE: metadataMarker,
    MIRROR_REPLICA_FIXTURE: replicaFixture,
    MIRROR_TIMELINE: timeline,
    MIRROR_YIELD_SOURCE: yieldMarker,
    TURSO_AUTH_TOKEN: "test",
    TURSO_DATABASE_URL: "libsql://source.invalid",
  };
  const previous = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]]),
  );

  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return {
    lease,
    lock: environment.DEVICE_MIRROR_LOCK_DIR,
    restore: () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    },
    timeline,
    yieldMarker,
  };
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

describe("the phased mirror service", () => {
  test("async phase runner preserves yield reason and one retry", async () => {
    const directory = temporaryDirectory();
    const runner = join(directory, "retry-admission-runner.sh");
    const attempts = join(directory, "attempts");
    writeFileSync(
      runner,
      `#!/usr/bin/env bash
set -uo pipefail
printf 'attempt\\n' >> "$MIRROR_PHASE_ATTEMPTS"
if [ "$(wc -l < "$MIRROR_PHASE_ATTEMPTS")" -eq 1 ]; then
  printf '{"event":"database.admission.runner","yield_reason":"queue"}\\n' >&2
  exit 75
fi
printf 'synced\\n'
`,
    );
    chmodSync(runner, 0o755);
    const previousRunner = process.env.DATABASE_ADMISSION_RUNNER;
    const previousAttempts = process.env.MIRROR_PHASE_ATTEMPTS;
    process.env.DATABASE_ADMISSION_RUNNER = runner;
    process.env.MIRROR_PHASE_ATTEMPTS = attempts;

    try {
      expect(
        await runDatabaseAdmissionPhaseAsync({
          command: ["true"],
          owner: "fluncle-device-mirror",
          yieldRetries: 1,
        }),
      ).toEqual({ attempts: 2, kind: "completed", stdout: "synced\n" });
      expect(readFileSync(attempts, "utf8")).toBe("attempt\nattempt\n");
    } finally {
      if (previousRunner === undefined) {
        delete process.env.DATABASE_ADMISSION_RUNNER;
      } else {
        process.env.DATABASE_ADMISSION_RUNNER = previousRunner;
      }
      if (previousAttempts === undefined) {
        delete process.env.MIRROR_PHASE_ATTEMPTS;
      } else {
        process.env.MIRROR_PHASE_ATTEMPTS = previousAttempts;
      }
    }
  });

  test("source sync keeps the mirror lock alive and SIGTERM responsive", async () => {
    const directory = temporaryDirectory();
    const runner = join(directory, "slow-admission-runner.sh");
    const harness = join(directory, "mirror-harness.ts");
    const started = join(directory, "phase-started");
    const stopping = join(directory, "phase-stopping");
    const stopped = join(directory, "phase-stopped");
    const stoppedLockState = join(directory, "stopped-lock-state");
    const lock = join(directory, "mirror-lock");
    writeFileSync(
      runner,
      `#!/usr/bin/env bash
set -uo pipefail
touch "$MIRROR_PHASE_STARTED"
sleep 10 &
sleep_pid=$!
trap 'touch "$MIRROR_PHASE_STOPPING"; sleep 0.25; kill "$sleep_pid" 2>/dev/null || true; wait "$sleep_pid" 2>/dev/null || true; if [ -d "$MIRROR_LOCK_DIR" ]; then printf held > "$MIRROR_STOP_LOCK_STATE"; else printf released > "$MIRROR_STOP_LOCK_STATE"; fi; touch "$MIRROR_PHASE_STOPPED"; exit 143' TERM INT HUP
wait "$sleep_pid"
`,
    );
    chmodSync(runner, 0o755);
    writeFileSync(
      harness,
      `import { main } from ${JSON.stringify(join(import.meta.dir, "device-mirror.ts"))};
import { DEVICE_DB_SCHEMA_VERSION } from ${JSON.stringify(join(import.meta.dir, "device-db-derivation.ts"))};
await main({
  createTarget: () => ({
    batch: async () => [{
      affectedRows: 0,
      columns: ["schema_version", "cut_name", "derived_at", "source_watermark"],
      rows: [[DEVICE_DB_SCHEMA_VERSION, "anchored", "2020-01-01T00:00:00.000Z", "old"]],
    }],
  }),
});
`,
    );
    const child = Bun.spawn([process.execPath, harness], {
      env: {
        ...process.env,
        DATABASE_ADMISSION_RUNNER: runner,
        DEVICE_MIRROR_LOCK_DIR: lock,
        DEVICE_MIRROR_LOCK_HEARTBEAT_MS: "30",
        DEVICE_MIRROR_LOCK_STALE_MS: "100",
        DEVICE_MIRROR_STATE_DIR: join(directory, "state"),
        DEVICE_TURSO_AUTH_TOKEN: "test",
        DEVICE_TURSO_DATABASE_URL: "libsql://target.invalid",
        MIRROR_LOCK_DIR: lock,
        MIRROR_PHASE_STARTED: started,
        MIRROR_PHASE_STOPPED: stopped,
        MIRROR_PHASE_STOPPING: stopping,
        MIRROR_STOP_LOCK_STATE: stoppedLockState,
        TURSO_AUTH_TOKEN: "test",
        TURSO_DATABASE_URL: "libsql://source.invalid",
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    const waitUntil = async (predicate: () => boolean) => {
      const deadline = Date.now() + 2_000;
      while (!predicate() && Date.now() < deadline) {
        await Bun.sleep(10);
      }
      expect(predicate()).toBe(true);
    };

    try {
      await waitUntil(() => existsSync(started) && existsSync(lock));
      const initialMtime = statSync(lock).mtimeMs;
      await Bun.sleep(180);
      expect(existsSync(stopped)).toBe(false);
      expect(statSync(lock).mtimeMs).toBeGreaterThan(initialMtime + 100);

      const signalledAt = Date.now();
      child.kill("SIGTERM");
      await waitUntil(() => existsSync(stopping));
      expect(existsSync(lock)).toBe(true);
      await Bun.sleep(80);
      expect(existsSync(lock)).toBe(true);
      expect(existsSync(stopped)).toBe(false);
      const exitCode = await Promise.race([child.exited, Bun.sleep(2_000).then(() => -1)]);
      expect(exitCode).toBe(143);
      expect(Date.now() - signalledAt).toBeLessThan(2_000);
      await waitUntil(() => !existsSync(lock) && existsSync(stopped));
      expect(readFileSync(stoppedLockState, "utf8")).toBe("held");
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
  }, 10_000);

  test("SIGTERM between local preparation and source admission starts no new phase", async () => {
    const directory = temporaryDirectory();
    const runner = join(directory, "unexpected-admission-runner.sh");
    const harness = join(directory, "between-phases-harness.ts");
    const signalLockState = join(directory, "signal-lock-state");
    const phaseStarted = join(directory, "phase-started");
    const lock = join(directory, "mirror-lock");
    writeFileSync(
      runner,
      `#!/usr/bin/env bash
touch "$MIRROR_PHASE_STARTED"
sleep 0.2
`,
    );
    chmodSync(runner, 0o755);
    writeFileSync(
      harness,
      `import { existsSync, writeFileSync } from "node:fs";
import { main, syncSourceReplicaAdmitted } from ${JSON.stringify(join(import.meta.dir, "device-mirror.ts"))};
import { DEVICE_DB_SCHEMA_VERSION } from ${JSON.stringify(join(import.meta.dir, "device-db-derivation.ts"))};
await main({
  createTarget: () => ({
    batch: async () => [{
      affectedRows: 0,
      columns: ["schema_version", "cut_name", "derived_at", "source_watermark"],
      rows: [[DEVICE_DB_SCHEMA_VERSION, "anchored", "2020-01-01T00:00:00.000Z", "old"]],
    }],
  }),
  syncSource: (path, forceRebuild) => syncSourceReplicaAdmitted(path, forceRebuild, undefined, {
    finalize: async () => {},
    prepare: async () => {
      writeFileSync(process.env.MIRROR_SIGNAL_LOCK_STATE ?? "", existsSync(process.env.DEVICE_MIRROR_LOCK_DIR ?? "") ? "held" : "released");
      process.emit("SIGTERM");
      return "missing";
    },
  }),
});
`,
    );
    const child = Bun.spawn([process.execPath, harness], {
      env: {
        ...process.env,
        DATABASE_ADMISSION_RUNNER: runner,
        DEVICE_MIRROR_LOCK_DIR: lock,
        DEVICE_MIRROR_STATE_DIR: join(directory, "state"),
        DEVICE_TURSO_AUTH_TOKEN: "test",
        DEVICE_TURSO_DATABASE_URL: "libsql://target.invalid",
        MIRROR_PHASE_STARTED: phaseStarted,
        MIRROR_SIGNAL_LOCK_STATE: signalLockState,
        TURSO_AUTH_TOKEN: "test",
        TURSO_DATABASE_URL: "libsql://source.invalid",
      },
      stderr: "pipe",
      stdout: "pipe",
    });

    try {
      const exitCode = await Promise.race([child.exited, Bun.sleep(2_000).then(() => -1)]);
      expect(exitCode).toBe(143);
      expect(readFileSync(signalLockState, "utf8")).toBe("held");
      expect(existsSync(phaseStarted)).toBe(false);
      expect(existsSync(lock)).toBe(false);
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
  }, 10_000);

  test("invalid heartbeat interval does not leave an acquired mirror lock", async () => {
    const rig = admittedMirrorRig();
    const previous = process.env.DEVICE_MIRROR_LOCK_HEARTBEAT_MS;
    process.env.DEVICE_MIRROR_LOCK_HEARTBEAT_MS = "invalid";

    try {
      const summary = await main();
      expect(summary.ok).toBe(false);
      expect(summary.error).toBe("DEVICE_MIRROR_LOCK_HEARTBEAT_MS must be a positive integer");
      expect(existsSync(rig.lock)).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.DEVICE_MIRROR_LOCK_HEARTBEAT_MS;
      } else {
        process.env.DEVICE_MIRROR_LOCK_HEARTBEAT_MS = previous;
      }
      rig.restore();
    }
  });

  test("the derived target uses direct database calls outside the primary admission lane", () => {
    expect(deviceMirrorTargetClient("libsql://target.invalid", "test")).toBeInstanceOf(
      LibsqlHttpClient,
    );
  });

  test("slow local replica validation and checkpoint let a sibling acquire the lane", async () => {
    const rig = admittedMirrorRig();
    const path = join(temporaryDirectory(), "local-work.db");
    const localPhases: string[] = [];
    const assertSiblingAcquires = async (phase: string) => {
      await Bun.sleep(80);
      mkdirSync(rig.lease);
      localPhases.push(phase);
      rmdirSync(rig.lease);
    };

    try {
      const result = await syncSourceReplicaAdmitted(path, false, undefined, {
        finalize: async (replicaPath) => {
          await assertSiblingAcquires("before-checkpoint");
          await finalizeSourceReplica(replicaPath);
          await assertSiblingAcquires("after-checkpoint");
        },
        prepare: async (replicaPath, forceRebuild) => {
          await assertSiblingAcquires("before-validation");
          const cause = await prepareSourceReplica(replicaPath, forceRebuild);
          await assertSiblingAcquires("after-validation");
          return cause;
        },
      });

      expect(result.frameNo).toBe(1);
      expect(result.rebuildCause).toBe("missing");
      expect(localPhases).toEqual([
        "before-validation",
        "after-validation",
        "before-checkpoint",
        "after-checkpoint",
      ]);
      expect(readFileSync(rig.timeline, "utf8")).toBe("acquire\nrelease\n");
    } finally {
      rig.restore();
    }
  }, 30_000);

  test("remote metadata corruption rebuilds local files between two admitted sync attempts", async () => {
    const rig = admittedMirrorRig(true);
    const path = join(temporaryDirectory(), "metadata-retry.db");
    createReplicaSchema(path);

    try {
      const result = await syncSourceReplicaAdmitted(path, false);
      expect(result.rebuildCause).toBe("replica_metadata_corrupt");
      expect(result.frameNo).toBe(1);
      expect(readFileSync(rig.timeline, "utf8")).toBe("acquire\nrelease\nacquire\nrelease\n");
    } finally {
      rig.restore();
    }
  }, 30_000);

  test("a sibling acquires the primary lane during slow derivation while target batches stay outside it", async () => {
    const generation = trackGenerationFixture(sequentialTracks(8), "phase-success");
    const { client } = targetFixture();
    const rig = admittedMirrorRig();
    let siblingAcquired = false;
    let targetBatches = 0;
    client.aroundBatch = (statements, mode, execute) => {
      expect(existsSync(rig.lease)).toBe(false);
      targetBatches += 1;
      return execute(statements, mode);
    };

    try {
      const summary = await main({
        createTarget: () => client,
        derive: async (_source, out) => {
          await Bun.sleep(80);
          mkdirSync(rig.lease);
          siblingAcquired = true;
          rmdirSync(rig.lease);
          appendFileSync(rig.timeline, "derive\n");
          copyFileSync(generation.path, out);
          return {
            bytes: generation.artifactBytes,
            derivedAt: generation.derivedAt,
            elapsedMs: 80,
            preVacuumBytes: generation.artifactBytes,
          };
        },
      });

      expect(summary.validation).toBe("verified");
      expect(summary.publishPath).toBe("rewrite");
      expect(siblingAcquired).toBe(true);
      expect(targetBatches).toBeGreaterThan(2);
      expect(readFileSync(rig.timeline, "utf8")).toBe("acquire\nrelease\nderive\n");
      expect(existsSync(rig.lease)).toBe(false);
      expect(liveTracks(client)).toHaveLength(8);
    } finally {
      client.close();
      rig.restore();
    }
  }, 30_000);

  test("a tick that finds the lock held reports a failed, visible skip", async () => {
    const rig = admittedMirrorRig();
    mkdirSync(rig.lock);

    try {
      const summary = await main({ createTarget: () => targetFixture().client });

      expect(summary).toMatchObject({
        gateState: "locked",
        ok: false,
        reason: "lock_held",
        validation: "locked",
      });
    } finally {
      rmdirSync(rig.lock);
      rig.restore();
    }
  });

  test("a source-sync phase yield after an interrupted stage leaves the old generation live", async () => {
    const generation = trackGenerationFixture(sequentialTracks(8), "phase-yield");
    const { client } = targetFixture();
    const rig = admittedMirrorRig();
    let stagePages = 0;
    client.aroundBatch = (statements, mode, execute) => {
      if (
        mode === "write" &&
        statements.some((statement) =>
          statement.sql.startsWith('INSERT INTO "_device_mirror_stage_tracks"'),
        )
      ) {
        stagePages += 1;
        if (stagePages === 2) {
          throw new Error("Stage page interrupted before cutover");
        }
      }
      return execute(statements, mode);
    };
    const runtime = {
      createTarget: () => client,
      derive: async (_source: string, out: string) => {
        copyFileSync(generation.path, out);
        return {
          bytes: generation.artifactBytes,
          derivedAt: generation.derivedAt,
          elapsedMs: 0,
          preVacuumBytes: generation.artifactBytes,
        };
      },
    };

    try {
      const interrupted = await main(runtime);
      expect(interrupted.validation).toBe("failed");
      expect(stagePages).toBe(2);
      expect(liveTracks(client)).toEqual(["old-track"]);
      expect(
        client.database.query('SELECT count(*) AS count FROM "_device_mirror_stage_tracks"').get(),
      ).toEqual({ count: 2 });

      client.aroundBatch = undefined;
      writeFileSync(rig.yieldMarker, "yield");
      const summary = await main(runtime);

      expect(summary).toMatchObject({
        admissionOutcome: "phase-yielded",
        admissionYieldReason: "queue",
        gateState: "paused",
        ok: true,
        reason: "database_admission",
        throttled: true,
        validation: "paused",
      });
      expect(summary.publishPath).toBeNull();
      expect(liveTracks(client)).toEqual(["old-track"]);
      expect(client.database.query("SELECT source_watermark FROM device_sync_meta").get()).toEqual({
        source_watermark: "old-fingerprint",
      });
      expect(
        client.database.query('SELECT count(*) AS count FROM "_device_mirror_stage_tracks"').get(),
      ).toEqual({ count: 2 });

      rmSync(rig.yieldMarker);
      const resumed = await main(runtime);
      expect(resumed.validation).toBe("verified");
      expect(resumed.checkpoint?.restarted).toBe(true);
      expect(liveTracks(client)).toHaveLength(8);
    } finally {
      client.close();
      rig.restore();
    }
  }, 30_000);
});

describe("embedded source replica", () => {
  test("an inherited whole-payload lease runs sync and target batches directly during unit rollout", async () => {
    const path = join(temporaryDirectory(), "inherited-replica.db");
    const previous = {
      databaseRunner: process.env.DATABASE_ADMISSION_RUNNER,
      inheritedRunner: process.env.FLUNCLE_ADMISSION_RUNNER_PID,
      sourceToken: process.env.TURSO_AUTH_TOKEN,
      sourceUrl: process.env.TURSO_DATABASE_URL,
    };
    const previousFetch = globalThis.fetch;
    process.env.DATABASE_ADMISSION_RUNNER = "/nonexistent-device-mirror-runner";
    process.env.FLUNCLE_ADMISSION_RUNNER_PID = "inherited";
    process.env.TURSO_AUTH_TOKEN = "test";
    process.env.TURSO_DATABASE_URL = "libsql://source.invalid";
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              response: {
                result: {
                  step_errors: [null, null, null, null],
                  step_results: [
                    {},
                    { cols: [{ name: "value" }], rows: [[{ type: "integer", value: "1" }]] },
                    {},
                    null,
                  ],
                },
                type: "batch",
              },
              type: "ok",
            },
          ],
        }),
        { status: 200 },
      );

    try {
      const sync = await syncSourceReplicaAdmitted(path, false, () => ({
        close: () => {},
        sync: async () => {
          createReplicaSchema(path);
          return { frame_no: 42, frames_synced: 1 };
        },
      }));
      const target = deviceMirrorTargetClient("libsql://target.invalid", "test");

      expect(sync.frameNo).toBe(42);
      expect(target).toBeInstanceOf(LibsqlHttpClient);
      expect(await target.batch([{ sql: "SELECT 1 AS value" }], "read")).toEqual([
        { affectedRows: 0, columns: ["value"], rows: [[1n]] },
      ]);
    } finally {
      globalThis.fetch = previousFetch;
      for (const [key, value] of Object.entries({
        DATABASE_ADMISSION_RUNNER: previous.databaseRunner,
        FLUNCLE_ADMISSION_RUNNER_PID: previous.inheritedRunner,
        TURSO_AUTH_TOKEN: previous.sourceToken,
        TURSO_DATABASE_URL: previous.sourceUrl,
      })) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

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
