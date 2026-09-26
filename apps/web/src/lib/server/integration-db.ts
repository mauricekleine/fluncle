import { type Client, createClient } from "@libsql/client";
import { LOCAL_DB_CONCURRENCY } from "../database-concurrency";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { fileURLToPath } from "node:url";
import { backfillHubCounts } from "../../../scripts/backfill-hub-counts";
import { crawlDueDefinitionVersion } from "./crawl-due-work";
import { DUE_WORK_BACKFILLS } from "./due-work-registry";
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

export async function createIntegrationDb(options: { url?: string } = {}): Promise<Client> {
  const client = createClient({
    concurrency: LOCAL_DB_CONCURRENCY,
    url: options.url ?? ":memory:",
  });

  await client.batch(
    (await schemaDdl()).map((sql) => ({ args: [], sql })),
    "write",
  );
  await ensureSearchIndex(client);

  resetKeyHistogramCache();

  return client;
}

let capturedDdl: Promise<string[]> | undefined;

function schemaDdl(): Promise<string[]> {
  capturedDdl ??= (async () => {
    const template = createClient({ concurrency: LOCAL_DB_CONCURRENCY, url: ":memory:" });

    await migrate(drizzle(template), { migrationsFolder });

    const result = await template.execute(
      `select sql from sqlite_master
       where sql is not null and name not like 'sqlite_%'
       order by rowid`,
    );

    template.close();

    return (result.rows as unknown as { sql: string }[]).map((row) => row.sql);
  })();

  return capturedDdl;
}

export async function syncHubCounts(client: Client): Promise<void> {
  await backfillHubCounts(client, { force: true });
}

export async function rowCount(client: Client, table: string): Promise<number> {
  const result = await client.execute(`select count(*) as n from "${table}"`);

  return Number(result.rows[0]?.n ?? 0);
}

type SeedUser = {
  createdAt?: number;
  displayUsername?: null | string;
  email: string;
  emailVerified?: boolean;
  id: string;
  name?: string;
  status?: "active" | "deleted" | "suspended";
  username?: null | string;
};

export async function seedUser(client: Client, user: SeedUser): Promise<void> {
  const now = user.createdAt ?? Date.now();

  await client.execute({
    args: [
      user.id,
      user.email,
      user.emailVerified ? 1 : 0,
      user.name ?? "Test User",
      user.username ?? null,
      user.displayUsername ?? null,
      user.status ?? "active",
      now,
      now,
    ],
    sql: `insert into "user"
      (id, email, email_verified, name, username, display_username, status, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  });
}

type SeedTrack = {
  addedAt?: string;
  addedToSpotify?: boolean;
  artists?: string[];
  durationMs?: number;

  label?: null | string;

  logId: null | string;
  postedToTelegram?: boolean;
  title?: string;
  trackId: string;
};

export async function seedTrack(
  client: Pick<Client, "batch" | "execute">,
  track: SeedTrack,
): Promise<void> {
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

  await client.execute({
    args: [track.trackId],
    sql: `update tracks set is_catalogue = 0 where track_id = ?`,
  });
}

export async function seedCatalogueTrack(
  client: Pick<Client, "batch" | "execute">,
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

export async function seedEmbedding(
  client: Pick<Client, "batch" | "execute">,
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

export async function seedArtist(client: Client, artist: SeedEntity): Promise<void> {
  const now = new Date().toISOString();

  await client.execute({
    args: [artist.id, artist.name ?? "Test Artist", artist.slug, now, now],
    sql: `insert into artists (id, name, slug, created_at, updated_at)
      values (?, ?, ?, ?, ?)`,
  });
}

export async function seedLabel(client: Client, label: SeedEntity): Promise<void> {
  const now = new Date().toISOString();

  await client.execute({
    args: [label.id, label.name ?? "Test Label", label.slug, now, now],
    sql: `insert into labels (id, name, slug, created_at, updated_at)
      values (?, ?, ?, ?, ?)`,
  });
}

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

  logId: null | string;
  note?: null | string;
  sequenceNumber?: null | number;
  status?: "distributing" | "published";
  title?: string;
};

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

const EMPTY_DIGEST = "0".repeat(64);

export async function seedConvergedDueWorkRebuilds(client: Client): Promise<void> {
  const now = new Date().toISOString();
  await client.batch(
    [
      ...DUE_WORK_BACKFILLS.map((definition) => ({
        args: [
          definition.workKind,
          definition.subjectType,
          definition.definitionVersion,
          `converged-${definition.workKind}`,
          now,
          now,
          now,
        ],
        sql: `insert into due_work_rebuilds
          (work_kind, subject_type, definition_version, generation, cursor, scanned_count,
           projected_count, state, started_at, updated_at, completed_at)
          values (?, ?, ?, ?, null, 0, 0, 'complete', ?, ?, ?)
          on conflict(work_kind, subject_type) do update set
            definition_version = excluded.definition_version, state = 'complete'`,
      })),
      {
        args: [crawlDueDefinitionVersion(), now, now, now, EMPTY_DIGEST, EMPTY_DIGEST],
        sql: `insert into crawl_due_work_rebuilds
          (scope, definition_version, generation, cursor, scanned_count, projected_count, state,
           started_at, updated_at, completed_at, source_digest, projected_digest)
          values ('frontier', ?, 'converged-crawl', null, 0, 0, 'complete', ?, ?, ?, ?, ?)
          on conflict(scope) do update set
            definition_version = excluded.definition_version, state = 'complete'`,
      },
    ],
    "write",
  );
}
