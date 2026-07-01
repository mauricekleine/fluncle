#!/usr/bin/env bun
/**
 * The 019.F.1A backfill — the one-off, IDEMPOTENT data migration that gives
 * mixtape #1 a `recordings` row (RFC recording-primitive, Design B).
 *
 * Wave 1 adds the `recordings` table + a nullable `recording_id` on both
 * `mixtapes` and `mixtape_clips`; every pre-existing row therefore carries a NULL
 * `recording_id`. This script synthesises ONE recording for the already-published
 * mixtape `019.F.1A` and links it back — WITHOUT touching R2 (it points at the
 * existing `019.F.1A/set.mp4` object) and WITHOUT dropping `mixtape_id` (a later
 * migration does that, only after prod is confirmed backfilled).
 *
 * Cloudflare does NOT run this — the operator runs it ONCE against production,
 * after `db:migrate` has applied the Wave 1 migration:
 *
 *   FLUNCLE_TURSO_OP_ITEM=<1Password item with prod Turso creds> \
 *     bun run apps/web/scripts/backfill-recording-019f1a.ts
 *
 * Production credentials are never stored in .dev.vars — they are read at run time
 * from 1Password (the same path as db-pull-prod.ts), so this is a deliberate,
 * human-in-the-loop step: `op` must be unlocked.
 *
 * IDEMPOTENT: safe to re-run. The whole thing no-ops the moment `019.F.1A`
 * already carries a `recording_id`, and every write is additionally guarded on
 * `recording_id is null`, so a second run leaves the database byte-identical.
 */
import { type Client, createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";

// The one mixtape this backfill targets, and the R2 key its recording OWNS —
// pointed at the EXISTING object (no bytes are moved).
const LOG_ID = "019.F.1A";
const R2_KEY = "019.F.1A/set.mp4";

type Cue = {
  artists: string[];
  id: string;
  startMs: null | number;
  title: string;
};

export type BackfillResult =
  | { clipsLinked: number; memberCount: number; recordingId: string; status: "created" }
  | { recordingId: string; status: "already-linked" }
  | { status: "mixtape-missing" };

/** Coerce a libSQL scalar cell to text — these columns are TEXT, always strings. */
function asText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }

  return "";
}

/** Parse a `tracks.artists_json` cell into a string[] (tolerating bad/absent JSON). */
function parseArtists(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);

    return Array.isArray(parsed) ? parsed.map((value) => String(value)) : [];
  } catch {
    return [];
  }
}

/**
 * The idempotent core, taking any libSQL client so the integration test can drive
 * it against an in-memory database with the real migrations applied.
 */
export async function backfillRecording019(client: Client): Promise<BackfillResult> {
  const mixtapeResult = await client.execute({
    args: [LOG_ID],
    sql: `select id, title, recorded_at, duration_ms, recording_id
          from mixtapes where log_id = ?`,
  });

  const mixtape = mixtapeResult.rows[0];

  if (!mixtape) {
    return { status: "mixtape-missing" };
  }

  const existingRecordingId = mixtape.recording_id;

  if (typeof existingRecordingId === "string" && existingRecordingId.length > 0) {
    return { recordingId: existingRecordingId, status: "already-linked" };
  }

  const mixtapeId = asText(mixtape.id);

  // The cued members, ordered by position — projected into the recording's
  // tracklist shape `{ id, artists, title, startMs }` that feeds resolveClipTracks
  // and seeds mixtape_tracks on a future promote with no re-splitting.
  const memberResult = await client.execute({
    args: [mixtapeId],
    sql: `select t.artists_json as artists_json, t.title as title, mt.start_ms as start_ms
          from mixtape_tracks mt
          join tracks t on t.track_id = mt.track_id
          where mt.mixtape_id = ?
          order by mt.position`,
  });

  const tracklist: Cue[] = memberResult.rows.map((row) => ({
    artists: parseArtists(row.artists_json),
    id: randomUUID(),
    startMs: row.start_ms === null ? null : Number(row.start_ms),
    title: asText(row.title),
  }));

  const recordingId = randomUUID();
  const now = new Date().toISOString();
  const tracklistJson = tracklist.length > 0 ? JSON.stringify(tracklist) : null;

  // One transactional batch: synthesise the recording, then link the mixtape and
  // its clips. Every write is guarded on `recording_id is null`, so the batch is
  // a no-op on a second run even before the early-return guard above catches it.
  await client.batch(
    [
      {
        args: [
          now,
          mixtape.duration_ms ?? null,
          recordingId,
          R2_KEY,
          mixtape.recorded_at ?? null,
          asText(mixtape.title),
          tracklistJson,
          now,
        ],
        sql: `insert into recordings
              (created_at, duration_ms, id, r2_key, recorded_at, title, tracklist_json, updated_at)
              values (?, ?, ?, ?, ?, ?, ?, ?)`,
      },
      {
        args: [recordingId, LOG_ID],
        sql: `update mixtapes set recording_id = ?
              where log_id = ? and recording_id is null`,
      },
      {
        args: [recordingId, mixtapeId],
        sql: `update mixtape_clips set recording_id = ?
              where mixtape_id = ? and recording_id is null`,
      },
    ],
    "write",
  );

  const clipsResult = await client.execute({
    args: [recordingId],
    sql: `select count(*) as n from mixtape_clips where recording_id = ?`,
  });

  return {
    clipsLinked: Number(clipsResult.rows[0]?.n ?? 0),
    memberCount: tracklist.length,
    recordingId,
    status: "created",
  };
}

async function main(): Promise<void> {
  const item = process.env.FLUNCLE_TURSO_OP_ITEM;

  if (!item) {
    throw new Error(
      "Set FLUNCLE_TURSO_OP_ITEM to the 1Password item holding the production Turso credentials — see the ops runbook note.",
    );
  }

  // Import Bun's shell lazily so the module stays importable under the vitest node
  // runtime (which has no `bun` module).
  const { $ } = await import("bun");

  const readSecret = async (field: string): Promise<string> => {
    try {
      return (await $`op read ${`${item}/${field}`}`.text()).trim();
    } catch {
      throw new Error(
        `Could not read ${field} from 1Password (${item}). Unlock 1Password and enable its CLI integration, then retry.`,
      );
    }
  };

  const url = await readSecret("TURSO_DATABASE_URL");
  const authToken = await readSecret("TURSO_AUTH_TOKEN");
  const client = createClient({ authToken, url });
  const result = await backfillRecording019(client);

  if (result.status === "mixtape-missing") {
    console.log(`No mixtape found for ${LOG_ID}; nothing to backfill.`);
  } else if (result.status === "already-linked") {
    console.log(`${LOG_ID} already links recording ${result.recordingId}; no-op.`);
  } else {
    console.log(
      `Backfilled ${LOG_ID}: recording ${result.recordingId} (${result.memberCount} cued members, ${result.clipsLinked} clips linked).`,
    );
  }
}

if (import.meta.main) {
  await main();
}
