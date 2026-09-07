#!/usr/bin/env bun
import { copyFile, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database, type SQLQueryBindings } from "bun:sqlite";

import { deriveDeviceDatabase, publishDeviceArtifactAtomically } from "../derive-device-db";
import { createIntegrationDb } from "../../src/lib/server/integration-db";
import {
  DEVICE_DB_COLUMNS,
  DEVICE_DB_INDEXES,
  DEVICE_DB_SCHEMA_VERSION,
  DEVICE_DB_PRIMARY_KEYS,
  DEVICE_SOURCE_TABLES,
  quoteDeviceDbIdentifier,
} from "../lib/device-db-derivation";
import {
  inspectDeviceGeneration,
  publishDeviceGeneration,
  syncSourceReplica,
  type DeviceGeneration,
  type DeviceSqlValue,
  type DeviceTargetClient,
  type LibsqlStatement,
  type QueryResult,
} from "../../../../docs/agents/hermes/scripts/device-mirror";
import {
  createCiFixtureCounts,
  getScaleManifest,
  isScaleProfile,
  type FixtureCounts,
  type ScaleProfile,
} from "./manifest";

export const DEVICE_RESOURCE_SCHEMA_VERSION = 1 as const;
export const DEVICE_SERVICE_DEADLINE_MS = 3_430_000;
export const DEVICE_RESOURCE_PROFILE_DEADLINE_MS: Record<ScaleProfile, number> = {
  "1x": 3_400_000,
  "2x": 3_400_000,
  "4x": 3_400_000,
};

type DiskSample = { bytes: number; files: number };
type ResourceSample = { heapUsedSampledBytes: number; rssSampledBytes: number };
type MeasurementWindow = {
  completedAt: string;
  sampleCount: 1;
  startedAt: string;
  wallDurationMs: number;
};
type TargetParity = {
  generationFingerprint: string;
  rowCounts: Record<string, number>;
  targetSourceWatermark: string;
};
type PublicationStorageSample = {
  aggregate: DiskSample;
  generations: DiskSample & { labels: string[] };
  stagedTarget: DiskSample;
};

export type DeviceResourceReport = {
  candidateCommit: string | null;
  deadline: {
    headroomMs: number;
    profileDeadlineMs: number;
    serviceDeadlineMs: number;
    withinServiceDeadline: boolean;
  };
  environment: {
    sourceReplica: "local-file-copy";
    sourceReplicaNetworkMeasured: false;
    target: "local-bun-sqlite";
    targetHostedLibsqlMeasured: false;
  };
  exactProfileCardinality: boolean;
  fixture: {
    census: Record<string, number>;
    counts: FixtureCounts;
    embeddingBytes: { maximum: number; minimum: number };
    sourceFingerprint: string;
  };
  measurements: Record<
    "corruptReplicaRecovery" | "fullRebuild" | "incrementalRefresh" | "interruptedStageRecovery",
    MeasurementWindow
  >;
  parity: Record<
    | "afterCorruptReplicaRecovery"
    | "afterFullRebuild"
    | "afterIncrementalRefresh"
    | "afterInterruptedStageRecovery",
    TargetParity
  >;
  peak: {
    heapUsedSampledBytes: number;
    replicaBytesAfterCheckpoint: number;
    replicaBytesBeforeCheckpoint: number;
    replicaWalBytesAfterCheckpoint: number;
    replicaWalBytesBeforeCheckpoint: number;
    rssHighWaterBytes: number;
    rssSampledBytes: number;
    aggregateDiskPeakBytes: number;
    aggregateDiskPeakFiles: number;
    simultaneousGenerationBytes: number;
    simultaneousGenerationFiles: number;
    simultaneousGenerationLabels: string[];
    stagedTargetPeakBytes: number;
    stagedTargetPeakFiles: number;
  };
  profile: ScaleProfile;
  revision: { gitHead: string | null; workingTreeDirty: boolean };
  schemaVersion: typeof DEVICE_RESOURCE_SCHEMA_VERSION;
  windows: { samples: number; startedAt: string; wallDurationMs: number };
};

export type DeviceResourceOptions = {
  counts?: FixtureCounts;
  rootDirectory?: string;
};

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

  constructor(path: string) {
    this.database = new Database(path, { create: true, strict: true });
    for (const table of DEVICE_SOURCE_TABLES) {
      const columns = DEVICE_DB_COLUMNS[table].map(quoteDeviceDbIdentifier).join(", ");
      const primaryKey = DEVICE_DB_PRIMARY_KEYS[table].map(quoteDeviceDbIdentifier).join(", ");
      this.database.run(
        `CREATE TABLE ${quoteDeviceDbIdentifier(table)} (${columns}, PRIMARY KEY (${primaryKey})) WITHOUT ROWID`,
      );
    }
    this.database.run(`CREATE TABLE device_sync_meta (
      schema_version INTEGER NOT NULL, cut_name TEXT NOT NULL, derived_at TEXT NOT NULL,
      source_watermark TEXT NOT NULL
    )`);
    for (const index of DEVICE_DB_INDEXES) {
      this.database.run(
        `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${quoteDeviceDbIdentifier(index.name)}
          ON ${quoteDeviceDbIdentifier(index.table)} (${index.columns.map(quoteDeviceDbIdentifier).join(", ")})`,
      );
    }
    this.database
      .query("INSERT INTO device_sync_meta VALUES (?, ?, ?, ?)")
      .run(DEVICE_DB_SCHEMA_VERSION, "anchored", "1970-01-01T00:00:00.000Z", "empty");
  }

  batch(statements: readonly LibsqlStatement[], mode: "read" | "write"): Promise<QueryResult[]> {
    const execute = this.database.transaction(() =>
      statements.map((statement) => {
        const args = (statement.args ?? []).map(binding);
        const read = /^(SELECT|PRAGMA)/.test(statement.sql.trimStart().toUpperCase());
        if (read) {
          const query = this.database.query(statement.sql);
          return {
            affectedRows: 0,
            columns: query.columnNames,
            rows: query.values(...args) as DeviceSqlValue[][],
          };
        }
        const result = this.database.run(statement.sql, ...args);
        return { affectedRows: result.changes, columns: [], rows: [] };
      }),
    );
    return Promise.resolve(mode === "write" ? execute.immediate() : execute.deferred());
  }

  close(): void {
    this.database.close();
  }
}

function trackId(index: number): string {
  return `device-resource-track-${String(index).padStart(8, "0")}`;
}

function sourceCensus(database: Database): Record<string, number> {
  const tables = [
    "tracks",
    "findings",
    "artists",
    "labels",
    "albums",
    "track_artists",
    "track_embeddings",
  ];
  return Object.fromEntries(
    tables.map((table) => [
      table,
      Number(
        (
          database
            .query(`SELECT count(*) AS count FROM ${quoteDeviceDbIdentifier(table)}`)
            .get() as { count: number }
        ).count,
      ),
    ]),
  );
}

function assertSourceCensus(census: Record<string, number>, counts: FixtureCounts): void {
  const expected = {
    albums: counts.albums,
    artists: counts.artists,
    findings: counts.findings,
    labels: counts.labels,
    track_artists: counts.trackArtists,
    track_embeddings: counts.trackEmbeddings,
    tracks: counts.tracks,
  };
  for (const [table, value] of Object.entries(expected)) {
    if (census[table] !== value) {
      throw new Error(
        `device resource census ${table} expected ${value}, observed ${census[table]}`,
      );
    }
  }
}

async function fileBytes(path: string): Promise<number> {
  return (await stat(path).catch(() => undefined))?.size ?? 0;
}

async function directoryFootprint(path: string): Promise<DiskSample> {
  const entries = await readdir(path, { withFileTypes: true });
  let bytes = 0;
  let files = 0;
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      const nested = await directoryFootprint(child);
      bytes += nested.bytes;
      files += nested.files;
    } else if (entry.isFile()) {
      bytes += await fileBytes(child);
      files += 1;
    }
  }
  return { bytes, files };
}

function sampleResources(peak: ResourceSample): ResourceSample {
  const current = process.memoryUsage();
  return {
    heapUsedSampledBytes: Math.max(peak.heapUsedSampledBytes, current.heapUsed),
    rssSampledBytes: Math.max(peak.rssSampledBytes, current.rss),
  };
}

async function createSource(
  path: string,
  counts: FixtureCounts,
): Promise<{
  census: Record<string, number>;
  embeddingBytes: { maximum: number; minimum: number };
}> {
  const client = await createIntegrationDb({ url: `file:${path}` });
  client.close();
  const database = new Database(path, { strict: true });
  const embedding = new Uint8Array(4096);
  embedding.fill(17);
  database.run("PRAGMA foreign_keys = OFF");
  database.run("PRAGMA journal_mode = WAL");
  database.run("PRAGMA synchronous = OFF");
  const timestamp = "2026-01-01T00:00:00.000Z";
  const insert = database.transaction(() => {
    const artist = database.query(
      "INSERT INTO artists (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    );
    const label = database.query(
      "INSERT INTO labels (id, name, slug, seed_state, created_at, updated_at) VALUES (?, ?, ?, 'enabled', ?, ?)",
    );
    const album = database.query(
      "INSERT INTO albums (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    );
    const track = database.query(`INSERT INTO tracks
      (track_id, title, artists_json, spotify_uri, spotify_url, duration_ms, label, album_id, label_id,
       release_date, is_catalogue, has_embedding) VALUES (?, ?, ?, ?, ?, 270000, ?, ?, ?, '2026-01-01', 1, ?)`);
    const finding = database.query(
      "INSERT INTO findings (track_id, log_id, added_at) VALUES (?, ?, ?)",
    );
    const edge = database.query(
      "INSERT INTO track_artists (track_id, artist_id, position) VALUES (?, ?, ?)",
    );
    const vector = database.query(
      "INSERT INTO track_embeddings (track_id, embedding_blob) VALUES (?, ?)",
    );
    for (let index = 0; index < counts.artists; index += 1) {
      artist.run(`artist-${index}`, `Artist ${index}`, `artist-${index}`, timestamp, timestamp);
    }
    for (let index = 0; index < counts.labels; index += 1) {
      label.run(`label-${index}`, `Label ${index}`, `label-${index}`, timestamp, timestamp);
    }
    for (let index = 0; index < counts.albums; index += 1) {
      album.run(`album-${index}`, `Album ${index}`, `album-${index}`, timestamp, timestamp);
    }
    for (let index = 0; index < counts.tracks; index += 1) {
      const id = trackId(index);
      const embedded = index < counts.trackEmbeddings ? 1 : 0;
      track.run(
        id,
        `Synthetic Track ${index}`,
        '["Synthetic Artist"]',
        `spotify:track:${id}`,
        `https://example.invalid/${id}`,
        `Label ${index % counts.labels}`,
        `album-${index % counts.albums}`,
        `label-${index % counts.labels}`,
        embedded,
      );
      edge.run(id, `artist-${index % counts.artists}`, 0);
      if (embedded) {
        vector.run(id, embedding);
      }
      if (index < counts.findings) {
        finding.run(id, `device-${String(index).padStart(8, "0")}`, timestamp);
      }
    }
    for (let index = counts.tracks; index < counts.trackArtists; index += 1) {
      const trackIndex = index % counts.tracks;
      edge.run(trackId(trackIndex), `artist-${(trackIndex + 1) % counts.artists}`, 1);
    }
  });
  try {
    insert.immediate();
    database.run("PRAGMA wal_checkpoint(TRUNCATE)");
    const blob = database
      .query(
        "SELECT min(length(embedding_blob)) AS min, max(length(embedding_blob)) AS max FROM track_embeddings",
      )
      .get() as { min: number; max: number };
    if (blob.min !== 4096 || blob.max !== 4096) {
      throw new Error("device resource embeddings are not exactly 4096 bytes");
    }
    const census = sourceCensus(database);
    assertSourceCensus(census, counts);
    return { census, embeddingBytes: { maximum: blob.max, minimum: blob.min } };
  } finally {
    database.close();
  }
}

async function syncLocalSource(
  source: string,
  replica: string,
  mutationOrdinal: number,
  forceRebuild = false,
): Promise<{ after: number; before: number; walAfter: number; walBefore: number }> {
  const sourceWriter = new Database(source, { strict: true });
  let before = 0;
  let walBefore = 0;
  try {
    sourceWriter.run("PRAGMA journal_mode = WAL");
    sourceWriter.run("PRAGMA wal_autocheckpoint = 0");
    const mutation = sourceWriter.transaction(() => {
      sourceWriter
        .query("UPDATE tracks SET title = ? WHERE track_id = ?")
        .run(`Synthetic Track replica ${mutationOrdinal}`, trackId(0));
      sourceWriter
        .query("UPDATE artists SET name = ? WHERE id = ?")
        .run(`Artist replica ${mutationOrdinal}`, "artist-0");
      sourceWriter
        .query("UPDATE labels SET name = ? WHERE id = ?")
        .run(`Label replica ${mutationOrdinal}`, "label-0");
      sourceWriter
        .query("UPDATE albums SET name = ? WHERE id = ?")
        .run(`Album replica ${mutationOrdinal}`, "album-0");
      sourceWriter
        .query("DELETE FROM track_artists WHERE track_id = ? AND position = 0")
        .run(trackId(0));
      sourceWriter
        .query("INSERT INTO track_artists (track_id, artist_id, position) VALUES (?, ?, 0)")
        .run(trackId(0), "artist-0");
    });
    mutation.immediate();
    await syncSourceReplica(
      {
        authToken: "local-device-resource-fixture",
        forceRebuild,
        path: replica,
        syncUrl: "file:local-device-resource-fixture",
      },
      () => ({
        close: () => {},
        sync: async () => {
          await copyFile(source, replica);
          await copyFile(`${source}-wal`, `${replica}-wal`);
          before = await fileBytes(replica);
          walBefore = await fileBytes(`${replica}-wal`);
          if (walBefore === 0) {
            throw new Error("local replica sync did not materialize a WAL before checkpoint");
          }
          return { frame_no: mutationOrdinal + 1, frames_synced: 1 };
        },
      }),
    );
    const result = {
      after: await fileBytes(replica),
      before,
      walAfter: await fileBytes(`${replica}-wal`),
      walBefore,
    };
    if (result.walAfter !== 0) {
      throw new Error("device checkpoint did not truncate the local replica WAL");
    }
    return result;
  } finally {
    sourceWriter.close();
  }
}

async function publicationStorageSample(
  root: string,
  targetPath: string,
  generationPath: string,
  previousGenerationPath: string,
): Promise<PublicationStorageSample> {
  const generationEntries = await Promise.all(
    [
      ["candidate-generation", generationPath],
      ["last-verified-generation", previousGenerationPath],
    ].map(async ([label, path]) => ({ bytes: await fileBytes(path), label: String(label) })),
  );
  const presentGenerations = generationEntries.filter((entry) => entry.bytes > 0);
  return {
    aggregate: await directoryFootprint(root),
    generations: {
      bytes: presentGenerations.reduce((total, entry) => total + entry.bytes, 0),
      files: presentGenerations.length,
      labels: presentGenerations.map((entry) => entry.label),
    },
    stagedTarget: { bytes: await fileBytes(targetPath), files: 1 },
  };
}

async function deriveAndPublish(
  replica: string,
  generationPath: string,
  target: LocalTargetClient,
  storage: (temporaryGenerationPath?: string) => Promise<PublicationStorageSample>,
): Promise<{
  generation: DeviceGeneration;
  sourceFingerprint: string;
  storage: PublicationStorageSample[];
}> {
  let temporarySample: PublicationStorageSample | null = null;
  let publicationSample: PublicationStorageSample | null = null;
  const derivation = await deriveDeviceDatabase(
    {
      cut: "anchored",
      out: generationPath,
      source: replica,
    },
    {
      publish: async (temporaryPath, destinationPath) => {
        // The populated temporary artifact coexists with the old generation and target here.
        // This is the physical directory peak, before the atomic rename removes the tmp name.
        temporarySample = await storage();
        await publishDeviceArtifactAtomically(temporaryPath, destinationPath);
      },
    },
  );
  const generation = inspectDeviceGeneration(generationPath);
  await publishDeviceGeneration(target, generation, 200, {
    beforeCutover: async () => {
      // Keep the semantic generation overlap separate from the physical tmp peak above.
      publicationSample = await storage();
    },
  });
  if (temporarySample === null || publicationSample === null) {
    throw new Error("device resource proof did not sample publication staging");
  }
  return {
    generation,
    sourceFingerprint: derivation.sourceWatermark,
    storage: [temporarySample, publicationSample],
  };
}

function elapsed(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

export async function measureDeviceResourceWindow<T>(
  operation: () => Promise<T>,
  clock: () => number = () => performance.now(),
  timestamp: () => string = () => new Date().toISOString(),
): Promise<{ result: T; window: MeasurementWindow }> {
  const startedAt = timestamp();
  const startedAtMs = clock();
  const result = await operation();
  return {
    result,
    window: {
      completedAt: timestamp(),
      sampleCount: 1,
      startedAt,
      wallDurationMs: Math.round(clock() - startedAtMs),
    },
  };
}

async function assertTargetParity(
  target: DeviceTargetClient,
  generation: DeviceGeneration,
): Promise<TargetParity> {
  const result = await target.batch(
    [
      ...DEVICE_SOURCE_TABLES.map((table) => ({
        sql: `SELECT count(*) AS count FROM ${quoteDeviceDbIdentifier(table)}`,
      })),
      { sql: "SELECT source_watermark FROM device_sync_meta" },
    ],
    "read",
  );
  const rowCounts = Object.fromEntries(
    DEVICE_SOURCE_TABLES.map((table, index) => [table, Number(result[index]?.rows[0]?.[0] ?? -1)]),
  );
  for (const table of DEVICE_SOURCE_TABLES) {
    if (rowCounts[table] !== generation.rowCounts[table]) {
      throw new Error(`target parity failed for ${table}`);
    }
  }
  const targetSourceWatermark = result.at(-1)?.rows[0]?.[0];
  if (typeof targetSourceWatermark !== "string") {
    throw new Error("target parity source watermark is missing");
  }
  if (targetSourceWatermark !== generation.fingerprint) {
    throw new Error("target parity failed for source watermark");
  }
  return { generationFingerprint: generation.fingerprint, rowCounts, targetSourceWatermark };
}

function peakDisk(current: DiskSample, sample: DiskSample): DiskSample {
  return sample.bytes > current.bytes ? sample : current;
}

function candidateCommit(): string | null {
  const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], { stderr: "ignore", stdout: "pipe" });
  const commit = new TextDecoder().decode(result.stdout).trim();
  return /^[0-9a-f]{40}$/.test(commit) ? commit : null;
}

function workingTreeDirty(): boolean {
  const result = Bun.spawnSync(["git", "status", "--porcelain"], {
    stderr: "ignore",
    stdout: "pipe",
  });
  return new TextDecoder().decode(result.stdout).trim().length > 0;
}

export async function runDeviceResourceProfile(
  profile: ScaleProfile,
  options: DeviceResourceOptions = {},
): Promise<DeviceResourceReport> {
  const counts = options.counts ?? getScaleManifest(profile).counts;
  const exactProfileCardinality = options.counts === undefined;
  const ownedRoot = options.rootDirectory === undefined;
  const root = options.rootDirectory ?? (await mkdtemp(join(tmpdir(), "fluncle-device-resource-")));
  const startedAt = new Date().toISOString();
  const wallStartedAt = performance.now();
  let peak = sampleResources({ heapUsedSampledBytes: 0, rssSampledBytes: 0 });
  try {
    const source = join(root, "source.db");
    const replica = join(root, "source-replica.db");
    const generation = join(root, "next-generation.db");
    const previous = join(root, "last-verified-generation.db");
    const targetPath = join(root, "target.db");
    const fixture = await createSource(source, counts);
    peak = sampleResources(peak);
    const initialSync = await syncLocalSource(source, replica, 0);
    peak = sampleResources(peak);
    const target = new LocalTargetClient(targetPath);
    try {
      let aggregateDiskPeak: DiskSample = { bytes: 0, files: 0 };
      let generationOverlapPeak: DiskSample & { labels: string[] } = {
        bytes: 0,
        files: 0,
        labels: [],
      };
      let stagedTargetPeak: DiskSample = { bytes: 0, files: 0 };
      const recordStorage = (sample: PublicationStorageSample): void => {
        aggregateDiskPeak = peakDisk(aggregateDiskPeak, sample.aggregate);
        stagedTargetPeak = peakDisk(stagedTargetPeak, sample.stagedTarget);
        if (sample.generations.bytes > generationOverlapPeak.bytes) {
          generationOverlapPeak = sample.generations;
        }
      };
      const storage = (): Promise<PublicationStorageSample> =>
        publicationStorageSample(root, targetPath, generation, previous);
      const initial = await deriveAndPublish(replica, generation, target, storage);
      for (const sample of initial.storage) {
        recordStorage(sample);
      }
      peak = sampleResources(peak);
      await copyFile(generation, previous);

      const incrementalMeasurement = await measureDeviceResourceWindow(async () => {
        const sync = await syncLocalSource(source, replica, 1);
        const derived = await deriveAndPublish(replica, generation, target, storage);
        for (const sample of derived.storage) {
          recordStorage(sample);
        }
        return { derived, sync };
      });
      const incrementalSync = incrementalMeasurement.result.sync;
      const incrementalParity = await assertTargetParity(
        target,
        incrementalMeasurement.result.derived.generation,
      );
      peak = sampleResources(peak);

      const fullMeasurement = await measureDeviceResourceWindow(async () => {
        const sync = await syncLocalSource(source, replica, 2, true);
        const derived = await deriveAndPublish(replica, generation, target, storage);
        for (const sample of derived.storage) {
          recordStorage(sample);
        }
        return { derived, sync };
      });
      const fullSync = fullMeasurement.result.sync;
      const fullParity = await assertTargetParity(
        target,
        fullMeasurement.result.derived.generation,
      );
      peak = sampleResources(peak);

      const corruptMeasurement = await measureDeviceResourceWindow(async () => {
        await writeFile(replica, "corrupt replica");
        const sync = await syncLocalSource(source, replica, 3);
        const derived = await deriveAndPublish(replica, generation, target, storage);
        for (const sample of derived.storage) {
          recordStorage(sample);
        }
        return { derived, sync };
      });
      const corruptSync = corruptMeasurement.result.sync;
      const corruptParity = await assertTargetParity(
        target,
        corruptMeasurement.result.derived.generation,
      );
      peak = sampleResources(peak);

      const interruptedMeasurement = await measureDeviceResourceWindow(async () => {
        const sync = await syncLocalSource(source, replica, 4);
        await deriveDeviceDatabase(
          { cut: "anchored", out: generation, source: replica },
          {
            publish: async (temporaryPath, destinationPath) => {
              recordStorage(await storage());
              await publishDeviceArtifactAtomically(temporaryPath, destinationPath);
            },
          },
        );
        const interruptedGeneration = inspectDeviceGeneration(generation);
        let stageInterrupted = false;
        await publishDeviceGeneration(target, interruptedGeneration, 200, {
          beforeCutover: async () => {
            recordStorage(await storage());
            stageInterrupted = true;
            throw new Error("intentional local stage interruption");
          },
        }).catch((error: unknown) => {
          if (
            !(error instanceof Error) ||
            error.message !== "intentional local stage interruption"
          ) {
            throw error;
          }
        });
        if (!stageInterrupted) {
          throw new Error("device resource proof did not interrupt staged publication");
        }
        const recovered = await publishDeviceGeneration(target, interruptedGeneration, 200, {
          beforeCutover: async () => {
            recordStorage(await storage());
          },
        });
        if (!recovered.published) {
          throw new Error("interrupted device stage did not publish on replay");
        }
        return { generation: interruptedGeneration, sync };
      });
      const interruptedSync = interruptedMeasurement.result.sync;
      const interruptedParity = await assertTargetParity(
        target,
        interruptedMeasurement.result.generation,
      );
      peak = sampleResources(peak);
      const wallDurationMs = elapsed(wallStartedAt);
      const deadline = DEVICE_SERVICE_DEADLINE_MS - wallDurationMs;
      return {
        candidateCommit: process.env.GIT_COMMIT ?? candidateCommit(),
        deadline: {
          headroomMs: deadline,
          profileDeadlineMs: DEVICE_RESOURCE_PROFILE_DEADLINE_MS[profile],
          serviceDeadlineMs: DEVICE_SERVICE_DEADLINE_MS,
          withinServiceDeadline: deadline >= 0,
        },
        environment: {
          sourceReplica: "local-file-copy",
          sourceReplicaNetworkMeasured: false,
          target: "local-bun-sqlite",
          targetHostedLibsqlMeasured: false,
        },
        exactProfileCardinality,
        fixture: {
          census: fixture.census,
          counts,
          embeddingBytes: fixture.embeddingBytes,
          sourceFingerprint: initial.sourceFingerprint,
        },
        measurements: {
          corruptReplicaRecovery: corruptMeasurement.window,
          fullRebuild: fullMeasurement.window,
          incrementalRefresh: incrementalMeasurement.window,
          interruptedStageRecovery: interruptedMeasurement.window,
        },
        parity: {
          afterCorruptReplicaRecovery: corruptParity,
          afterFullRebuild: fullParity,
          afterIncrementalRefresh: incrementalParity,
          afterInterruptedStageRecovery: interruptedParity,
        },
        peak: {
          aggregateDiskPeakBytes: aggregateDiskPeak.bytes,
          aggregateDiskPeakFiles: aggregateDiskPeak.files,
          heapUsedSampledBytes: peak.heapUsedSampledBytes,
          replicaBytesAfterCheckpoint: Math.max(
            initialSync.after,
            incrementalSync.after,
            fullSync.after,
            corruptSync.after,
            interruptedSync.after,
          ),
          replicaBytesBeforeCheckpoint: Math.max(
            initialSync.before,
            incrementalSync.before,
            fullSync.before,
            corruptSync.before,
            interruptedSync.before,
          ),
          replicaWalBytesAfterCheckpoint: Math.max(
            initialSync.walAfter,
            incrementalSync.walAfter,
            fullSync.walAfter,
            corruptSync.walAfter,
            interruptedSync.walAfter,
          ),
          replicaWalBytesBeforeCheckpoint: Math.max(
            initialSync.walBefore,
            incrementalSync.walBefore,
            fullSync.walBefore,
            corruptSync.walBefore,
            interruptedSync.walBefore,
          ),
          rssHighWaterBytes: process.resourceUsage().maxRSS * 1024,
          rssSampledBytes: peak.rssSampledBytes,
          simultaneousGenerationBytes: generationOverlapPeak.bytes,
          simultaneousGenerationFiles: generationOverlapPeak.files,
          simultaneousGenerationLabels: generationOverlapPeak.labels,
          stagedTargetPeakBytes: stagedTargetPeak.bytes,
          stagedTargetPeakFiles: stagedTargetPeak.files,
        },
        profile,
        revision: { gitHead: candidateCommit(), workingTreeDirty: workingTreeDirty() },
        schemaVersion: DEVICE_RESOURCE_SCHEMA_VERSION,
        windows: { samples: 4, startedAt, wallDurationMs },
      };
    } finally {
      target.close();
    }
  } finally {
    if (ownedRoot) {
      await rm(root, { force: true, recursive: true });
    }
  }
}

function parseArguments(args: readonly string[]): { ci: boolean; profile: ScaleProfile } {
  let ci = false;
  let profile: ScaleProfile = "1x";
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--ci") {
      ci = true;
    } else if (args[index] === "--profile" && isScaleProfile(args[index + 1] ?? "")) {
      profile = args[index + 1] as ScaleProfile;
      index += 1;
    } else {
      throw new Error(`unknown device resource option: ${args[index] ?? "<missing>"}`);
    }
  }
  return { ci, profile };
}

if (import.meta.main) {
  const options = parseArguments(process.argv.slice(2));
  const report = await runDeviceResourceProfile(options.profile, {
    counts: options.ci ? createCiFixtureCounts(options.profile) : undefined,
  });
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
