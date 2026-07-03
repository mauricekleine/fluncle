#!/usr/bin/env bun
/**
 * The plan→recording→mixtape Deploy-1 backfill (docs/tracklist-recording-mixtape-rfc.md §9)
 * — IDEMPOTENT, and FOLDED INTO THE DEPLOY: `deploy:cf` runs it as `db:backfill` on
 * every push, right after `db:migrate` and before `wrangler deploy`, so the DDL and
 * the data it populates ship atomically (the RFC's ship-blocker fix). Every step is
 * guarded (`where not exists` / null-guards / convergent updates), so re-running on
 * every deploy is a no-op once done.
 *
 * The steps, in dependency order. The plan→recording→mixtape Deploy-2 cutover
 * dropped `recordings.tracklist_json`, `mixtapes.planned_for`, and
 * `mixtape_clips.mixtape_id`; the draft-retirement cutover then removed every
 * draft-mixtape creator (the board's "Add to mixtape" flow repointed onto plans,
 * the `create_mixtape`/members/publish/delete ops deleted, the promote claim born
 * `distributing`), so `status = 'draft'` rows can no longer be CREATED — this
 * sweep DRAINS any that remain (or ever slip in) and keeps the TS-only
 * `MixtapeStatus` narrow (`distributing | published`) honest. What runs on every
 * deploy (all idempotent, guarded):
 *   1. PLANS — every residual draft mixtape (without a linked recording) becomes a
 *      plan-recording (`r2_key = NULL`, `note` copied over), linked back via
 *      `mixtapes.recording_id` (the idempotency key AND draft→plan mapping).
 *      The `title` handle is minted once and never re-derived.
 *   2. DRAIN — each plan-linked draft's `mixtape_tracks` MERGE into the plan's
 *      `recording_cues` (append findings the plan doesn't already carry —
 *      `finding_id = track_id`, snapshot from the tracks join), then the draft row
 *      + its members are DELETED. A draft linked to a TAKE (`r2_key` set) is a
 *      pre-cutover crashed promote claim: it is normalized to `distributing`
 *      (unminted — `log_id` stays NULL; the next promote finishes the mint).
 *   3. TAKES — a published/distributing mixtape lacking a `recording_id` gets a
 *      synthesized take-recording pointing at its EXISTING `<logId>/set.mp4`
 *      (mixtape #1 already links `recording_id`, so it is REUSED, never
 *      re-synthesized).
 *   4. TAKE CUES — a published/distributing mixtape's recording with ZERO cues is
 *      seeded from `mixtape_tracks` (exact `track_id`).
 *   5. FINDING LINKS — `mixtape_tracks.finding_id` (the eventual rename of
 *      `track_id`) is filled `= track_id` wherever NULL. Finding-backed rows keep
 *      NULL snapshots (the tracks JOIN stays their truth). Self-heals rows the
 *      promote seed path (`setMixtapeMembers`) writes between deploys.
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

export type PlanRecordingBackfillResult = {
  claimsNormalized: number;
  draftsDrained: number;
  planCuesInserted: number;
  plansCreated: number;
  takeCuesInserted: number;
  takesSynthesized: number;
  trackFindingIdsFilled: number;
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
    claimsNormalized: 0,
    draftsDrained: 0,
    planCuesInserted: 0,
    plansCreated: 0,
    takeCuesInserted: 0,
    takesSynthesized: 0,
    trackFindingIdsFilled: 0,
  };

  // ── 1. PLANS — residual drafts without a linked recording become
  // plan-recordings. (No draft can be CREATED anymore — the board's picker writes
  // plans and the promote claim is born `distributing` — so this only catches a
  // row that slipped in pre-cutover. `planned_for` is NOT copied here — the
  // Deploy-2 cutover dropped `mixtapes.planned_for`.)
  const unlinkedDrafts = await client.execute({
    sql: `select id, title, note, created_at
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
          args: [planId, title, draft.note ?? null, now, now],
          sql: `insert into recordings
                  (id, title, note, r2_key, parent_id, version, created_at, updated_at)
                values (?, ?, ?, null, null, 1, ?, ?)`,
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

  // ── 2. DRAIN — drafts are retired: the TS `MixtapeStatus` narrow
  // (`distributing | published`) is honest only when no `draft` row survives.
  //
  // 2a. A draft linked to a TAKE (`r2_key` set) is a pre-cutover crashed promote
  // claim: normalize it to `distributing` (unminted — `log_id` stays NULL, so the
  // next promote reuses the claim and finishes the mint; no coordinate moves).
  const normalized = await client.execute({
    args: [now],
    sql: `update mixtapes set status = 'distributing', updated_at = ?
          where status = 'draft'
            and recording_id in (select id from recordings where r2_key is not null)`,
  });

  result.claimsNormalized = normalized.rowsAffected;

  // 2b. A draft linked to a PLAN: MERGE its `mixtape_tracks` into the plan's cues
  // (append any finding the plan doesn't already carry — both were live editing
  // surfaces before the cutover, so neither side alone is authoritative), then
  // DELETE the draft row + its members.
  const linkedDrafts = await client.execute({
    sql: `select m.id, m.recording_id from mixtapes m
          join recordings r on r.id = m.recording_id
          where m.status = 'draft' and r.r2_key is null`,
  });

  for (const draft of linkedDrafts.rows) {
    const planId = asText(draft.recording_id);
    const draftId = asText(draft.id);

    const existing = await client.execute({
      args: [planId],
      sql: `select finding_id, coalesce(max(position) over (), 0) as max_position
            from recording_cues where recording_id = ?`,
    });
    const present = new Set(
      existing.rows.map((row) => asText(row.finding_id)).filter((id) => id.length > 0),
    );
    let position = Number(existing.rows[0]?.max_position ?? 0);

    for (const member of await mixtapeMemberRows(client, draftId)) {
      if (present.has(member.trackId)) {
        continue;
      }

      present.add(member.trackId);
      position += 1;
      const insert = await client.execute(
        insertCueStatement({
          artistsText: member.artistsText || null,
          findingId: member.trackId,
          id: randomUUID(),
          now,
          position,
          recordingId: planId,
          startMs: member.startMs,
          titleText: member.titleText || null,
        }),
      );

      result.planCuesInserted += insert.rowsAffected;
    }

    await client.batch(
      [
        { args: [draftId], sql: `delete from mixtape_tracks where mixtape_id = ?` },
        { args: [draftId], sql: `delete from mixtapes where id = ? and status = 'draft'` },
      ],
      "write",
    );
    result.draftsDrained += 1;
  }

  // ── 3. TAKES — synthesize a take-recording for any published/distributing
  // mixtape lacking one (mixtape #1 already links its recording — reused as-is,
  // NEVER re-synthesized). Points at the EXISTING `<logId>/set.mp4`. (The legacy
  // mixtape-clip repoint that lived here retired with the `mixtape_clips.mixtape_id`
  // column in the Deploy-2 cutover — every legacy clip was already repointed onto
  // its recording by the LIVE Deploy-1 backfill.)
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

  // ── 5. FINDING LINKS — fill `mixtape_tracks.finding_id` (the eventual rename
  // of `track_id`). Also self-heals rows written by `setMixtapeMembers` (the
  // promote path's member seed) between deploys.
  const filled = await client.execute({
    sql: `update mixtape_tracks set finding_id = track_id where finding_id is null`,
  });

  result.trackFindingIdsFilled = filled.rowsAffected;

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
      `${result.draftsDrained} drafts drained, ${result.claimsNormalized} claims normalized, ` +
      `${result.planCuesInserted} plan cues, ${result.takesSynthesized} takes synthesized, ` +
      `${result.takeCuesInserted} take cues, ${result.trackFindingIdsFilled} finding links filled.`,
  );
}

if (import.meta.main) {
  await main();
}
