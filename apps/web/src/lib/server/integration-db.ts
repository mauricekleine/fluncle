// Real-libSQL integration harness. Vitest runs under the `node` environment, so
// the node `@libsql/client` (NOT the `/web` HTTP-only build the Worker uses) can
// open an in-memory SQLite database here — something workerd cannot do. We apply
// the repo's GENERATED Drizzle migrations from `apps/web/drizzle` so the schema
// under test is byte-identical to production; no hand-written SQL.
//
// Tests `vi.mock("./db", …)` to point `getDb()` at the client this returns, so the
// REAL query functions (account-data, submissions, …) execute REAL SQL against the
// REAL schema. This file is intentionally NOT a `*.test.ts`, so vitest's
// `include: src/**/*.test.{ts,tsx}` never picks it up as a suite.

import { type Client, createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { fileURLToPath } from "node:url";
import { backfillHubCounts } from "../../../scripts/backfill-hub-counts";
import { ensureSearchIndex } from "../../db/search-index";
import {
  CLEAR_EMBEDDING_SQL,
  clearEmbeddingSatellite,
  SET_EMBEDDING_SQL,
  writeEmbeddingSatellite,
} from "./embedding";
import { resetKeyHistogramCache } from "./key-histogram";
import { insertTrackDuplicateKeyStatement } from "./track-duplicate-keys";

const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));

/**
 * A fresh in-memory libSQL database with every generated Drizzle migration
 * applied. Each call is an isolated `:memory:` database (no cross-test leakage),
 * so a test can `beforeEach(async () => { db = await createIntegrationDb(); })`.
 *
 * The FTS5 search index is built here too, by the SAME `ensureSearchIndex` the deploy and
 * every local dev boot run (`db:migrate`, see `src/db/search-index.ts`). It is not a
 * migration — it is a derived artifact — so this is where a test picks it up, and it means
 * the DDL under test is byte-identical to production's, exactly like the migrations are.
 */
export async function createIntegrationDb(): Promise<Client> {
  const client = createClient({ url: ":memory:" });

  await client.batch(
    (await schemaDdl()).map((sql) => ({ args: [], sql })),
    "write",
  );
  await ensureSearchIndex(client);
  // An isolate-level memo outlives a fixture, so "no cross-test leakage" has to cover the module
  // caches too — otherwise one suite's archive answers the next suite's read. The key histogram
  // (key-histogram.ts, the `/mix` depth gate + rail pre-filter) is the one such cache on this path.
  resetKeyHistogramCache();

  return client;
}

/** The captured end-state DDL, built once per worker process and reused by every later call. */
let capturedDdl: Promise<string[]> | undefined;

/**
 * THE SCHEMA, CAPTURED ONCE — replay the END STATE instead of the 131-migration chain.
 *
 * `migrate()` replays every generated migration in order, which for a schema this old means
 * re-parsing 131 files and re-running the whole ALTER/CREATE history to arrive somewhere the
 * final DDL describes directly. That is ~107 ms, and 64 of the 66 files using this harness call
 * it from `beforeEach` — so it is paid PER TEST, 968 times: ~102 s of CPU
 * out of the suite's ~294 s, purely rebuilding the same schema. It also grew with every migration
 * added, which is the wrong direction for a number multiplied by a thousand.
 *
 * So the chain runs ONCE per worker process, into a throwaway template, and what is kept is the
 * `sqlite_master` DDL it produced. Replaying that into a fresh `:memory:` database costs ~4 ms —
 * 26× cheaper — and lands the identical schema (261 objects either way, asserted by
 * `integration-db.test.ts`). Ordering is `rowid`, which is creation order, so a table always
 * precedes the indexes and triggers hanging off it.
 *
 * WHY THIS IS STILL "byte-identical to production". The DDL is not hand-written: it is what the
 * generated migrations THEMSELVES produced a moment earlier in this process. If a migration is
 * added, edited, or reordered, the template rebuilds from it on the next run and the captured DDL
 * moves with it — there is nothing to keep in sync. `sqlite_%` objects are excluded because SQLite
 * owns them (autoindexes come back with their table); the FTS5 index is not here either — it is a
 * derived artifact that `ensureSearchIndex` still builds per database, exactly as before.
 */
function schemaDdl(): Promise<string[]> {
  capturedDdl ??= (async () => {
    const template = createClient({ url: ":memory:" });

    await migrate(drizzle(template), { migrationsFolder });

    const result = await template.execute(
      `select sql from sqlite_master
       where sql is not null and name not like 'sqlite_%'
       order by rowid`,
    );

    template.close();

    // `where sql is not null` above already excludes the null rows, so every value here is DDL
    // text; the cast is the row-shape assertion libSQL's `unknown` cells always need.
    return (result.rows as unknown as { sql: string }[]).map((row) => row.sql);
  })();

  return capturedDdl;
}

/**
 * Bring the MAINTAINED hub counters (`renderable_track_count` / `certified_finding_count` on
 * labels/albums/artists — keystone 2) into agreement with the edges a fixture just seeded.
 *
 * In production those two integers are moved as DELTAS by the write paths (lib/server/hub-counts.ts),
 * and every entity-hub read — the `/labels` //albums //artists indexes, the API + MCP list ops, the
 * sitemap rows, search's entity gate, the three bio worklists — now reads them instead of grouping
 * `tracks` / `track_artists`. A fixture that inserts rows straight into those tables bypasses the
 * delta writers, so its world would be internally inconsistent: edges present, counters at the DDL
 * default of 0. Call this after seeding and the fixture matches what production holds.
 *
 * It is the REAL deploy backfill (`scripts/backfill-hub-counts.ts`, forced past its once-only guard)
 * rather than a re-statement of the arithmetic, so a test's counters can never define "certified"
 * differently from the write side.
 */
export async function syncHubCounts(client: Client): Promise<void> {
  await backfillHubCounts(client, { force: true });
}

/** Returns how many rows a table holds. */
export async function rowCount(client: Client, table: string): Promise<number> {
  // `table` is a fixed test-supplied identifier (never user input), so it is safe
  // to interpolate; libSQL has no bind slot for identifiers.
  const result = await client.execute(`select count(*) as n from "${table}"`);

  return Number(result.rows[0]?.n ?? 0);
}

type SeedUser = {
  createdAt?: number;
  displayUsername?: null | string;
  email: string;
  id: string;
  name?: string;
  status?: "active" | "deleted" | "suspended";
  username?: null | string;
};

/** Inserts a `user` row (better-auth shape). Millisecond-epoch timestamps. */
export async function seedUser(client: Client, user: SeedUser): Promise<void> {
  const now = user.createdAt ?? Date.now();

  await client.execute({
    args: [
      user.id,
      user.email,
      user.name ?? "Test User",
      user.username ?? null,
      user.displayUsername ?? null,
      user.status ?? "active",
      now,
      now,
    ],
    sql: `insert into "user"
      (id, email, name, username, display_username, status, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?)`,
  });
}

type SeedTrack = {
  /** The finding's found-date (ISO). Defaults to now; set it to control feed ordering. */
  addedAt?: string;
  addedToSpotify?: boolean;
  artists?: string[];
  durationMs?: number;
  /** The raw release label — the capture ladder's `label`/`seed-label`/veto rungs read it. */
  label?: null | string;
  /** NULL seeds an UNCHARTED finding (no coordinate) — the rows the public reads exclude. */
  logId: null | string;
  postedToTelegram?: boolean;
  title?: string;
  trackId: string;
};

/**
 * Seeds a minimal CERTIFIED finding — the `tracks` row (the recording) AND its
 * `findings` row (the certification), the pair `publishTrack` mints together. Only the
 * columns the tests read. To seed an UNCERTIFIED catalogue track (a `tracks` row with no
 * `findings` row — the shape every finding read must exclude), use `seedCatalogueTrack`.
 */
export async function seedTrack(client: Client, track: SeedTrack): Promise<void> {
  const addedAt = track.addedAt ?? new Date().toISOString();

  await seedCatalogueTrack(client, track);
  await client.execute({
    args: [
      track.trackId,
      track.logId,
      addedAt,
      track.addedToSpotify ? 1 : 0,
      track.postedToTelegram ? 1 : 0,
    ],
    sql: `insert into findings
      (track_id, log_id, added_at, added_to_spotify, posted_to_telegram)
      values (?, ?, ?, ?, ?)`,
  });
  // A certified track HAS a findings row, so the maintained catalogue flag is 0 — mirror the write
  // sites (publishTrack / certifyExistingTrack) so every read that filters on `is_catalogue` sees a
  // finding as NON-catalogue, exactly as production does. seedCatalogueTrack leaves it at the DDL
  // default (1); this is the certified-track flip.
  await client.execute({
    args: [track.trackId],
    sql: `update tracks set is_catalogue = 0 where track_id = ?`,
  });
}

/**
 * Seeds ONLY the `tracks` half — a catalogue track Fluncle has NOT certified. It carries
 * no Log ID, no note, no video, no found date, because it has no `findings` row at all.
 * Every finding surface must be blind to it (that is the point of the split), so this is
 * the fixture a test uses to prove a read really does join through the certification.
 */
export async function seedCatalogueTrack(
  client: Client,
  track: Omit<SeedTrack, "addedToSpotify" | "logId" | "postedToTelegram">,
): Promise<void> {
  const title = track.title ?? "Test Track";
  const artistsJson = JSON.stringify(track.artists ?? ["Test Artist"]);

  await client.batch(
    [
      {
        args: [
          track.trackId,
          title,
          artistsJson,
          `spotify:track:${track.trackId}`,
          `https://open.spotify.com/track/${track.trackId}`,
          // A realistic DnB single, NOT 0: the capture queue vetoes both duration tails
          // (MIN_TRACK_MS ≤ d < LONG_FORM_MS), so a zero-duration default would silently
          // veto every fixture out of the queue. Tests that probe the vetoes set their own.
          track.durationMs ?? 270_000,
          track.label ?? null,
        ],
        sql: `insert into tracks
      (track_id, title, artists_json, spotify_uri, spotify_url, duration_ms, label)
      values (?, ?, ?, ?, ?, ?, ?)`,
      },
      insertTrackDuplicateKeyStatement({
        artistsJson,
        isrc: null,
        title,
        trackId: track.trackId,
      }),
    ],
    "write",
  );
}

/**
 * THE EMBED WRITE, as the pipeline performs it — the `track_embeddings` satellite row AND its
 * `has_embedding` mirror, in ONE write batch (schema.ts § `has_embedding`). Fixtures must go
 * through this rather than a bare satellite insert: the mirror is what `/admin/funnel`'s covering
 * stage scan and both partial queue indexes read, so a fixture that writes only the vector seeds a
 * state production cannot reach, and the funnel's fold-equivalence test rightly fails on it. Pass
 * `null` to CLEAR both halves (the quarantine paths' shape).
 *
 * It drives the SAME shared statements the Worker writes through (embedding.ts), so a fixture and
 * production cannot diverge — including the clear's mirror-driven delete ordering.
 */
export async function seedEmbedding(
  client: Client,
  trackId: string,
  vector: null | number[],
): Promise<void> {
  if (vector === null) {
    await client.batch(
      [
        {
          args: [trackId],
          sql: `update tracks set ${CLEAR_EMBEDDING_SQL} where track_id = ?`,
        },
        clearEmbeddingSatellite(trackId),
      ],
      "write",
    );

    return;
  }

  await client.batch(
    [
      {
        args: [trackId],
        sql: `update tracks set ${SET_EMBEDDING_SQL} where track_id = ?`,
      },
      writeEmbeddingSatellite(trackId, JSON.stringify(vector)),
    ],
    "write",
  );
}

type SeedEntity = {
  id: string;
  name?: string;
  slug: string;
};

/** Inserts an `artists` row — the columns a watch join reads (id, name, slug). */
export async function seedArtist(client: Client, artist: SeedEntity): Promise<void> {
  const now = new Date().toISOString();

  await client.execute({
    args: [artist.id, artist.name ?? "Test Artist", artist.slug, now, now],
    sql: `insert into artists (id, name, slug, created_at, updated_at)
      values (?, ?, ?, ?, ?)`,
  });
}

/** Inserts a `labels` row — the columns a watch join reads (id, name, slug). */
export async function seedLabel(client: Client, label: SeedEntity): Promise<void> {
  const now = new Date().toISOString();

  await client.execute({
    args: [label.id, label.name ?? "Test Label", label.slug, now, now],
    sql: `insert into labels (id, name, slug, created_at, updated_at)
      values (?, ?, ?, ?, ?)`,
  });
}

/** Inserts an `albums` row — the columns the graph pages + cover chain read (id, name, slug). */
export async function seedAlbum(client: Client, album: SeedEntity): Promise<void> {
  const now = new Date().toISOString();

  await client.execute({
    args: [album.id, album.name ?? "Test Album", album.slug, now, now],
    sql: `insert into albums (id, name, slug, created_at, updated_at)
      values (?, ?, ?, ?, ?)`,
  });
}

type SeedMixtape = {
  addedAt?: string;
  durationMs?: number;
  id: string;
  /** The `F`-marked mixtape coordinate. NULL leaves the mixtape unminted (out of the feed). */
  logId: null | string;
  note?: null | string;
  sequenceNumber?: null | number;
  status?: "distributing" | "published";
  title?: string;
};

/**
 * Inserts a `mixtapes` row (the dream checkpoint). A `published` mixtape with a
 * `log_id` + `added_at` is what the public feed's mixtape arm reads
 * (`listPublishedMixtapeFeedRows`); the defaults seed exactly that.
 */
export async function seedMixtape(client: Client, mixtape: SeedMixtape): Promise<void> {
  const now = new Date().toISOString();

  await client.execute({
    args: [
      mixtape.id,
      mixtape.logId,
      mixtape.sequenceNumber ?? null,
      mixtape.title ?? "Test Mixtape",
      mixtape.status ?? "published",
      mixtape.note ?? null,
      mixtape.durationMs ?? 3_600_000,
      mixtape.addedAt ?? now,
      now,
      now,
    ],
    sql: `insert into mixtapes
      (id, log_id, sequence_number, title, status, note, duration_ms, added_at, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  });
}

type SeedSubmission = {
  contact?: null | string;
  createdAt?: string;
  id: string;
  source?: "cli" | "ssh" | "web";
  spotifyTrackId: string;
  status?: "approved" | "pending" | "rejected";
  submitterHash?: string;
  title?: string;
  userId?: null | string;
};

/** Inserts a `submissions` row (the user-scoped + admin-review paths read it). */
export async function seedSubmission(client: Client, submission: SeedSubmission): Promise<void> {
  await client.execute({
    args: [
      submission.id,
      submission.spotifyTrackId,
      `https://open.spotify.com/track/${submission.spotifyTrackId}`,
      submission.title ?? "Submitted Track",
      JSON.stringify(["Submitter Artist"]),
      submission.contact ?? null,
      submission.source ?? "web",
      submission.status ?? "pending",
      submission.submitterHash ?? "hash",
      submission.createdAt ?? new Date().toISOString(),
      submission.userId ?? null,
    ],
    sql: `insert into submissions
      (id, spotify_track_id, spotify_url, title, artists_json, contact, source, status,
       submitter_hash, created_at, user_id)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  });
}
