import { createHash } from "node:crypto";

import { type FixtureCounts, type ScaleProfile, getScaleManifest } from "./manifest";

export const DEFAULT_FIXTURE_CHUNK_SIZE = 500;
export const SYNTHETIC_FIXTURE_EPOCH = "2026-01-01T00:00:00.000Z";

export const FIXTURE_TABLES = [
  "perf_artists",
  "perf_labels",
  "perf_albums",
  "perf_tracks",
  "perf_findings",
  "perf_track_embeddings",
  "perf_track_artists",
  "perf_crawl_frontier",
] as const;

export type FixtureTable = (typeof FIXTURE_TABLES)[number];
export type FixtureValue = null | number | string | Uint8Array;
export type FixtureStatement = { args: FixtureValue[]; sql: string };
export type FixtureChunk = { statements: FixtureStatement[]; table: FixtureTable };

export type FixtureBatchSink = {
  batch: (statements: { args: FixtureValue[]; sql: string }[], mode?: "write") => Promise<unknown>;
};

export type GenerateFixtureOptions = {
  chunkSize?: number;
  /** Tests and CI may supply a ratio-preserving derivative. Exact runs omit this field. */
  counts?: FixtureCounts;
};

export const PERFORMANCE_FIXTURE_SCHEMA = [
  `create table if not exists perf_artists (
    id text primary key,
    name text not null
  )`,
  `create table if not exists perf_labels (
    id text primary key,
    name text not null
  )`,
  `create table if not exists perf_albums (
    id text primary key,
    name text not null,
    label_id text
  )`,
  `create table if not exists perf_tracks (
    id text primary key,
    title text not null,
    label_id text,
    album_id text,
    label_scope text not null,
    youtube_backlog integer not null,
    musicbrainz_isrc_backlog integer not null,
    full_analysis_backlog integer not null,
    created_at text not null
  )`,
  `create table if not exists perf_findings (
    track_id text primary key,
    log_id text not null
  )`,
  `create table if not exists perf_track_embeddings (
    track_id text primary key,
    embedding_blob blob not null
  )`,
  `create table if not exists perf_track_artists (
    track_id text not null,
    artist_id text not null,
    position integer not null,
    primary key (track_id, position)
  )`,
  `create table if not exists perf_crawl_frontier (
    id text primary key,
    state text not null,
    due_at text
  )`,
  `create index if not exists perf_crawl_frontier_state_id_idx
    on perf_crawl_frontier(state, id)`,
  `create index if not exists perf_tracks_label_scope_id_idx
    on perf_tracks(label_scope, id)`,
] as const;

const TRACK_INSERT = `insert or ignore into perf_tracks
  (id, title, label_id, album_id, label_scope, youtube_backlog,
   musicbrainz_isrc_backlog, full_analysis_backlog, created_at)
  values (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const EMBEDDING_BLOB = new Uint8Array(4096);
for (let index = 0; index < EMBEDDING_BLOB.length; index += 1) {
  EMBEDDING_BLOB[index] = (index * 29 + 17) % 251;
}

function padded(index: number): string {
  return index.toString().padStart(9, "0");
}

function selected(index: number, total: number, selectedCount: number): boolean {
  if (selectedCount <= 0) {
    return false;
  }

  if (selectedCount >= total) {
    return true;
  }

  return (
    Math.floor(((index + 1) * selectedCount) / total) > Math.floor((index * selectedCount) / total)
  );
}

function assertCounts(counts: FixtureCounts): void {
  const boundedByTracks = [
    ["enabled-label tracks", counts.enabledLabelTracks],
    ["findings", counts.findings],
    ["full-analysis backlog", counts.fullAnalysisBacklog],
    ["MusicBrainz-to-ISRC backlog", counts.musicbrainzIsrcBacklog],
    ["track embeddings", counts.trackEmbeddings],
    ["YouTube-provenance backlog", counts.youtubeProvenanceBacklog],
  ] as const;

  for (const [name, count] of boundedByTracks) {
    if (count < 0 || count > counts.tracks) {
      throw new Error(`${name} must be between zero and the track count`);
    }
  }

  if (counts.pendingFrontier < 0 || counts.pendingFrontier > counts.crawlFrontier) {
    throw new Error("pending frontier count must be between zero and the frontier count");
  }

  if (counts.trackArtists < counts.tracks || counts.trackArtists > counts.tracks * 2) {
    throw new Error("the fixture models one or two artists per track");
  }

  if (counts.albums < 1 || counts.artists < 1 || counts.labels < 1 || counts.tracks < 1) {
    throw new Error("fixture entity and track counts must be positive");
  }
}

async function* generatedChunks(
  table: FixtureTable,
  total: number,
  chunkSize: number,
  build: (index: number) => FixtureStatement | null,
): AsyncGenerator<FixtureChunk> {
  let statements: FixtureStatement[] = [];

  for (let index = 0; index < total; index += 1) {
    const statement = build(index);

    if (statement === null) {
      continue;
    }

    statements.push(statement);

    if (statements.length === chunkSize) {
      yield { statements, table };
      statements = [];
    }
  }

  if (statements.length > 0) {
    yield { statements, table };
  }
}

/**
 * Streams a stable, public-safe fixture. No generated value is derived from a production row or
 * identifier, and at most one configured chunk plus one shared embedding blob is resident.
 */
export async function* generateFixture(
  profile: ScaleProfile,
  options: GenerateFixtureOptions = {},
): AsyncGenerator<FixtureChunk> {
  const counts = options.counts ?? getScaleManifest(profile).counts;
  const chunkSize = options.chunkSize ?? DEFAULT_FIXTURE_CHUNK_SIZE;

  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 2_000) {
    throw new Error("fixture chunk size must be an integer from 1 through 2000");
  }

  assertCounts(counts);

  yield* generatedChunks("perf_artists", counts.artists, chunkSize, (index) => ({
    args: [`synthetic-artist-${padded(index)}`, `Synthetic Artist ${padded(index)}`],
    sql: "insert or ignore into perf_artists (id, name) values (?, ?)",
  }));

  yield* generatedChunks("perf_labels", counts.labels, chunkSize, (index) => ({
    args: [`synthetic-label-${padded(index)}`, `Synthetic Label ${padded(index)}`],
    sql: "insert or ignore into perf_labels (id, name) values (?, ?)",
  }));

  yield* generatedChunks("perf_albums", counts.albums, chunkSize, (index) => ({
    args: [
      `synthetic-album-${padded(index)}`,
      `Synthetic Album ${padded(index)}`,
      `synthetic-label-${padded(index % counts.labels)}`,
    ],
    sql: "insert or ignore into perf_albums (id, name, label_id) values (?, ?, ?)",
  }));

  yield* generatedChunks("perf_tracks", counts.tracks, chunkSize, (index) => ({
    args: [
      `synthetic-track-${padded(index)}`,
      `Synthetic Track ${padded(index)}`,
      `synthetic-label-${padded(index % counts.labels)}`,
      `synthetic-album-${padded(index % counts.albums)}`,
      selected(index, counts.tracks, counts.enabledLabelTracks) ? "enabled" : "other",
      selected(index, counts.tracks, counts.youtubeProvenanceBacklog) ? 1 : 0,
      selected(index, counts.tracks, counts.musicbrainzIsrcBacklog) ? 1 : 0,
      selected(index, counts.tracks, counts.fullAnalysisBacklog) ? 1 : 0,
      SYNTHETIC_FIXTURE_EPOCH,
    ],
    sql: TRACK_INSERT,
  }));

  yield* generatedChunks("perf_findings", counts.tracks, chunkSize, (index) =>
    selected(index, counts.tracks, counts.findings)
      ? {
          args: [
            `synthetic-track-${padded(index)}`,
            `synthetic-log-${padded(Math.floor((index * counts.findings) / counts.tracks))}`,
          ],
          sql: "insert or ignore into perf_findings (track_id, log_id) values (?, ?)",
        }
      : null,
  );

  yield* generatedChunks("perf_track_embeddings", counts.tracks, chunkSize, (index) =>
    selected(index, counts.tracks, counts.trackEmbeddings)
      ? {
          args: [`synthetic-track-${padded(index)}`, EMBEDDING_BLOB],
          sql: "insert or ignore into perf_track_embeddings (track_id, embedding_blob) values (?, ?)",
        }
      : null,
  );

  const secondArtistEdges = counts.trackArtists - counts.tracks;
  yield* generatedChunks("perf_track_artists", counts.trackArtists, chunkSize, (edgeIndex) => {
    const isSecondEdge = edgeIndex >= counts.tracks;
    const trackIndex = isSecondEdge ? edgeIndex - counts.tracks : edgeIndex;

    if (isSecondEdge && trackIndex >= secondArtistEdges) {
      return null;
    }

    const artistIndex = isSecondEdge
      ? (trackIndex * 7 + 3) % counts.artists
      : trackIndex % counts.artists;

    return {
      args: [
        `synthetic-track-${padded(trackIndex)}`,
        `synthetic-artist-${padded(artistIndex)}`,
        isSecondEdge ? 1 : 0,
      ],
      sql: "insert or ignore into perf_track_artists (track_id, artist_id, position) values (?, ?, ?)",
    };
  });

  yield* generatedChunks("perf_crawl_frontier", counts.crawlFrontier, chunkSize, (index) => {
    const isPending = selected(index, counts.crawlFrontier, counts.pendingFrontier);

    return {
      args: [
        `synthetic-frontier-${padded(index)}`,
        isPending ? "pending" : "done",
        isPending ? SYNTHETIC_FIXTURE_EPOCH : null,
      ],
      sql: "insert or ignore into perf_crawl_frontier (id, state, due_at) values (?, ?, ?)",
    };
  });
}

export async function applyFixtureSchema(sink: FixtureBatchSink): Promise<void> {
  await sink.batch(
    PERFORMANCE_FIXTURE_SCHEMA.map((sql) => ({ args: [], sql })),
    "write",
  );
}

/** Drops only the harness-owned allowlist so an exact profile cannot inherit rows from a prior run. */
export async function resetFixture(sink: FixtureBatchSink): Promise<void> {
  await sink.batch(
    [...FIXTURE_TABLES]
      .reverse()
      .map((table) => ({ args: [], sql: `drop table if exists ${table}` })),
    "write",
  );
}

export async function writeFixture(
  sink: FixtureBatchSink,
  profile: ScaleProfile,
  options: GenerateFixtureOptions = {},
): Promise<Record<FixtureTable, number>> {
  const written = Object.fromEntries(FIXTURE_TABLES.map((table) => [table, 0])) as Record<
    FixtureTable,
    number
  >;

  for await (const chunk of generateFixture(profile, options)) {
    await sink.batch(chunk.statements, "write");
    written[chunk.table] += chunk.statements.length;
  }

  return written;
}

/** A streaming fingerprint used to prove repeatability without retaining generated rows. */
export async function fixtureFingerprint(
  profile: ScaleProfile,
  options: GenerateFixtureOptions = {},
): Promise<string> {
  const digest = createHash("sha256");

  for await (const chunk of generateFixture(profile, options)) {
    for (const statement of chunk.statements) {
      digest.update(chunk.table);
      digest.update(statement.sql);
      for (const value of statement.args) {
        if (value instanceof Uint8Array) {
          digest.update(value);
        } else {
          digest.update(JSON.stringify(value));
        }
      }
    }
  }

  return digest.digest("hex");
}
