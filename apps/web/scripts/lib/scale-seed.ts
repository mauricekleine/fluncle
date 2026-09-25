import { type Client } from "@libsql/client/web";

export const SEED_NOW = "2026-07-24T00:00:00.000Z";

const DAY_MS = 24 * 60 * 60 * 1000;
const CHUNK = 500;

const KEYS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"].flatMap((pitch) => [
  `${pitch} major`,
  `${pitch} minor`,
]);

const LABELS = ["Hospital Records", "Shogun Audio", "Critical Music", "Metalheadz", "V Recordings"];

const PLATFORMS = [
  "spotify",
  "youtube",
  "mixcloud",
  "soundcloud",
  "instagram",
  "tiktok",
  "bandcamp",
  "beatport",
  "twitter",
  "facebook",
  "twitch",
  "homepage",
];

const SOCIAL_SOURCES = ["musicbrainz", "firecrawl", "operator"];

const EMBEDDING_BLOB = new Uint8Array(1024 * 4);
for (let byte = 0; byte < EMBEDDING_BLOB.length; byte += 1) {
  EMBEDDING_BLOB[byte] = (byte * 31 + 7) % 251;
}

type SeedValue = null | number | string | Uint8Array;
type SeedStatement = { args: SeedValue[]; sql: string };

export type ScaleSeedOptions = {
  albums?: number;
  artistSocials?: number;
  artists?: number;

  demandZeroEvery?: number;
  findings?: number;
  frontier?: number;
  labels?: number;

  nowIso?: string;

  onProgress?: (line: string) => void;

  scale?: number;
};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];

  return raw ? Number.parseInt(raw, 10) : fallback;
}

function isoDaysBefore(nowMs: number, days: number): string {
  return new Date(nowMs - days * DAY_MS).toISOString();
}

function releaseDateForIndex(index: number, total: number): string {
  const start = Date.UTC(2005, 0, 1);
  const end = Date.UTC(2026, 11, 31);
  const spanDays = Math.floor((end - start) / DAY_MS);
  const day = Math.floor((index / Math.max(1, total)) * spanDays);

  return new Date(end - day * DAY_MS).toISOString().slice(0, 10);
}

function labelIdForIndex(index: number, labelCount: number): string {
  const bucket = index % 100;

  if (bucket < 20) {
    return "label-0";
  }

  if (bucket < 30) {
    return "label-1";
  }

  if (bucket < 38) {
    return "label-2";
  }

  if (bucket < 44) {
    return "label-3";
  }

  if (bucket < 48) {
    return "label-4";
  }

  return `label-${5 + (index % Math.max(1, labelCount - 5))}`;
}

function artistName(artistIndex: number): string {
  const base = `Artist ${artistIndex}`;

  if (artistIndex % 3 === 1) {
    return base.toUpperCase();
  }

  if (artistIndex % 3 === 2) {
    return base.toLowerCase();
  }

  return base;
}

function emit(opts: ScaleSeedOptions, line: string): void {
  if (opts.onProgress) {
    opts.onProgress(line);

    return;
  }

  process.stdout.write(`\r${line}`);
}

async function batchWithRetry(client: Client, statements: SeedStatement[]): Promise<void> {
  const attempts = 3;

  for (let attempt = 1; ; attempt += 1) {
    try {
      await client.batch(statements, "write");

      return;
    } catch (error) {
      if (attempt >= attempts) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
    }
  }
}

async function writeChunked(
  client: Client,
  opts: ScaleSeedOptions,
  label: string,
  count: number,
  build: (index: number) => SeedStatement[],
): Promise<void> {
  for (let start = 0; start < count; start += CHUNK) {
    const end = Math.min(count, start + CHUNK);
    const statements: SeedStatement[] = [];

    for (let index = start; index < end; index += 1) {
      statements.push(...build(index));
    }

    await batchWithRetry(client, statements);
    emit(opts, `  ${label} ${end}/${count}`);
  }

  process.stdout.write("\n");
}

const TRACK_COLUMNS = `track_id, title, artists_json, duration_ms, release_date, bpm, key, label,
  label_id, album_id, album_image_url, capture_status, capture_priority, nearest_finding_score,
  nearest_finding_track_id, duplicate_of_track_id, catalogue_ranked_at, source_audio_key,
  analyzed_from, analyzed_at, spotify_uri, isrc, apple_music_url,
  backfill_apple_music_done_at, backfill_apple_music_attempted_at, is_catalogue, has_embedding,
  has_isrc`;

const TRACK_SQL = `insert or ignore into tracks (${TRACK_COLUMNS})
  values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const TRACK_EMBEDDING_SQL = `insert or ignore into track_embeddings (track_id, embedding_blob)
  values (?, ?)`;

type Resolved = {
  albums: number;
  artistSocials: number;
  artists: number;
  catalogue: number;
  demandZeroEvery: number;
  findings: number;
  frontier: number;
  labels: number;
};

function catalogueIsEmbedded(index: number): boolean {
  return index % 5 < 2 && index % 2 === 0;
}

function catalogueCaptureStatus(index: number, captured: boolean): string {
  if (index % 500 === 0) {
    return "wrong-audio";
  }
  if (index % 500 === 1) {
    return "unmatched";
  }
  if (index % 500 === 2) {
    return "failed";
  }
  return captured ? "done" : "pending";
}

function catalogueNearestScore(index: number, hasEmbedding: boolean): null | number {
  if (!hasEmbedding) {
    return null;
  }
  return index % 74 === 0 ? 0.995 + (index % 5) * 0.001 : 0.3 + (index % 65) / 100;
}

function catalogueTrackArgs(index: number, nowMs: number, opts: Resolved): SeedValue[] {
  const trackId = `cat-${index}`;
  const captured = index % 5 < 2;
  const hasEmbedding = catalogueIsEmbedded(index);
  const albumId = `album-${index % opts.albums}`;

  const captureStatus = catalogueCaptureStatus(index, captured);
  const isTerminal =
    captureStatus === "wrong-audio" || captureStatus === "unmatched" || captureStatus === "failed";

  const nearestScore = catalogueNearestScore(index, hasEmbedding);
  const duplicateOf = hasEmbedding && index % 74 === 0 ? `find-${index % opts.findings}` : null;
  const nearestFinding = hasEmbedding ? `find-${index % opts.findings}` : null;
  const rankedAt = hasEmbedding || isTerminal ? isoDaysBefore(nowMs, 1 + (index % 200)) : null;

  const analyzedFrom = captured
    ? index % 5 === 0
      ? null
      : index % 5 === 1
        ? "preview"
        : "full"
    : null;

  const analyzedAt =
    captured && analyzedFrom !== null ? isoDaysBefore(nowMs, 2 + (index % 180)) : null;

  const appleDone = index % 19 === 0 ? isoDaysBefore(nowMs, 5 + (index % 120)) : null;
  const appleAttempted =
    index % 7 === 0
      ? isoDaysBefore(nowMs, index % 3)
      : index % 7 === 1
        ? isoDaysBefore(nowMs, 30 + (index % 300))
        : null;
  const artists =
    index % 2 === 0
      ? [artistName(index % opts.artists), artistName((index * 7 + 3) % opts.artists)]
      : [artistName(index % opts.artists)];

  return [
    trackId,
    `Catalogue ${index}`,
    JSON.stringify(artists),
    index % 997 === 0 ? 1_200_000 : 180_000 + (index % 120) * 1000,
    releaseDateForIndex(index, opts.catalogue),
    index % 11 === 0 ? null : 160 + (index % 40),
    KEYS[index % KEYS.length] ?? null,
    LABELS[index % LABELS.length] ?? null,
    labelIdForIndex(index, opts.labels),
    albumId,
    index % 13 === 0 ? null : `https://i.scdn.co/image/${albumId}`,
    captureStatus,
    index % 10 < 3 ? index % 4 : null,
    nearestScore,
    nearestFinding,
    duplicateOf,
    rankedAt,
    captured ? `${trackId}/${(index * 2654435761) % 1_000_000}.mp3` : null,
    analyzedFrom,
    analyzedAt,
    index % 10 < 7 ? null : `spotify:track:${trackId}`,
    index % 23 === 0 ? null : `GB${String(index).padStart(8, "0")}`,
    index % 20 === 0 ? `https://music.apple.com/us/song/${index}` : null,
    appleDone,
    appleAttempted,

    1,
    hasEmbedding ? 1 : 0,
    index % 23 === 0 ? 0 : 1,
  ];
}

function findingStatements(index: number, nowMs: number, opts: Resolved): SeedStatement[] {
  const trackId = `find-${index}`;
  const albumId = `album-${index % opts.albums}`;

  const trackArgs: SeedValue[] = [
    trackId,
    `Finding ${index}`,
    JSON.stringify([artistName(index % opts.artists), artistName((index * 5 + 1) % opts.artists)]),
    200_000 + (index % 90) * 1000,
    releaseDateForIndex(index, opts.findings),
    160 + (index % 40),
    KEYS[index % KEYS.length] ?? null,
    LABELS[index % LABELS.length] ?? null,
    labelIdForIndex(index, opts.labels),
    albumId,
    `https://i.scdn.co/image/${albumId}`,
    "done",

    null,
    null,
    null,
    null,
    null,
    `${trackId}/${(index * 40503) % 1_000_000}.mp3`,
    "full",
    isoDaysBefore(nowMs, 3 + (index % 120)),
    `spotify:track:${trackId}`,
    `GBFND${String(index).padStart(6, "0")}`,
    index % 4 === 0 ? `https://music.apple.com/us/song/f${index}` : null,
    index % 4 === 0 ? isoDaysBefore(nowMs, 10 + (index % 60)) : null,
    index % 3 === 0 ? isoDaysBefore(nowMs, 10 + (index % 200)) : null,

    0,
    1,
    1,
  ];

  return [
    { args: trackArgs, sql: TRACK_SQL },
    { args: [trackId, EMBEDDING_BLOB], sql: TRACK_EMBEDDING_SQL },
    {
      args: [trackId, `${String(index).padStart(4, "0")}.7.1A`, isoDaysBefore(nowMs, index % 400)],
      sql: `insert or ignore into findings (track_id, log_id, added_at) values (?, ?, ?)`,
    },
  ];
}

export async function seedScale(client: Client, opts: ScaleSeedOptions = {}): Promise<void> {
  const scale = opts.scale ?? envInt("BENCH_SCALE", 150_000);
  const findings = opts.findings ?? envInt("SCALE_FINDINGS", 2_000);
  const resolved: Resolved = {
    albums: opts.albums ?? envInt("SCALE_ALBUMS", 25_000),
    artistSocials: opts.artistSocials ?? envInt("SCALE_ARTIST_SOCIALS", 40_000),
    artists: opts.artists ?? envInt("SCALE_ARTISTS", 30_000),
    catalogue: Math.max(0, scale - findings),
    demandZeroEvery: Math.max(
      1,
      opts.demandZeroEvery ?? envInt("SCALE_FRONTIER_DEMAND_ZERO_EVERY", 50),
    ),
    findings,
    frontier: opts.frontier ?? envInt("SCALE_FRONTIER", 90_000),
    labels: opts.labels ?? envInt("SCALE_LABELS", 500),
  };
  const nowMs = Date.parse(opts.nowIso ?? SEED_NOW);

  console.log(
    `seedScale — tracks=${scale} (catalogue=${resolved.catalogue} + findings=${resolved.findings}), ` +
      `artists=${resolved.artists}, labels=${resolved.labels}, albums=${resolved.albums}, ` +
      `crawl_frontier=${resolved.frontier}, artist_socials=${resolved.artistSocials}`,
  );

  await writeChunked(client, opts, "labels", resolved.labels, (index) => {
    const seedState = index < 5 ? "enabled" : index % 7 === 0 ? "disabled" : "undecided";
    const stamp = isoDaysBefore(nowMs, index % 400);

    return [
      {
        args: [`label-${index}`, `Label ${index}`, `label-${index}`, seedState, stamp, stamp],
        sql: `insert or ignore into labels (id, name, slug, seed_state, created_at, updated_at)
              values (?, ?, ?, ?, ?, ?)`,
      },
    ];
  });

  await writeChunked(client, opts, "albums", resolved.albums, (index) => {
    const stamp = isoDaysBefore(nowMs, index % 400);

    return [
      {
        args: [`album-${index}`, `Album ${index}`, `album-${index}`, stamp, stamp],
        sql: `insert or ignore into albums (id, name, slug, created_at, updated_at) values (?, ?, ?, ?, ?)`,
      },
    ];
  });

  await writeChunked(client, opts, "artists", resolved.artists, (index) => {
    const stamp = isoDaysBefore(nowMs, index % 400);

    return [
      {
        args: [
          `artist-${index}`,
          artistName(index),
          `artist-${index}`,
          stamp,
          stamp,
          index % 3 === 0 ? `https://i.scdn.co/image/artist-${index}` : null,
          index % 4 === 0 ? `spotify-artist-${index}` : null,
        ],
        sql: `insert or ignore into artists (id, name, slug, created_at, updated_at, image_url, spotify_artist_id)
              values (?, ?, ?, ?, ?, ?, ?)`,
      },
    ];
  });

  await writeChunked(client, opts, "catalogue", resolved.catalogue, (index) => [
    { args: catalogueTrackArgs(index, nowMs, resolved), sql: TRACK_SQL },

    ...(catalogueIsEmbedded(index)
      ? [{ args: [`cat-${index}`, EMBEDDING_BLOB], sql: TRACK_EMBEDDING_SQL }]
      : []),
  ]);
  await writeChunked(client, opts, "findings", resolved.findings, (index) =>
    findingStatements(index, nowMs, resolved),
  );

  await writeChunked(client, opts, "track_artists", scale, (index) => {
    const isCatalogue = index < resolved.catalogue;
    const trackId = isCatalogue ? `cat-${index}` : `find-${index - resolved.catalogue}`;
    const seq = isCatalogue ? index : index - resolved.catalogue;
    const lead = seq % resolved.artists;
    const feat = (seq * 7 + 3) % resolved.artists;
    const statements: SeedStatement[] = [
      {
        args: [trackId, `artist-${lead}`, 1],
        sql: `insert or ignore into track_artists (track_id, artist_id, position) values (?, ?, ?)`,
      },
    ];

    if (seq % 2 === 0 && feat !== lead) {
      statements.push({
        args: [trackId, `artist-${feat}`, 2],
        sql: `insert or ignore into track_artists (track_id, artist_id, position) values (?, ?, ?)`,
      });
    }

    return statements;
  });

  await writeChunked(client, opts, "crawl_frontier", resolved.frontier, (index) => {
    const kind = index % 211 === 0 ? "label" : index % 3 === 0 ? "release" : "artist";
    const source = kind === "label" ? "musicbrainz" : index % 499 === 0 ? "fluncle" : "musicbrainz";
    const state =
      index % 23 === 0
        ? "pending"
        : index % 97 === 0
          ? "failed"
          : index % 89 === 0
            ? "skipped"
            : "done";

    const nodeSeq = Math.floor(index / 211);
    const labelSlug =
      kind === "label" && nodeSeq % 2 === 0
        ? `label-${nodeSeq % 5}`
        : `label-${index % resolved.labels}`;
    const externalId = `mbid-${index}`;
    const doneAt = state === "done" ? isoDaysBefore(nowMs, 2 + (index % 400)) : null;
    const stamp = isoDaysBefore(nowMs, index % 400);

    return [
      {
        args: [
          `${source}:${kind}:${externalId}`,
          kind,
          state,
          source,
          externalId,
          index % 3,
          index % resolved.demandZeroEvery === 0 ? 0 : 1,
          doneAt,
          labelSlug,
          stamp,
          stamp,
        ],
        sql: `insert or ignore into crawl_frontier
                (id, kind, state, source, external_id, hop, demand_rank, done_at, label_slug, created_at, updated_at)
              values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      },
    ];
  });

  await writeChunked(client, opts, "artist_socials", resolved.artistSocials, (index) => {
    const artistIndex = index % resolved.artists;
    const platform =
      PLATFORMS[Math.floor(index / resolved.artists) % PLATFORMS.length] ?? "homepage";
    const status = index % 97 === 0 ? "candidate" : index % 2 === 0 ? "auto" : "confirmed";
    const reviewedAt = index % 10 < 7 ? null : isoDaysBefore(nowMs, index % 300);
    const stamp = isoDaysBefore(nowMs, 5 + (index % 380));

    return [
      {
        args: [
          `social-${index}`,
          `artist-${artistIndex}`,
          platform,
          `https://example.com/${platform}/${artistIndex}`,
          SOCIAL_SOURCES[index % SOCIAL_SOURCES.length] ?? "musicbrainz",
          status,
          reviewedAt,
          stamp,
          stamp,
        ],
        sql: `insert or ignore into artist_socials
                (id, artist_id, platform, url, source, status, reviewed_at, created_at, updated_at)
              values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      },
    ];
  });

  await reconcileHubCounts(client, opts);
}

async function reconcileHubCounts(client: Client, opts: ScaleSeedOptions): Promise<void> {
  const statements = [
    `update labels set
       renderable_track_count = (select count(*) from tracks where tracks.label_id = labels.id),
       certified_finding_count = (select count(*) from tracks
                                  where tracks.label_id = labels.id and tracks.is_catalogue = 0)`,
    `update albums set
       renderable_track_count = (select count(*) from tracks where tracks.album_id = albums.id),
       certified_finding_count = (select count(*) from tracks
                                  where tracks.album_id = albums.id and tracks.is_catalogue = 0)`,
    `update artists set
       renderable_track_count = (select count(*) from track_artists ta where ta.artist_id = artists.id),
       certified_finding_count = (select count(*) from track_artists ta
                                  join tracks t on t.track_id = ta.track_id
                                  where ta.artist_id = artists.id and t.is_catalogue = 0)`,
  ];

  for (const sql of statements) {
    await client.execute(sql);
  }

  emit(opts, "  hub counts reconciled (labels, albums, artists)");
  process.stdout.write("\n");
}
