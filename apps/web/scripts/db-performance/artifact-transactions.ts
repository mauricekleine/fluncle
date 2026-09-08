#!/usr/bin/env bun
/**
 * Artifact write-transaction measurement over a production-schema local source seeded to a scale
 * profile's manifest counts. It drives the real `checkpointArtifactRebuild` page transaction
 * across every `sonar.track` snapshot page of the profile's embedded tracks, activates the
 * consumer, then drives the real `acknowledgeArtifactChanges` transaction over maximum-size change
 * pages. For each write transaction it records what happened while the lock was held: statements,
 * base64 calls (the vector wire encoder, with vector-length calls counted separately), `JSON.parse`
 * calls (payload decoding), SHA-256 calls, and wall time from `client.transaction("write")` through
 * commit. Local libSQL timing says nothing about hosted Turso; the statement and encoder counts are
 * the durable part, and `artifact-changes.transaction-work.integration.test.ts` pins them.
 *
 *   bun run --cwd apps/web scripts/db-performance/artifact-transactions.ts --profile 1x
 *   bun run --cwd apps/web scripts/db-performance/artifact-transactions.ts --profile 1x --markdown
 *   bun run --cwd apps/web scripts/db-performance/artifact-transactions.ts --ci --profile 1x
 */
import {
  type Client,
  type InStatement,
  type Transaction,
  type TransactionMode,
} from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acknowledgeArtifactChanges,
  activateArtifactConsumer,
  ARTIFACT_CHANGE_MAX_READ_LIMIT,
  ARTIFACT_SNAPSHOT_MAX_LIMIT,
  ARTIFACT_VECTOR_BYTES,
  type ArtifactChangeInput,
  artifactContract,
  buildArtifactChangeInsertStatement,
  checkpointArtifactRebuild,
  listArtifactChanges,
  listArtifactSnapshot,
  registerArtifactConsumer,
} from "../../src/lib/server/artifact-changes";
import { createIntegrationDb } from "../../src/lib/server/integration-db";
import { indexFixtureCardinalities } from "./fixture";
import {
  createCiFixtureCounts,
  type FixtureCounts,
  getScaleManifest,
  isScaleProfile,
  type ScaleProfile,
} from "./manifest";

export const ARTIFACT_TRANSACTION_SCHEMA_VERSION = 2 as const;
const CONSUMER_ID = "artifact-transaction-measure";
const PRODUCER = "artifact-transaction-measure";
const SEED_BATCH_SIZE = 500;
const TIMESTAMP = "2026-01-01T00:00:00.000Z";

type ArtifactClient = Pick<Client, "batch" | "execute" | "transaction">;

/** What one write transaction did between `client.transaction()` and its commit or rollback. */
export type ArtifactTransactionWork = {
  base64Calls: number;
  digestCalls: number;
  durationMs: number;
  jsonParseCalls: number;
  statements: number;
  vectorBase64Calls: number;
};

export type ArtifactTransactionSample = ArtifactTransactionWork & {
  /** Rows the transaction verified: snapshot items on a page, or events in a batch. */
  itemCount: number;
  sequence: number;
};

export type ArtifactTransactionQuantiles = {
  max: number;
  median: number;
  min: number;
  p95: number;
};

export type ArtifactTransactionPathSummary = {
  base64Calls: number[];
  digestCallsPerItemPlus: number[];
  jsonParseCalls: number[];
  sampleCount: number;
  statements: number[];
  vectorBase64Calls: number[];
  wallMs: ArtifactTransactionQuantiles;
};

export type ArtifactTransactionPathReport = {
  pageLimit: number;
  samples: ArtifactTransactionSample[];
  summary: ArtifactTransactionPathSummary;
};

export type ArtifactTransactionReport = {
  acknowledgement: ArtifactTransactionPathReport;
  census: ArtifactTransactionCensus;
  exactProfileCardinality: boolean;
  findingJoin: {
    matchedItems: number;
    pagesWithMatchedItems: number;
    unmatchedItems: number;
  };
  profile: ScaleProfile;
  rebuildCheckpoint: ArtifactTransactionPathReport;
  schemaVersion: typeof ARTIFACT_TRANSACTION_SCHEMA_VERSION;
  seedDurationMs: number;
};

export type ArtifactTransactionCensus = {
  albums: number;
  artifactChangesBelowFence: number;
  artists: number;
  crawlFrontier: number;
  findings: number;
  labels: number;
  trackArtists: number;
  trackEmbeddings: number;
  tracks: number;
};

export type ArtifactTransactionOptions = {
  /** Maximum-size change pages to append and acknowledge. */
  acknowledgements?: number;
  /** A compact derivative; omitted for the exact manifest counts. */
  counts?: FixtureCounts;
};

function trackId(index: number): string {
  return `artifact-transaction-track-${String(index).padStart(8, "0")}`;
}

function artistId(index: number): string {
  return `artifact-transaction-artist-${String(index).padStart(8, "0")}`;
}

function labelId(index: number): string {
  return `artifact-transaction-label-${String(index).padStart(8, "0")}`;
}

function albumId(index: number): string {
  return `artifact-transaction-album-${String(index).padStart(8, "0")}`;
}

function distinct(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function quantiles(values: readonly number[]): ArtifactTransactionQuantiles {
  const sorted = [...values].sort((left, right) => left - right);
  const at = (position: number): number => sorted[Math.min(sorted.length - 1, position)] ?? 0;

  return {
    max: at(sorted.length - 1),
    median: at(Math.floor(sorted.length / 2)),
    min: at(0),
    p95: at(Math.max(0, Math.ceil(sorted.length * 0.95) - 1)),
  };
}

function summarize(samples: readonly ArtifactTransactionSample[]): ArtifactTransactionPathSummary {
  return {
    base64Calls: distinct(samples.map((sample) => sample.base64Calls)),
    digestCallsPerItemPlus: distinct(
      samples.map((sample) => sample.digestCalls - sample.itemCount),
    ),
    jsonParseCalls: distinct(samples.map((sample) => sample.jsonParseCalls)),
    sampleCount: samples.length,
    statements: distinct(samples.map((sample) => sample.statements)),
    vectorBase64Calls: distinct(samples.map((sample) => sample.vectorBase64Calls)),
    wallMs: quantiles(samples.map((sample) => sample.durationMs)),
  };
}

/**
 * Wrap a client so every transaction it opens is observed for its full open window only. The
 * global encoder primitives are patched when the transaction opens and restored when it commits or
 * rolls back, so validation before the transaction and response assembly after it never count.
 */
function instrumentTransactions(client: Client): {
  client: ArtifactClient;
  work: ArtifactTransactionWork[];
} {
  const work: ArtifactTransactionWork[] = [];

  return {
    client: {
      batch: (statements, mode) => client.batch(statements, mode),
      execute: (statement: InStatement) => client.execute(statement),
      transaction: async (mode?: TransactionMode): Promise<Transaction> => {
        const startedAt = performance.now();
        const inner = await client.transaction(mode);
        const record: ArtifactTransactionWork = {
          base64Calls: 0,
          digestCalls: 0,
          durationMs: 0,
          jsonParseCalls: 0,
          statements: 0,
          vectorBase64Calls: 0,
        };
        const originalBtoa = globalThis.btoa;
        const digestDescriptor = Object.getOwnPropertyDescriptor(crypto.subtle, "digest");
        const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
        const originalParse = JSON.parse;
        globalThis.btoa = (value: string): string => {
          record.base64Calls += 1;
          if (value.length >= ARTIFACT_VECTOR_BYTES) {
            record.vectorBase64Calls += 1;
          }

          return originalBtoa(value);
        };
        crypto.subtle.digest = ((...args: Parameters<SubtleCrypto["digest"]>) => {
          record.digestCalls += 1;

          return originalDigest(...args);
        }) as SubtleCrypto["digest"];
        JSON.parse = ((text: string, reviver?: Parameters<typeof originalParse>[1]) => {
          record.jsonParseCalls += 1;

          return originalParse(text, reviver);
        }) as typeof JSON.parse;
        let finalized = false;
        const finalize = (): void => {
          if (finalized) {
            return;
          }

          finalized = true;
          record.durationMs = performance.now() - startedAt;
          globalThis.btoa = originalBtoa;
          if (digestDescriptor === undefined) {
            delete (crypto.subtle as { digest?: SubtleCrypto["digest"] }).digest;
          } else {
            Object.defineProperty(crypto.subtle, "digest", digestDescriptor);
          }
          JSON.parse = originalParse;
          work.push(record);
        };

        return {
          batch: (statements) => {
            record.statements += statements.length;

            return inner.batch(statements);
          },
          close: () => {
            finalize();
            inner.close();
          },
          get closed() {
            return inner.closed;
          },
          commit: async () => {
            await inner.commit();
            finalize();
          },
          execute: (statement: InStatement) => {
            record.statements += 1;

            return inner.execute(statement);
          },
          executeMultiple: (sql) => {
            record.statements += 1;

            return inner.executeMultiple(sql);
          },
          rollback: async () => {
            await inner.rollback();
            finalize();
          },
        };
      },
    },
    work,
  };
}

function vectorBytes(seed: number): Uint8Array {
  const bytes = new Uint8Array(ARTIFACT_VECTOR_BYTES);
  const view = new DataView(bytes.buffer);

  for (let index = 0; index < 1024; index += 1) {
    view.setFloat32(index * Float32Array.BYTES_PER_ELEMENT, seed + index / 1024, true);
  }

  return bytes;
}

function backgroundChange(index: number): ArtifactChangeInput {
  return {
    ...artifactContract("sonar.track"),
    createdAt: TIMESTAMP,
    operation: "delete",
    payload: {},
    payloadBlob: null,
    producer: PRODUCER,
    revision: 1,
    subjectId: trackId(index),
    subjectType: "track",
  };
}

function acknowledgementChange(revision: number): ArtifactChangeInput {
  return {
    ...artifactContract("sonar.track"),
    createdAt: TIMESTAMP,
    operation: "upsert",
    payload: {
      anchored: true,
      bpm: 174.25,
      certified: false,
      dismissed: false,
      durationMs: 245_000,
      hasFinding: false,
      isDuplicate: false,
      key: "Amin",
      nearestFindingScore: 0.8125,
    },
    payloadBlob: vectorBytes(revision),
    producer: PRODUCER,
    revision,
    subjectId: "artifact-transaction-acknowledged-track",
    subjectType: "track",
  };
}

async function writeBatched(client: Client, statements: InStatement[]): Promise<void> {
  for (let offset = 0; offset < statements.length; offset += SEED_BATCH_SIZE) {
    await client.batch(statements.slice(offset, offset + SEED_BATCH_SIZE), "write");
  }
}

async function writeGenerated(
  client: Client,
  total: number,
  statement: (index: number) => InStatement,
): Promise<void> {
  for (let offset = 0; offset < total; offset += SEED_BATCH_SIZE) {
    const end = Math.min(total, offset + SEED_BATCH_SIZE);
    await client.batch(
      Array.from({ length: end - offset }, (_, index) => statement(offset + index)),
      "write",
    );
  }
}

/**
 * The profile's complete table census on the production schema, plus the manifest's proportional
 * artifact-log volume below the consumer's registration fence so the acknowledged pages sit on top
 * of a populated log rather than an empty one. Findings occupy the first tracks, which are also the
 * first embedded tracks, so the measured snapshot sees both sides of its findings left join. Every
 * track has one artist edge and the manifest's surplus edges are spread deterministically as second
 * credits.
 *
 * The two measured transactions do not read crawl-frontier state, label seed state, provenance or
 * analysis backlog fields. The pending-frontier, enabled-label-track, YouTube-provenance,
 * MusicBrainz-ISRC and full-analysis distributions therefore stay unmodelled: their table counts are
 * present for census fidelity, but reproducing the perf_* distribution machinery would not change a
 * statement, projected byte, digest or encoder call on either measured path.
 */
async function seedSource(client: Client, counts: FixtureCounts): Promise<number> {
  if (counts.findings > counts.trackEmbeddings) {
    throw new Error("artifact transaction findings must fit inside the embedded track prefix");
  }

  if (counts.trackArtists < counts.tracks || counts.trackArtists > counts.tracks * counts.artists) {
    throw new Error("artifact transaction artist-edge count is not representable");
  }

  const embedding = new Uint8Array(ARTIFACT_VECTOR_BYTES);
  embedding.fill(17);

  await writeGenerated(client, counts.labels, (index) => ({
    args: [labelId(index), `Synthetic Label ${index}`, labelId(index), TIMESTAMP, TIMESTAMP],
    sql: `insert into labels (id, name, slug, created_at, updated_at)
      values (?, ?, ?, ?, ?)`,
  }));
  await writeGenerated(client, counts.albums, (index) => ({
    args: [albumId(index), `Synthetic Album ${index}`, albumId(index), TIMESTAMP, TIMESTAMP],
    sql: `insert into albums (id, name, slug, created_at, updated_at)
      values (?, ?, ?, ?, ?)`,
  }));
  await writeGenerated(client, counts.artists, (index) => ({
    args: [artistId(index), `Synthetic Artist ${index}`, artistId(index), TIMESTAMP, TIMESTAMP],
    sql: `insert into artists (id, name, slug, created_at, updated_at)
      values (?, ?, ?, ?, ?)`,
  }));
  await writeGenerated(client, counts.tracks, (index) => {
    const id = trackId(index);
    const embedded = index < counts.trackEmbeddings;

    return {
      args: [
        id,
        `Synthetic Track ${index}`,
        JSON.stringify([`Synthetic Artist ${index % counts.artists}`]),
        `spotify:track:${id}`,
        `https://example.invalid/${id}`,
        `Label ${index % Math.max(1, counts.labels)}`,
        labelId(index % counts.labels),
        albumId(index % counts.albums),
        index < counts.findings ? 0 : 1,
        embedded ? 1 : 0,
      ],
      sql: `insert into tracks
        (track_id, title, artists_json, spotify_uri, spotify_url, duration_ms, label, label_id,
         album_id, release_date, is_catalogue, has_embedding)
        values (?, ?, ?, ?, ?, 270000, ?, ?, ?, '2026-01-01', ?, ?)`,
    };
  });
  await writeGenerated(client, counts.findings, (index) => ({
    args: [trackId(index), `artifact-${String(index).padStart(8, "0")}`, TIMESTAMP],
    sql: `insert into findings (track_id, log_id, added_at) values (?, ?, ?)`,
  }));
  await writeGenerated(client, counts.trackEmbeddings, (index) => ({
    args: [trackId(index), embedding],
    sql: "insert into track_embeddings (track_id, embedding_blob) values (?, ?)",
  }));
  await writeGenerated(client, counts.trackArtists, (index) => {
    const extra = index - counts.tracks;
    const selectedTrack = index < counts.tracks ? index : extra % counts.tracks;
    const leadArtist = selectedTrack % counts.artists;
    const selectedArtist =
      index < counts.tracks
        ? leadArtist
        : (leadArtist + 1 + Math.floor(extra / counts.tracks)) % counts.artists;

    return {
      args: [trackId(selectedTrack), artistId(selectedArtist), index < counts.tracks ? 1 : 2],
      sql: `insert into track_artists (track_id, artist_id, position) values (?, ?, ?)`,
    };
  });
  await writeGenerated(client, counts.crawlFrontier, (index) => ({
    args: [
      `artifact-transaction-frontier-${String(index).padStart(8, "0")}`,
      `artifact-transaction-external-${String(index).padStart(8, "0")}`,
      TIMESTAMP,
      TIMESTAMP,
    ],
    sql: `insert into crawl_frontier
      (id, kind, state, source, external_id, hop, created_at, updated_at)
      values (?, 'release', 'done', 'musicbrainz', ?, 1, ?, ?)`,
  }));
  const backgroundCount = indexFixtureCardinalities(counts).perf_artifact_changes;
  await writeGenerated(client, backgroundCount, (index) =>
    buildArtifactChangeInsertStatement(backgroundChange(index)),
  );

  return backgroundCount;
}

function profileTableCounts(
  counts: FixtureCounts,
): Omit<ArtifactTransactionCensus, "artifactChangesBelowFence"> {
  return {
    albums: counts.albums,
    artists: counts.artists,
    crawlFrontier: counts.crawlFrontier,
    findings: counts.findings,
    labels: counts.labels,
    trackArtists: counts.trackArtists,
    trackEmbeddings: counts.trackEmbeddings,
    tracks: counts.tracks,
  };
}

function censusMatches(
  census: ArtifactTransactionCensus,
  expected: Omit<ArtifactTransactionCensus, "artifactChangesBelowFence">,
): boolean {
  return (Object.keys(expected) as (keyof typeof expected)[]).every(
    (key) => census[key] === expected[key],
  );
}

async function count(client: Client, table: string): Promise<number> {
  const result = await client.execute(`select count(*) as total from ${table}`);

  return Number(result.rows[0]?.total ?? 0);
}

export async function runArtifactTransactionProfile(
  profile: ScaleProfile,
  options: ArtifactTransactionOptions = {},
): Promise<ArtifactTransactionReport> {
  const counts = options.counts ?? getScaleManifest(profile).counts;
  const acknowledgements = options.acknowledgements ?? 7;
  const root = await mkdtemp(join(tmpdir(), "fluncle-artifact-transactions-"));
  const db = await createIntegrationDb({ url: `file:${join(root, "source.db")}` });

  try {
    const seedStartedAt = performance.now();
    const artifactChangesBelowFence = await seedSource(db, counts);
    const seedDurationMs = performance.now() - seedStartedAt;
    const census = {
      albums: await count(db, "albums"),
      artifactChangesBelowFence,
      artists: await count(db, "artists"),
      crawlFrontier: await count(db, "crawl_frontier"),
      findings: await count(db, "findings"),
      labels: await count(db, "labels"),
      trackArtists: await count(db, "track_artists"),
      trackEmbeddings: await count(db, "track_embeddings"),
      tracks: await count(db, "tracks"),
    };
    const requestedTableCounts = profileTableCounts(counts);

    if (
      !censusMatches(census, requestedTableCounts) ||
      (await count(db, "artifact_changes")) !== artifactChangesBelowFence
    ) {
      throw new Error("artifact transaction source census does not match the requested counts");
    }

    await registerArtifactConsumer(db, {
      consumerId: CONSUMER_ID,
      contracts: [artifactContract("sonar.track")],
    });
    const checkpointClient = instrumentTransactions(db);
    const checkpointSamples: ArtifactTransactionSample[] = [];
    let consumerItemCount = 0;
    let matchedFindingItems = 0;
    let pagesWithMatchedItems = 0;
    let unmatchedFindingItems = 0;

    for (let sequence = 1; ; sequence += 1) {
      const page = await listArtifactSnapshot(db, {
        consumerId: CONSUMER_ID,
        limit: ARTIFACT_SNAPSHOT_MAX_LIMIT,
        stream: "sonar.track",
        streamVersion: 1,
      });
      consumerItemCount += page.itemCount;
      const pageFindingItems = page.items.filter((item) => {
        const payload = JSON.parse(item.payloadJson) as { hasFinding?: unknown };

        return payload.hasFinding === true;
      }).length;
      matchedFindingItems += pageFindingItems;
      unmatchedFindingItems += page.itemCount - pageFindingItems;
      pagesWithMatchedItems += pageFindingItems > 0 ? 1 : 0;
      const checkpoint = await checkpointArtifactRebuild(checkpointClient.client, {
        consumerDigest: page.sourceDigest,
        consumerId: CONSUMER_ID,
        consumerItemCount,
        generation: page.generation,
        pageDigest: page.pageDigest,
        pageLimit: ARTIFACT_SNAPSHOT_MAX_LIMIT,
        stream: "sonar.track",
        streamVersion: 1,
      });
      const work = checkpointClient.work.at(-1);

      if (work === undefined || checkpointClient.work.length !== sequence) {
        throw new Error("rebuild checkpoint did not open exactly one write transaction");
      }

      checkpointSamples.push({ ...work, itemCount: page.itemCount, sequence });

      if (checkpoint.state === "complete") {
        break;
      }
    }

    if (matchedFindingItems < 1 || pagesWithMatchedItems < 1 || unmatchedFindingItems < 1) {
      throw new Error("artifact snapshot did not exercise both sides of the findings left join");
    }

    await activateArtifactConsumer(db, CONSUMER_ID);
    const acknowledgementClient = instrumentTransactions(db);
    const acknowledgementSamples: ArtifactTransactionSample[] = [];

    for (let sequence = 1; sequence <= acknowledgements; sequence += 1) {
      await writeBatched(
        db,
        Array.from({ length: ARTIFACT_CHANGE_MAX_READ_LIMIT }, (_, index) =>
          buildArtifactChangeInsertStatement(
            acknowledgementChange((sequence - 1) * ARTIFACT_CHANGE_MAX_READ_LIMIT + index + 1),
          ),
        ),
      );
      const page = await listArtifactChanges(db, {
        consumerId: CONSUMER_ID,
        limit: ARTIFACT_CHANGE_MAX_READ_LIMIT,
      });

      if (page.events.length !== ARTIFACT_CHANGE_MAX_READ_LIMIT) {
        throw new Error(`expected a full change page, read ${page.events.length} events`);
      }

      await acknowledgeArtifactChanges(acknowledgementClient.client, {
        batchDigest: page.batchDigest,
        consumerId: CONSUMER_ID,
        eventCount: page.events.length,
        fromSeq: page.fromSeq,
        throughSeq: page.throughSeq,
      });
      const work = acknowledgementClient.work.at(-1);

      if (work === undefined || acknowledgementClient.work.length !== sequence) {
        throw new Error("acknowledgement did not open exactly one write transaction");
      }

      acknowledgementSamples.push({ ...work, itemCount: page.events.length, sequence });
    }

    return {
      acknowledgement: {
        pageLimit: ARTIFACT_CHANGE_MAX_READ_LIMIT,
        samples: acknowledgementSamples,
        summary: summarize(acknowledgementSamples),
      },
      census,
      exactProfileCardinality: censusMatches(
        census,
        profileTableCounts(getScaleManifest(profile).counts),
      ),
      findingJoin: {
        matchedItems: matchedFindingItems,
        pagesWithMatchedItems,
        unmatchedItems: unmatchedFindingItems,
      },
      profile,
      rebuildCheckpoint: {
        pageLimit: ARTIFACT_SNAPSHOT_MAX_LIMIT,
        samples: checkpointSamples,
        summary: summarize(checkpointSamples),
      },
      schemaVersion: ARTIFACT_TRANSACTION_SCHEMA_VERSION,
      seedDurationMs,
    };
  } finally {
    db.close();
    await rm(root, { force: true, recursive: true });
  }
}

function formatMs(value: number): string {
  return value.toFixed(2);
}

/** One Markdown row per path, in the shape a review or ledger table expects. */
export function formatArtifactTransactionMarkdown(report: ArtifactTransactionReport): string {
  const row = (label: string, path: ArtifactTransactionPathReport): string => {
    const { summary } = path;

    return `| ${label} | ${summary.sampleCount} | ${summary.statements.join("/")} | ${summary.base64Calls.join("/")} (${summary.vectorBase64Calls.join("/")} vector) | ${summary.jsonParseCalls.join("/")} | items + ${summary.digestCallsPerItemPlus.join("/")} | ${formatMs(summary.wallMs.min)} / ${formatMs(summary.wallMs.median)} / ${formatMs(summary.wallMs.p95)} / ${formatMs(summary.wallMs.max)} |`;
  };
  const cardinality = report.exactProfileCardinality ? "exact" : "compact";

  return [
    `| path (${report.profile} ${cardinality}: ${report.census.tracks} tracks, ${report.census.trackEmbeddings} embeddings, ${report.census.findings} findings, ${report.census.artifactChangesBelowFence} log rows below fence) | samples | statements | base64 calls | JSON.parse calls | SHA-256 calls | wall ms min / median / p95 / max |`,
    "| --- | --- | --- | --- | --- | --- | --- |",
    row(
      `acknowledgement (${report.acknowledgement.pageLimit}-event pages)`,
      report.acknowledgement,
    ),
    row(
      `rebuild checkpoint (${report.rebuildCheckpoint.pageLimit}-item pages)`,
      report.rebuildCheckpoint,
    ),
  ].join("\n");
}

function parseArguments(args: readonly string[]): {
  acknowledgements: number;
  ci: boolean;
  markdown: boolean;
  profile: ScaleProfile;
} {
  let acknowledgements = 7;
  let ci = false;
  let markdown = false;
  let profile: ScaleProfile = "1x";

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--ci") {
      ci = true;
    } else if (argument === "--markdown") {
      markdown = true;
    } else if (argument === "--profile" && isScaleProfile(args[index + 1] ?? "")) {
      profile = args[index + 1] as ScaleProfile;
      index += 1;
    } else if (argument === "--acknowledgements") {
      const parsed = Number(args[index + 1]);

      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error("--acknowledgements requires a positive integer");
      }

      acknowledgements = parsed;
      index += 1;
    } else {
      throw new Error(`unknown artifact transaction option: ${argument ?? "<missing>"}`);
    }
  }

  return { acknowledgements, ci, markdown, profile };
}

if (import.meta.main) {
  const options = parseArguments(process.argv.slice(2));
  const report = await runArtifactTransactionProfile(options.profile, {
    acknowledgements: options.acknowledgements,
    counts: options.ci ? createCiFixtureCounts(options.profile) : undefined,
  });
  process.stdout.write(
    options.markdown
      ? `${formatArtifactTransactionMarkdown(report)}\n`
      : `${JSON.stringify(report)}\n`,
  );
}
