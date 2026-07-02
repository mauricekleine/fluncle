#!/usr/bin/env bun
/**
 * The plan→recording→mixtape Deploy-1 backfill (docs/tracklist-recording-mixtape-rfc.md §9)
 * — IDEMPOTENT, and FOLDED INTO THE DEPLOY: `deploy:cf` runs it as `db:backfill` on
 * every push, right after `db:migrate` and before `wrangler deploy`, so the DDL and
 * the data it populates ship atomically (the RFC's ship-blocker fix). Every step is
 * guarded (`where not exists` / null-guards / convergent updates), so re-running on
 * every deploy is a no-op once done.
 *
 * The steps, in dependency order:
 *   1. PLANS — every draft mixtape becomes a plan-recording (`r2_key = NULL`,
 *      `planned_for` + `note` copied over), linked back via `mixtapes.recording_id`
 *      (the idempotency key AND Deploy-2's draft→plan mapping). While the draft row
 *      survives (until the Deploy-2 drain) it stays the editing surface, so each run
 *      RE-SYNCS the plan's `planned_for`/`note`/`title` from its draft (convergent).
 *   2. PLAN CUES — each draft's `mixtape_tracks` copy into `recording_cues`
 *      (`finding_id = track_id` — exact links; snapshot from the tracks join).
 *   3. TAKES — a published/distributing mixtape lacking a `recording_id` gets a
 *      synthesized take-recording pointing at its EXISTING `<logId>/set.mp4` (the
 *      019 backfill generalized — mixtape #1 already links `recording_id`, so it is
 *      REUSED, never re-synthesized). Legacy mixtape-only clips are repointed.
 *   4. TAKE CUES — a published/distributing mixtape's recording with ZERO cues is
 *      seeded from `mixtape_tracks` (exact `track_id`), NEVER from `tracklist_json`
 *      (the 019 backfill discarded `track_id` when it built that JSON).
 *   5. LEGACY CUES — any remaining recording with a `tracklist_json` and ZERO cues
 *      (e.g. the rolling set) has its cues migrated, resolving `finding_id` by
 *      NORMALIZED title+artist (the key_backfill matcher, ported to
 *      `src/lib/server/track-match.ts`) — never by `cue.id` (a random UUID, the
 *      live `no_resolvable_members` trap). Unresolved → NULL + snapshot.
 *   6. FINDING LINKS — `mixtape_tracks.finding_id` (the eventual rename of
 *      `track_id`) is filled `= track_id` wherever NULL. Finding-backed rows keep
 *      NULL snapshots (the tracks JOIN stays their truth).
 *   7. CLIP OWNERS — a clip carrying BOTH `mixtape_id` and `recording_id` (the 019
 *      backfill linked without unlinking) keeps only `recording_id`; the legacy
 *      `''` mixtape_id sentinel is cleared to NULL.
 *
 * Runs wherever `db:migrate` runs: the Cloudflare deploy environment provides
 * `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN`; locally they come from `.dev.vars`
 * (same loading as drizzle.config.ts).
 */
import { type Client, createClient, type InArgs } from "@libsql/client";
import { galaxySlug } from "@fluncle/contracts/util/galaxy-slug";
import { config } from "dotenv";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildTrackMatchIndex,
  type CatalogueTrack,
  resolveTrackByText,
} from "../src/lib/server/track-match";

export type PlanRecordingBackfillResult = {
  clipsNormalized: number;
  planCuesInserted: number;
  plansCreated: number;
  plansSynced: number;
  takeCuesInserted: number;
  takesSynthesized: number;
  trackFindingIdsFilled: number;
  tracklistCuesInserted: number;
  tracklistCuesUnresolved: number;
};

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

/** A `tracklist_json` cue, defensively parsed (the recordings.ts parse discipline). */
type LegacyCue = {
  artists: string[];
  id: string | null;
  startMs: number | null;
  title: string;
};

function parseTracklistJson(json: unknown): LegacyCue[] {
  if (typeof json !== "string" || !json) {
    return [];
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  const cues: LegacyCue[] = [];

  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") {
      continue;
    }

    const entry = raw as Record<string, unknown>;
    const title = typeof entry.title === "string" ? entry.title : "";
    const artists = Array.isArray(entry.artists)
      ? entry.artists.filter((value): value is string => typeof value === "string")
      : [];
    const startMs =
      typeof entry.startMs === "number" && Number.isInteger(entry.startMs) && entry.startMs >= 0
        ? entry.startMs
        : null;

    cues.push({
      artists,
      id: typeof entry.id === "string" && entry.id ? entry.id : null,
      startMs,
      title,
    });
  }

  return cues;
}

/** Insert one cue row, guarded on `(recording_id, position)` not existing yet. */
function insertCueStatement(cue: {
  artistsText: string | null;
  findingId: string | null;
  id: string;
  now: string;
  position: number;
  recordingId: string;
  startMs: number | null;
  titleText: string | null;
}): { args: InArgs; sql: string } {
  return {
    args: [
      cue.id,
      cue.recordingId,
      cue.findingId,
      cue.artistsText,
      cue.titleText,
      cue.position,
      cue.startMs,
      cue.now,
      cue.now,
      cue.recordingId,
      cue.position,
    ],
    sql: `insert into recording_cues
            (id, recording_id, finding_id, artists_text, title_text, position, start_ms, created_at, updated_at)
          select ?, ?, ?, ?, ?, ?, ?, ?, ?
          where not exists (
            select 1 from recording_cues where recording_id = ? and position = ?
          )`,
  };
}

/** The cued members of one mixtape, ordered, with the tracks-join snapshot. */
async function mixtapeMemberRows(
  client: Client,
  mixtapeId: string,
): Promise<
  Array<{
    artistsText: string;
    position: number;
    startMs: number | null;
    titleText: string;
    trackId: string;
  }>
> {
  const result = await client.execute({
    args: [mixtapeId],
    sql: `select mt.track_id as track_id, mt.position as position, mt.start_ms as start_ms,
                 t.title as title, t.artists_json as artists_json
          from mixtape_tracks mt
          join tracks t on t.track_id = mt.track_id
          where mt.mixtape_id = ?
          order by mt.position`,
  });

  return result.rows.map((row) => ({
    artistsText: parseArtists(row.artists_json).join(", "),
    position: Number(row.position),
    startMs: row.start_ms === null ? null : Number(row.start_ms),
    titleText: asText(row.title),
    trackId: asText(row.track_id),
  }));
}

/**
 * The plan's handle — the auto Galaxy-vocab slug (RFC §6/D-handle: the generated
 * slug IS the handle). Deterministic in the draft's stable id, so the same draft
 * always yields the same slug (idempotent — a re-run mints nothing new). Salted
 * re-roll on collision: bump `attempt` until the slug is free among existing
 * recordings (a plan's title holds its handle). Never date-derived, so the drift
 * bug that killed `predictedMixtapeLogId` can't return.
 */
async function mintPlanHandle(client: Client, draftId: string): Promise<string> {
  for (let attempt = 0; attempt < 64; attempt++) {
    const slug = galaxySlug(draftId, attempt);
    const clash = await client.execute({
      args: [slug],
      sql: `select 1 from recordings where title = ? limit 1`,
    });

    if (clash.rows.length === 0) {
      return slug;
    }
  }

  // 64 salted attempts colliding is astronomically unlikely — fall back to a
  // slug carrying the draft id tail so it is still deterministic + unique.
  return `${galaxySlug(draftId, 0)}-${draftId.slice(0, 8)}`;
}

async function cueCount(client: Client, recordingId: string): Promise<number> {
  const result = await client.execute({
    args: [recordingId],
    sql: `select count(*) as n from recording_cues where recording_id = ?`,
  });

  return Number(result.rows[0]?.n ?? 0);
}

/**
 * The idempotent core, taking any libSQL client so the integration test can drive
 * it against an in-memory database with the real migrations applied.
 */
export async function backfillPlanRecordingMixtape(
  client: Client,
): Promise<PlanRecordingBackfillResult> {
  const now = new Date().toISOString();
  const result: PlanRecordingBackfillResult = {
    clipsNormalized: 0,
    planCuesInserted: 0,
    plansCreated: 0,
    plansSynced: 0,
    takeCuesInserted: 0,
    takesSynthesized: 0,
    trackFindingIdsFilled: 0,
    tracklistCuesInserted: 0,
    tracklistCuesUnresolved: 0,
  };

  // ── 1. PLANS — drafts without a linked recording become plan-recordings.
  const unlinkedDrafts = await client.execute({
    sql: `select id, title, note, planned_for, created_at
          from mixtapes where status = 'draft' and recording_id is null
          order by created_at`,
  });

  for (const draft of unlinkedDrafts.rows) {
    const draftId = asText(draft.id);
    // The plan's title IS its Galaxy-vocab handle (RFC §6/D-handle), minted once
    // from the draft's stable id — deterministic, collision-salted, never
    // date-derived.
    const title = await mintPlanHandle(client, draftId);
    const planId = randomUUID();

    await client.batch(
      [
        {
          args: [planId, title, draft.note ?? null, draft.planned_for ?? null, now, now],
          sql: `insert into recordings
                  (id, title, note, planned_for, r2_key, parent_id, version, created_at, updated_at)
                values (?, ?, ?, ?, null, null, 1, ?, ?)`,
        },
        {
          args: [planId, draftId],
          sql: `update mixtapes set recording_id = ? where id = ? and recording_id is null`,
        },
      ],
      "write",
    );
    result.plansCreated += 1;
  }

  // While the draft rows survive (Deploy-2 drains them) they stay the editing
  // surface — converge the plan's authored fields onto them each run. The handle
  // (`title`) is minted ONCE and never re-derived, so only `note`/`planned_for`
  // sync here. `is not` is SQLite's null-safe comparison, so an unchanged run
  // updates zero rows.
  const synced = await client.execute({
    args: [now],
    sql: `update recordings set
            note = m.note,
            planned_for = m.planned_for,
            updated_at = ?
          from mixtapes m
          where m.status = 'draft' and m.recording_id = recordings.id
            and (recordings.note is not m.note or recordings.planned_for is not m.planned_for)`,
  });

  result.plansSynced = synced.rowsAffected;

  // ── 2. PLAN CUES — copy each draft's mixtape_tracks into its plan's cues
  // (exact finding links; snapshot from the tracks join). Only a plan with ZERO
  // cues is seeded, so a later cue editor owns the rows after first fill.
  const linkedDrafts = await client.execute({
    sql: `select id, recording_id from mixtapes
          where status = 'draft' and recording_id is not null`,
  });

  for (const draft of linkedDrafts.rows) {
    const planId = asText(draft.recording_id);

    if ((await cueCount(client, planId)) > 0) {
      continue;
    }

    const members = await mixtapeMemberRows(client, asText(draft.id));

    for (const member of members) {
      const insert = await client.execute(
        insertCueStatement({
          artistsText: member.artistsText || null,
          findingId: member.trackId,
          id: randomUUID(),
          now,
          position: member.position,
          recordingId: planId,
          startMs: member.startMs,
          titleText: member.titleText || null,
        }),
      );

      result.planCuesInserted += insert.rowsAffected;
    }
  }

  // ── 3. TAKES — synthesize a take-recording for any published/distributing
  // mixtape lacking one (mixtape #1 already links its recording — reused as-is,
  // NEVER re-synthesized). Points at the EXISTING `<logId>/set.mp4`; repoints
  // legacy mixtape-only clips, exactly like the 019 backfill.
  const unlinkedPublished = await client.execute({
    sql: `select id, log_id, title, recorded_at, duration_ms from mixtapes
          where status in ('published', 'distributing') and recording_id is null`,
  });

  for (const mixtape of unlinkedPublished.rows) {
    const logId = asText(mixtape.log_id);

    if (!logId) {
      // A published mixtape without a coordinate should not exist; leave it for
      // a human rather than synthesizing a recording with no video key.
      console.warn(`Skipping ${asText(mixtape.id)}: published/distributing but no log_id.`);
      continue;
    }

    const recordingId = randomUUID();
    const mixtapeId = asText(mixtape.id);

    await client.batch(
      [
        {
          args: [
            recordingId,
            asText(mixtape.title),
            `${logId}/set.mp4`,
            mixtape.recorded_at ?? null,
            mixtape.duration_ms ?? null,
            now,
            now,
          ],
          sql: `insert into recordings
                  (id, title, r2_key, recorded_at, duration_ms, parent_id, version, created_at, updated_at)
                values (?, ?, ?, ?, ?, null, 1, ?, ?)`,
        },
        {
          args: [recordingId, mixtapeId],
          sql: `update mixtapes set recording_id = ? where id = ? and recording_id is null`,
        },
        {
          args: [recordingId, mixtapeId],
          sql: `update mixtape_clips set recording_id = ?
                where mixtape_id = ? and recording_id is null`,
        },
      ],
      "write",
    );
    result.takesSynthesized += 1;
  }

  // ── 4. TAKE CUES — seed a published/distributing mixtape's recording from its
  // FROZEN `mixtape_tracks` (exact `track_id` links), never from `tracklist_json`
  // (the 019 backfill discarded track_id when it built that JSON). The zero-cue
  // gate keeps the source selection atomic per recording.
  const linkedPublished = await client.execute({
    sql: `select id, recording_id from mixtapes
          where status in ('published', 'distributing') and recording_id is not null`,
  });

  for (const mixtape of linkedPublished.rows) {
    const recordingId = asText(mixtape.recording_id);

    if ((await cueCount(client, recordingId)) > 0) {
      continue;
    }

    const members = await mixtapeMemberRows(client, asText(mixtape.id));

    for (const member of members) {
      const insert = await client.execute(
        insertCueStatement({
          artistsText: member.artistsText || null,
          findingId: member.trackId,
          id: randomUUID(),
          now,
          position: member.position,
          recordingId,
          startMs: member.startMs,
          titleText: member.titleText || null,
        }),
      );

      result.takeCuesInserted += insert.rowsAffected;
    }
  }

  // ── 5. LEGACY CUES — any remaining recording with a tracklist_json and ZERO
  // cues (e.g. a hand-authored standalone recording). `finding_id` resolves by
  // NORMALIZED title+artist against the findings catalogue — never by `cue.id`
  // (a random UUID, the live `no_resolvable_members` trap). Unresolved → NULL +
  // the snapshot text (honest silence over a wrong link).
  const withTracklist = await client.execute({
    sql: `select id, tracklist_json from recordings
          where tracklist_json is not null and tracklist_json != '' and tracklist_json != '[]'`,
  });

  // The catalogue index is built lazily — only when a legacy tracklist needs it.
  let matchIndex: Map<string, string | null> | null = null;

  for (const recording of withTracklist.rows) {
    const recordingId = asText(recording.id);

    if ((await cueCount(client, recordingId)) > 0) {
      continue;
    }

    const cues = parseTracklistJson(recording.tracklist_json);

    if (cues.length === 0) {
      continue;
    }

    if (!matchIndex) {
      const catalogue = await client.execute({
        sql: `select track_id, title, artists_json from tracks`,
      });

      matchIndex = buildTrackMatchIndex(
        catalogue.rows.map(
          (row): CatalogueTrack => ({
            artists: parseArtists(row.artists_json),
            title: asText(row.title),
            trackId: asText(row.track_id),
          }),
        ),
      );
    }

    const usedIds = new Set<string>();

    for (const [index, cue] of cues.entries()) {
      const findingId = resolveTrackByText(matchIndex, cue.artists, cue.title);
      // Reuse the legacy cue's stable id (the clip overlay keys off it) unless
      // it is missing or duplicated within this tracklist.
      const cueId = cue.id && !usedIds.has(cue.id) ? cue.id : randomUUID();

      usedIds.add(cueId);

      const insert = await client.execute(
        insertCueStatement({
          artistsText: cue.artists.length > 0 ? cue.artists.join(", ") : null,
          findingId,
          id: cueId,
          now,
          position: index + 1,
          recordingId,
          startMs: cue.startMs,
          titleText: cue.title || null,
        }),
      );

      result.tracklistCuesInserted += insert.rowsAffected;

      if (insert.rowsAffected > 0 && findingId === null) {
        result.tracklistCuesUnresolved += 1;
      }
    }
  }

  // ── 6. FINDING LINKS — fill `mixtape_tracks.finding_id` (the eventual rename
  // of `track_id`). Also self-heals rows written by the not-yet-cutover
  // `setMixtapeMembers` between deploys.
  const filled = await client.execute({
    sql: `update mixtape_tracks set finding_id = track_id where finding_id is null`,
  });

  result.trackFindingIdsFilled = filled.rowsAffected;

  // ── 7. CLIP OWNERS — one owner per clip: recording_id wins where both are set
  // (the 019 backfill linked without unlinking), and the legacy `''` sentinel
  // clears to NULL now the column is nullable.
  const normalized = await client.execute({
    sql: `update mixtape_clips set mixtape_id = null
          where (recording_id is not null and mixtape_id is not null) or mixtape_id = ''`,
  });

  result.clipsNormalized = normalized.rowsAffected;

  return result;
}

async function main(): Promise<void> {
  // The Cloudflare deploy environment provides the Turso env; local runs fall
  // back to `.dev.vars` (the drizzle.config.ts loading — dotenv never overrides
  // an already-set env var).
  if (!process.env.TURSO_DATABASE_URL) {
    config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".dev.vars") });
  }

  const url = process.env.TURSO_DATABASE_URL;

  if (!url) {
    throw new Error("TURSO_DATABASE_URL is required (set it in apps/web/.dev.vars)");
  }

  const authToken = process.env.TURSO_AUTH_TOKEN;
  const client = createClient(authToken ? { authToken, url } : { url });
  const result = await backfillPlanRecordingMixtape(client);

  console.log(
    `plan→recording→mixtape backfill: ${result.plansCreated} plans created, ` +
      `${result.plansSynced} plans synced, ${result.planCuesInserted} plan cues, ` +
      `${result.takesSynthesized} takes synthesized, ${result.takeCuesInserted} take cues, ` +
      `${result.tracklistCuesInserted} legacy cues (${result.tracklistCuesUnresolved} unresolved), ` +
      `${result.trackFindingIdsFilled} finding links filled, ` +
      `${result.clipsNormalized} clips normalized.`,
  );
}

if (import.meta.main) {
  await main();
}
