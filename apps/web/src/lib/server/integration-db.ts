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
import { ensureSearchIndex } from "../../db/search-index";

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

  await migrate(drizzle(client), { migrationsFolder });
  await ensureSearchIndex(client);

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
  const now = new Date().toISOString();

  await seedCatalogueTrack(client, track);
  await client.execute({
    args: [
      track.trackId,
      track.logId,
      now,
      track.addedToSpotify ? 1 : 0,
      track.postedToTelegram ? 1 : 0,
    ],
    sql: `insert into findings
      (track_id, log_id, added_at, added_to_spotify, posted_to_telegram)
      values (?, ?, ?, ?, ?)`,
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
  await client.execute({
    args: [
      track.trackId,
      track.title ?? "Test Track",
      JSON.stringify(track.artists ?? ["Test Artist"]),
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
