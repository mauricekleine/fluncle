/**
 * THROWAWAY HOSTED-SCALE SEEDER — the shared 150k regime behind `bench-db-scale.ts`. NOT a test,
 * NOT wired into CI, NOT a migration.
 *
 * ── WHAT IT IS ────────────────────────────────────────────────────────────────
 * `seedScale(client, opts)` populates EVERY table the DB-scale backlog (docs/db-scale-backlog.md,
 * Wave 1 items 6 + 8–19) touches — `tracks` / `findings` / `artists` / `track_artists` / `labels` /
 * `albums` / `crawl_frontier` / `artist_socials` — at a realistic 150k-track regime, with the exact
 * columns each item's predicate reads, in distributions that make each proof meaningful (a big
 * imprint for the label cover subquery, a rare terminal-capture slice for the quarantine lens, a
 * near-1.0 duplicate prefix for the Ear lens, a mostly-unreviewed socials set for the review queue).
 *
 * It is DETERMINISTIC (every value derives from the row index — no `Math.random`, no `Date.now`; the
 * one "now" is `opts.nowIso`, default {@link SEED_NOW}) and IDEMPOTENT (`insert or ignore` in 500-row
 * `client.batch(…, "write")` chunks), so a re-seed of a half-populated scratch DB converges.
 *
 * ── WHO RUNS IT ───────────────────────────────────────────────────────────────
 * The OPERATOR, against a SCRATCH hosted Turso Cloud DB, via `bench-db-scale.ts`. It never points at
 * `fluncle`/`fluncle-dev`/local (the bench guards the URL). `turso dev` is NOT a valid target for the
 * numbers this feeds (docs/local-database.md "Local is not production").
 *
 * ── A NOTE ON `crawl_frontier.demand_rank` ───────────────────────────────────
 * The brief's parenthetical said "mostly 0", but item 6's own fix — a partial index that "seeks
 * exactly the promoted rows" — only reads as a proof when `demand_rank = 0` is the RARE promoted
 * slice (production: `record_demand` clears every node to 1, then promotes a handful to 0). So the
 * default seeds `demand_rank = 0` on ~1-in-`demandZeroEvery` nodes (rare); set `demandZeroEvery = 1`
 * (or `SCALE_FRONTIER_DEMAND_ZERO_EVERY=1`) to force the literal "mostly 0" if wanted.
 */
import { type Client } from "@libsql/client/web";

/** The one fixed "now" — every derived stamp is relative to this, so a seed is fully deterministic. */
export const SEED_NOW = "2026-07-24T00:00:00.000Z";

const DAY_MS = 24 * 60 * 60 * 1000;
const CHUNK = 500;

/** The 24 canonical scale spellings — the realistic key domain (mirrors the tracks-hub bench). */
const KEYS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"].flatMap((pitch) => [
  `${pitch} major`,
  `${pitch} minor`,
]);

/** The raw `tracks.label` string domain (the imprint names, distinct from the `label_id` graph key). */
const LABELS = ["Hospital Records", "Shogun Audio", "Critical Music", "Metalheadz", "V Recordings"];

/** The `artist_socials.platform` enum (schema.ts) — the social surfaces only. */
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

/**
 * A raw 4096-byte blob (1024 × float32) — the size a MuQ `embedding_blob` occupies, so a seeded
 * embedded row SPILLS off the page exactly like a real one (the cost item 12's partial index dodges).
 * The bytes are a deterministic pattern; the value never matters here (no bench probes it), only the
 * width and its presence/absence. Reused by reference across every embedded row.
 */
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
  /** How often a `crawl_frontier` node is born `demand_rank = 0` (1-in-N). Default 50 (~2% rare). */
  demandZeroEvery?: number;
  findings?: number;
  frontier?: number;
  labels?: number;
  /** The fixed "now" every stamp derives from. Default {@link SEED_NOW}. */
  nowIso?: string;
  /** Progress sink. Default writes `\r <table> <n>/<count>` to stdout (the exemplar's shape). */
  onProgress?: (line: string) => void;
  /** Total `tracks` rows (catalogue + findings-backed). Default 150_000. */
  scale?: number;
};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];

  return raw ? Number.parseInt(raw, 10) : fallback;
}

/** ISO of `days` before `nowMs` — the deterministic past stamp helper. */
function isoDaysBefore(nowMs: number, days: number): string {
  return new Date(nowMs - days * DAY_MS).toISOString();
}

/**
 * A deterministic `YYYY-MM-DD` release date for a row, spread across 2005–2026 with ties common
 * (the realistic case for the `track_id` tiebreak). Lower index = NEWER. Adapted from the tracks-hub
 * bench's `releaseDateForIndex`, which hard-codes 3 rows/day and so overflows the window at 150k —
 * here the span is divided by the row count so the whole set lands inside 2005–2026 at any scale.
 */
function releaseDateForIndex(index: number, total: number): string {
  const start = Date.UTC(2005, 0, 1);
  const end = Date.UTC(2026, 11, 31);
  const spanDays = Math.floor((end - start) / DAY_MS);
  const day = Math.floor((index / Math.max(1, total)) * spanDays);

  return new Date(end - day * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The `label_id` graph key for a catalogue row — a FEW mega-labels holding tens of thousands of rows
 * (so item 15's cover subquery sorts a big imprint) plus a long tail. `label-0` is the mega imprint.
 */
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

/** The display name for an artist, with deliberate case variety so item 11's NOCASE fold has work. */
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

/** Chunked idempotent write of a generated statement stream, with `\r` progress like the exemplar. */
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

    await client.batch(statements, "write");
    emit(opts, `  ${label} ${end}/${count}`);
  }

  process.stdout.write("\n");
}

const TRACK_COLUMNS = `track_id, title, artists_json, duration_ms, release_date, bpm, key, label,
  label_id, album_id, album_image_url, capture_status, capture_priority, nearest_finding_score,
  nearest_finding_track_id, duplicate_of_track_id, catalogue_ranked_at, source_audio_key,
  analyzed_from, analyzed_at, embedding_blob, spotify_uri, isrc, apple_music_url,
  backfill_apple_music_done_at, backfill_apple_music_attempted_at`;

const TRACK_SQL = `insert or ignore into tracks (${TRACK_COLUMNS})
  values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

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

/**
 * One catalogue track (a `tracks` row with NO `findings` row) — the crawler's output, and the body
 * every anti-join / Ear / capture / worklist item scans. The distributions are chosen per item:
 *   - `capture_status`   — a RARE terminal slice (wrong-audio / unmatched / failed) for item 14.
 *   - `nearest_finding_score` + `duplicate_of_track_id` — a near-1.0 duplicate prefix for item 19.
 *   - `source_audio_key` / `analyzed_from` — a captured analyze backlog for item 12.
 *   - `apple_music_url` / `backfill_apple_music_*` / `isrc` — the barely-shrinking Apple slice (13).
 *   - `label_id` — the mega-imprint + long tail for item 15; `embedding_blob` the page-spill width.
 */
function catalogueTrackArgs(index: number, nowMs: number, opts: Resolved): SeedValue[] {
  const trackId = `cat-${index}`;
  const captured = index % 5 < 2;
  const hasEmbedding = captured && index % 2 === 0;
  const albumId = `album-${index % opts.albums}`;

  const captureStatus =
    index % 500 === 0
      ? "wrong-audio"
      : index % 500 === 1
        ? "unmatched"
        : index % 500 === 2
          ? "failed"
          : captured
            ? "done"
            : "pending";
  const isTerminal =
    captureStatus === "wrong-audio" || captureStatus === "unmatched" || captureStatus === "failed";

  const nearestScore = hasEmbedding
    ? index % 74 === 0
      ? 0.995 + (index % 5) * 0.001
      : 0.3 + (index % 65) / 100
    : null;
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
  // A row is analyzed only once analysis ran — a captured-but-never-analyzed row (analyzed_from
  // null) keeps analyzed_at null, so it lands honestly in item 12's analyze backlog.
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
    hasEmbedding ? EMBEDDING_BLOB : null,
    index % 10 < 7 ? null : `spotify:track:${trackId}`,
    index % 23 === 0 ? null : `GB${String(index).padStart(8, "0")}`,
    index % 20 === 0 ? `https://music.apple.com/us/song/${index}` : null,
    appleDone,
    appleAttempted,
  ];
}

/** One certified finding — a `tracks` row PLUS its `findings` row (the certification half). */
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
    // Catalogue-only ranking columns stay NULL on a finding (the rank sweep anti-joins findings).
    null,
    null,
    null,
    null,
    null,
    `${trackId}/${(index * 40503) % 1_000_000}.mp3`,
    "full",
    isoDaysBefore(nowMs, 3 + (index % 120)),
    EMBEDDING_BLOB,
    `spotify:track:${trackId}`,
    `GBFND${String(index).padStart(6, "0")}`,
    index % 4 === 0 ? `https://music.apple.com/us/song/f${index}` : null,
    index % 4 === 0 ? isoDaysBefore(nowMs, 10 + (index % 60)) : null,
    index % 3 === 0 ? isoDaysBefore(nowMs, 10 + (index % 200)) : null,
  ];

  return [
    { args: trackArgs, sql: TRACK_SQL },
    {
      args: [trackId, `${String(index).padStart(4, "0")}.7.1A`, isoDaysBefore(nowMs, index % 400)],
      sql: `insert or ignore into findings (track_id, log_id, added_at) values (?, ?, ?)`,
    },
  ];
}

/**
 * Seed the whole 150k regime. See the file header. Every count is `opts.X ?? env ?? default`, so the
 * bench can pass an explicit `scale` and let the rest fall to env knobs (`SCALE_ARTISTS`, `SCALE_LABELS`,
 * `SCALE_ALBUMS`, `SCALE_FRONTIER`, `SCALE_ARTIST_SOCIALS`, `SCALE_FINDINGS`, `SCALE_FRONTIER_DEMAND_ZERO_EVERY`).
 */
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

  // ── labels (slug-keyed; the first 5 ENABLED so item 16's enabled-set join has seeds) ──────────
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

  // ── albums (slug-keyed) ───────────────────────────────────────────────────────────────────────
  await writeChunked(client, opts, "albums", resolved.albums, (index) => {
    const stamp = isoDaysBefore(nowMs, index % 400);

    return [
      {
        args: [`album-${index}`, `Album ${index}`, `album-${index}`, stamp, stamp],
        sql: `insert or ignore into albums (id, name, slug, created_at, updated_at) values (?, ?, ?, ?, ?)`,
      },
    ];
  });

  // ── artists (NOCASE-varied names for item 11; image_url / spotify_artist_id on a subset) ──────
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

  // ── tracks (catalogue body + findings-backed rows, each with its findings row) ────────────────
  await writeChunked(client, opts, "catalogue", resolved.catalogue, (index) => [
    { args: catalogueTrackArgs(index, nowMs, resolved), sql: TRACK_SQL },
  ]);
  await writeChunked(client, opts, "findings", resolved.findings, (index) =>
    findingStatements(index, nowMs, resolved),
  );

  // ── track_artists (~1.5 edges/track: one lead always, a second on even rows) ──────────────────
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

  // ── crawl_frontier (~90k; most `done` once the graph drains; ~a few hundred label/mb nodes for
  // item 16) ─ The kind/state/demand moduli are PRIME and pairwise-coprime so they never collude:
  // a naive `kind at i%200` + `state pending at i%20` would make EVERY label node pending (200 is a
  // multiple of 20), leaving item 16's `state='done' AND kind='label'` proof with zero rows. ──────
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
    // A label node carries its own seed label as `label_slug`; biasing ~half of them into the
    // ENABLED set (label-0..4) gives item 16 a healthy done+enabled+recent qualifying set to seek.
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

  // ── artist_socials (~40k; rare `candidate` slice, mostly-unreviewed set — items 17/18) ─────────
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
}
