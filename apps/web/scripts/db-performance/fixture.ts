import { createHash } from "node:crypto";

import { type FixtureCounts, type ScaleProfile } from "./manifest";

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
  "due_work",
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
    name text not null,
    mbid text,
    renderable_track_count integer not null
  )`,
  `create index if not exists perf_artists_mbid_idx on perf_artists(mbid)`,
  `create index if not exists perf_artists_name_nocase_idx
    on perf_artists(name collate nocase)`,
  `create table if not exists perf_labels (
    id text primary key,
    name text not null,
    renderable_track_count integer not null
  )`,
  `create table if not exists perf_albums (
    id text primary key,
    name text not null,
    label_id text,
    renderable_track_count integer not null
  )`,
  `create table if not exists perf_tracks (
    id text primary key,
    title text not null,
    artists_json text not null,
    label_id text,
    album_id text,
    label_scope text not null,
    is_catalogue integer not null,
    youtube_backlog integer not null,
    musicbrainz_isrc_backlog integer not null,
    full_analysis_backlog integer not null,
    created_at text not null
  )`,
  `create table if not exists perf_findings (
    track_id text primary key,
    log_id text not null,
    added_at text not null,
    updated_at text,
    video_squared_at text
  )`,
  `create unique index if not exists perf_findings_log_id_unique on perf_findings(log_id)`,
  `create table if not exists perf_track_embeddings (
    track_id text primary key,
    embedding_blob blob not null
  )`,
  `create table if not exists perf_track_artists (
    track_id text not null,
    artist_id text not null,
    position integer not null,
    primary key (track_id, artist_id)
  )`,
  `create index if not exists perf_track_artists_track_id_idx on perf_track_artists(track_id)`,
  `create index if not exists perf_track_artists_artist_id_idx on perf_track_artists(artist_id)`,
  `create table if not exists perf_crawl_frontier (
    id text primary key,
    state text not null,
    due_at text
  )`,
  `create index if not exists perf_crawl_frontier_state_id_idx
    on perf_crawl_frontier(state, id)`,
  `create index if not exists perf_tracks_label_scope_id_idx
    on perf_tracks(label_scope, id)`,
  `create table if not exists due_work (
    claim_expires_at text,
    claim_token text,
    claimed_by text,
    generation text not null,
    next_due_at text not null,
    source_version text not null,
    subject_type text not null,
    work_kind text not null,
    state text not null,
    sort_key text not null,
    subject_id text not null,
    updated_at text not null,
    primary key (work_kind, subject_type, subject_id)
  )`,
  `create index if not exists due_work_ready_idx
    on due_work(work_kind, state, sort_key, subject_id)
    where state = 'ready'`,
  `create index if not exists due_work_scheduled_idx
    on due_work(work_kind, state, next_due_at, subject_id)
    where state = 'scheduled'`,
  `create index if not exists due_work_lease_idx
    on due_work(state, claim_expires_at, work_kind, subject_id)
    where state = 'leased'`,
  `create index if not exists due_work_claim_idx
    on due_work(work_kind, state, claimed_by, claim_token, sort_key, subject_id)
    where state = 'leased'`,
] as const;

const TRACK_INSERT = `insert or ignore into perf_tracks
  (id, title, artists_json, label_id, album_id, label_scope, is_catalogue,
   youtube_backlog, musicbrainz_isrc_backlog, full_analysis_backlog, created_at)
  values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const EMBEDDING_BLOB = new Uint8Array(4096);
for (let index = 0; index < EMBEDDING_BLOB.length; index += 1) {
  EMBEDDING_BLOB[index] = (index * 29 + 17) % 251;
}

function padded(index: number): string {
  return index.toString().padStart(9, "0");
}

function syntheticTimestamp(index: number, dayOffset = 0): string {
  return new Date(Date.UTC(2026, 0, 1 + dayOffset, 0, 0, index)).toISOString();
}

function syntheticArtist(index: number): { mbid: null | string; name: string } {
  if (index === 0) {
    return { mbid: "synthetic-mbid-identity", name: "Synthetic Identity" };
  }

  if (index === 1) {
    return { mbid: null, name: "Synthetic Collision" };
  }

  if (index === 2) {
    return { mbid: "synthetic-mbid-collision", name: "Synthetic Collision" };
  }

  return {
    mbid: `synthetic-mbid-${padded(index)}`,
    name: `Synthetic Artist ${padded(index)}`,
  };
}

function syntheticTrackCredits(index: number, artistCount: number): string[] {
  if (index === 0) {
    return ["Synthetic Identity"];
  }

  if (index === 1 || index === 2) {
    return ["Synthetic Collision"];
  }

  if (index === 3) {
    return ["Synthetic Collision", "Synthetic Identity", "Synthetic Identity"];
  }

  if (index === 4) {
    return ["Synthetic Alias"];
  }

  // One exact-profile and one compact-profile finding exercise the certified half of the artist
  // link contract while retaining identical synthetic identity semantics at every scale.
  if (index === 511 || index === 1272) {
    return ["Synthetic Identity"];
  }

  return [syntheticArtist(index % artistCount).name];
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

  yield* generatedChunks("perf_artists", counts.artists, chunkSize, (index) => {
    const artist = syntheticArtist(index);

    return {
      args: [`synthetic-artist-${padded(index)}`, artist.name, artist.mbid, 4],
      sql: `insert or ignore into perf_artists
              (id, name, mbid, renderable_track_count) values (?, ?, ?, ?)`,
    };
  });

  yield* generatedChunks("perf_labels", counts.labels, chunkSize, (index) => ({
    args: [`synthetic-label-${padded(index)}`, `Synthetic Label ${padded(index)}`, 4],
    sql: `insert or ignore into perf_labels
            (id, name, renderable_track_count) values (?, ?, ?)`,
  }));

  yield* generatedChunks("perf_albums", counts.albums, chunkSize, (index) => ({
    args: [
      `synthetic-album-${padded(index)}`,
      `Synthetic Album ${padded(index)}`,
      `synthetic-label-${padded(index % counts.labels)}`,
      4,
    ],
    sql: `insert or ignore into perf_albums
            (id, name, label_id, renderable_track_count) values (?, ?, ?, ?)`,
  }));

  yield* generatedChunks("perf_tracks", counts.tracks, chunkSize, (index) => ({
    args: [
      `synthetic-track-${padded(index)}`,
      `Synthetic Track ${padded(index)}`,
      JSON.stringify(syntheticTrackCredits(index, counts.artists)),
      `synthetic-label-${padded(index % counts.labels)}`,
      `synthetic-album-${padded(index % counts.albums)}`,
      selected(index, counts.tracks, counts.enabledLabelTracks) ? "enabled" : "other",
      selected(index, counts.tracks, counts.findings) ? 0 : 1,
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
            syntheticTimestamp(index),
            index % 5 === 0 ? syntheticTimestamp(index, 31) : null,
            index % 7 === 0 ? syntheticTimestamp(index, 62) : null,
          ],
          sql: `insert or ignore into perf_findings
                  (track_id, log_id, added_at, updated_at, video_squared_at)
                values (?, ?, ?, ?, ?)`,
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

    let artistIndex = isSecondEdge
      ? (trackIndex * 7 + 3) % counts.artists
      : trackIndex % counts.artists;

    if (isSecondEdge && artistIndex === trackIndex % counts.artists) {
      artistIndex = (artistIndex + 1) % counts.artists;
    }

    return {
      args: [
        `synthetic-track-${padded(trackIndex)}`,
        `synthetic-artist-${padded(artistIndex)}`,
        isSecondEdge ? 2 : 1,
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

  const dueWorkQueues = [
    { count: counts.youtubeProvenanceBacklog, workKind: "youtube-provenance-findings" },
    { count: counts.musicbrainzIsrcBacklog, workKind: "mbid-isrc-lookup" },
  ] as const;
  for (const queue of dueWorkQueues) {
    yield* generatedChunks("due_work", queue.count, chunkSize, (index) => ({
      args: [
        "fixture",
        SYNTHETIC_FIXTURE_EPOCH,
        `fixture-${queue.workKind}-${padded(index)}`,
        "ready",
        padded(index),
        `synthetic-${queue.workKind}-${padded(index)}`,
        "track",
        SYNTHETIC_FIXTURE_EPOCH,
        queue.workKind,
      ],
      sql: `insert or ignore into due_work
        (generation, next_due_at, source_version, state, sort_key, subject_id,
         subject_type, updated_at, work_kind)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    }));
  }
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
