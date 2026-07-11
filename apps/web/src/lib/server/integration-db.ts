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

const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));

/**
 * A fresh in-memory libSQL database with every generated Drizzle migration
 * applied. Each call is an isolated `:memory:` database (no cross-test leakage),
 * so a test can `beforeEach(async () => { db = await createIntegrationDb(); })`.
 */
export async function createIntegrationDb(): Promise<Client> {
  const client = createClient({ url: ":memory:" });

  await migrate(drizzle(client), { migrationsFolder });

  return client;
}

/** Returns the sorted list of every row's value for a single text column. */
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
  addedToSpotify?: boolean;
  artists?: string[];
  /** NULL seeds an UNCHARTED finding (no coordinate) — the rows the public reads exclude. */
  logId: null | string;
  postedToTelegram?: boolean;
  title?: string;
  trackId: string;
};

/** Inserts a minimal published `tracks` row (only the columns the tests read). */
export async function seedTrack(client: Client, track: SeedTrack): Promise<void> {
  const now = new Date().toISOString();

  await client.execute({
    args: [
      track.trackId,
      track.logId,
      track.title ?? "Test Track",
      JSON.stringify(track.artists ?? ["Test Artist"]),
      `spotify:track:${track.trackId}`,
      `https://open.spotify.com/track/${track.trackId}`,
      0,
      now,
      track.addedToSpotify ? 1 : 0,
      track.postedToTelegram ? 1 : 0,
    ],
    sql: `insert into tracks
      (track_id, log_id, title, artists_json, spotify_uri, spotify_url, duration_ms,
       added_at, added_to_spotify, posted_to_telegram)
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
