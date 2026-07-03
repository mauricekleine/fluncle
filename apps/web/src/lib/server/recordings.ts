// The recording data layer (RFC recording-primitive, Design B). A RECORDING is a
// captured DJ set that is NOT (yet) a published mixtape: it OWNS its R2 key
// (`recordings/<id>/set.mp4` in the public `fluncle-videos` bucket — accept-obscurity,
// no private bucket), carries an optional cue tracklist, and is deliberately
// COORDINATE-LESS. The clip pipeline cuts clips from a recording's set video without
// minting a scarce Log ID; only `promoteRecording` (→ a full published mixtape) ever
// mints one. Mirrors the validate-and-throw style of `./mixtapes`.

import { randomUUID } from "node:crypto";
import { type RecordingDTO, type RecordingTracklistItem } from "@fluncle/contracts/orpc";
import { galaxySlug } from "@fluncle/contracts/util/galaxy-slug";
import { getDb, typedRow, typedRows } from "./db";
import { publishMixtape, setMixtapeMembers, updateMixtape } from "./mixtapes";
import { copyObject, deleteObject } from "./r2-presign";
import { ApiError } from "./spotify";
import { buildTrackMatchIndex, resolveTrackByText } from "./track-match";

const titleMaxLength = 200;
// The salted re-roll ceiling for the plan handle: `galaxySlug(id, attempt)` is
// re-rolled up to this many times against existing recording titles before falling
// back to an id-tailed slug. Mirrors the backfill's `mintPlanHandle`. 64 collisions
// across the ~3k-combination space is astronomically unlikely.
const planHandleMaxAttempts = 64;

// The recording's OWNED R2 key — derived from its id, so the key exists the moment the
// row does (the upload presign targets exactly this). Standalone recordings live under
// `recordings/<id>/set.mp4` in the existing `fluncle-videos` bucket.
export function recordingR2Key(id: string): string {
  return `recordings/${id}/set.mp4`;
}

// The recordings table row (no join). `r2_key` is nullable since the
// plan→recording→mixtape Deploy-1: a PLAN has no video ("has video" =
// `r2_key IS NOT NULL`).
type RecordingRow = {
  created_at: string;
  duration_ms: number | null;
  id: string;
  parent_id: string | null;
  planned_for: string | null;
  r2_key: string | null;
  recorded_at: string | null;
  title: string;
  tracklist_json: string | null;
  updated_at: string;
  version: number;
};

// One `recording_cues` row (the forward home of a recording's cues; RFC
// plan→recording→mixtape §2). `finding_id` is the honest link to canon. EXPORTED so
// `buildClipCaption` can read a recording's cues with their `finding_id` (the DTO's
// tracklist item drops it).
export type CueRow = {
  artists_text: string | null;
  finding_id: string | null;
  id: string;
  position: number;
  start_ms: number | null;
  title_text: string | null;
};

// The recordings row LEFT JOINed to the mixtape it was promoted into (if any), for the
// public DTO's `logId` + `mixtapeId`.
type RecordingJoinRow = RecordingRow & {
  mixtape_id: string | null;
  mixtape_log_id: string | null;
};

/** The operator-authored fields a recording create/update accepts. */
export type RecordingInput = {
  // "plan" ⇒ a videoless recording (create only): no title needed, the server mints a
  // Galaxy-vocab handle and leaves `r2_key` NULL. Anything else (the default) is a TAKE
  // that owns a set video. RFC plan→recording→mixtape §1.
  kind?: unknown;
  // The take→plan link (update only): attach a take to its plan. Setting it assigns the
  // take's `version` atomically among the plan's takes. RFC §2/§3.
  parentId?: unknown;
  // The upcoming live session (ISO) a PLAN is for (update only) — the plan editor's
  // Live-session field. `""`/null clears it. RFC §6, D-plannedFor.
  plannedFor?: unknown;
  recordedAt?: unknown;
  title?: unknown;
  // The whole cue tracklist, an array of `{ id, artists, title, startMs? }` (update only).
  tracklistJson?: unknown;
};

/** A single cue in a `replace_recording_cues` body (RFC §4). */
export type RecordingCueInput = {
  artistsText?: unknown;
  findingId?: unknown;
  position?: unknown;
  startMs?: unknown;
  titleText?: unknown;
};

/** A recording list filter (the plan/take split + a plan's takes). RFC §7. */
export type RecordingListFilter = {
  kind?: "plan" | "take";
  parentId?: string;
};

// Parse the stored tracklist JSON into the DTO's `tracklist` array, defensively (a
// malformed/legacy value yields `[]` rather than throwing on a read).
function parseTracklist(json: string | null): RecordingTracklistItem[] {
  if (!json) {
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

  const items: RecordingTracklistItem[] = [];

  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") {
      continue;
    }

    const entry = raw as Record<string, unknown>;
    const id = typeof entry.id === "string" ? entry.id : undefined;
    const title = typeof entry.title === "string" ? entry.title : undefined;
    const artists = Array.isArray(entry.artists)
      ? entry.artists.filter((value): value is string => typeof value === "string")
      : [];

    if (!id || title === undefined) {
      continue;
    }

    const startMs =
      typeof entry.startMs === "number" && Number.isInteger(entry.startMs) && entry.startMs >= 0
        ? entry.startMs
        : undefined;

    items.push({ artists, id, startMs, title });
  }

  return items;
}

// Map a `recording_cues` row into the DTO's tracklist item shape. The cue stores
// `artists_text` as one ", "-joined string; the DTO wants a string[] — split at
// the boundary (RFC plan→recording→mixtape §5, the N-8 shim).
function cueRowToTracklistItem(row: CueRow): RecordingTracklistItem {
  return {
    artists: row.artists_text ? row.artists_text.split(", ") : [],
    id: row.id,
    startMs: row.start_ms ?? undefined,
    title: row.title_text ?? "",
  };
}

// DUAL-READ (Deploy-1): the legacy `tracklist_json` stays the DTO's first source
// so pre-cutover rows read byte-identically; a row with no legacy JSON (a PLAN,
// whose cues live only in `recording_cues`) reads its cues. The Deploy-2 cutover
// flips this to cues-only and drops the column.
function rowToRecording(row: RecordingJoinRow, cues: RecordingTracklistItem[]): RecordingDTO {
  const legacy = parseTracklist(row.tracklist_json);

  return {
    createdAt: row.created_at,
    durationMs: row.duration_ms ?? undefined,
    // "has video" = the recording owns a set-video key. A PLAN has none.
    hasVideo: row.r2_key !== null,
    id: row.id,
    logId: row.mixtape_log_id ?? undefined,
    mixtapeId: row.mixtape_id ?? undefined,
    parentId: row.parent_id ?? undefined,
    plannedFor: row.planned_for ?? undefined,
    r2Key: row.r2_key ?? undefined,
    recordedAt: row.recorded_at ?? undefined,
    title: row.title,
    tracklist: legacy.length > 0 ? legacy : cues,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

const CUE_SELECT = `select id, recording_id, finding_id, artists_text, title_text, position, start_ms
  from recording_cues`;

// Every cue for one recording, in position order.
async function getCueRows(recordingId: string): Promise<CueRow[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [recordingId],
    sql: `${CUE_SELECT} where recording_id = ? order by position`,
  });

  return typedRows<CueRow>(result.rows);
}

// The cue tracklists for MANY recordings in one query (the list read), keyed by
// recording id.
async function getCueTracklists(): Promise<Map<string, RecordingTracklistItem[]>> {
  const db = await getDb();
  const result = await db.execute({ sql: `${CUE_SELECT} order by recording_id, position` });
  const byRecording = new Map<string, RecordingTracklistItem[]>();

  for (const row of typedRows<CueRow & { recording_id: string }>(result.rows)) {
    const items = byRecording.get(row.recording_id) ?? [];

    items.push(cueRowToTracklistItem(row));
    byRecording.set(row.recording_id, items);
  }

  return byRecording;
}

const RECORDING_SELECT = `select
  r.created_at,
  r.duration_ms,
  r.id,
  r.parent_id,
  r.planned_for,
  r.r2_key,
  r.recorded_at,
  r.title,
  r.tracklist_json,
  r.updated_at,
  r.version,
  m.id as mixtape_id,
  m.log_id as mixtape_log_id
  from recordings r
  left join mixtapes m on m.recording_id = r.id`;

// The raw recordings row (no join) — the promote path reads `r2_key` + `tracklist_json`
// off it without needing the promoted-mixtape join.
async function getRecordingRow(id: string): Promise<RecordingRow> {
  const db = await getDb();
  const result = await db.execute({
    args: [id],
    sql: `select created_at, duration_ms, id, parent_id, planned_for, r2_key, recorded_at, title, tracklist_json, updated_at, version
          from recordings where id = ? limit 1`,
  });
  const row = typedRow<RecordingRow>(result.rows);

  if (!row) {
    throw new ApiError("recording_not_found", "Recording not found", 404);
  }

  return row;
}

// Every cue for one recording, in position order — EXPORTED for `buildClipCaption`
// (`./clip-caption`), which needs the raw cue rows (with `finding_id`) the tracklist
// DTO doesn't carry. The DTO's `RecordingTracklistItem` drops `finding_id`, so the
// caption builder reads the cues directly here.
export async function getRecordingCues(recordingId: string): Promise<CueRow[]> {
  return getCueRows(recordingId);
}

export async function getRecording(id: string): Promise<RecordingDTO> {
  const db = await getDb();
  const result = await db.execute({
    args: [id],
    sql: `${RECORDING_SELECT} where r.id = ? limit 1`,
  });
  const row = typedRow<RecordingJoinRow>(result.rows);

  if (!row) {
    throw new ApiError("recording_not_found", "Recording not found", 404);
  }

  return rowToRecording(row, (await getCueRows(id)).map(cueRowToTracklistItem));
}

export async function listRecordings(filter: RecordingListFilter = {}): Promise<RecordingDTO[]> {
  // The plan/take split is structural: a PLAN owns no video (`r2_key IS NULL`), a TAKE
  // owns one (`r2_key IS NOT NULL`). `parentId` narrows to one plan's takes (RFC §7).
  const conditions: string[] = [];
  const args: string[] = [];

  if (filter.kind === "plan") {
    conditions.push("r.r2_key is null");
  } else if (filter.kind === "take") {
    conditions.push("r.r2_key is not null");
  }

  if (filter.parentId) {
    conditions.push("r.parent_id = ?");
    args.push(filter.parentId);
  }

  const where = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";
  const db = await getDb();
  const result = await db.execute({
    args,
    sql: `${RECORDING_SELECT} ${where} order by r.created_at desc, r.id desc`,
  });
  const cueTracklists = await getCueTracklists();

  return typedRows<RecordingJoinRow>(result.rows).map((row) =>
    rowToRecording(row, cueTracklists.get(row.id) ?? []),
  );
}

// The plan's handle — the auto Galaxy-vocab slug (RFC §6, D-handle: the generated slug
// IS the handle). Deterministic in the new id, salted re-roll on collision among
// existing recording titles (a plan's title holds its handle). Never date-derived, so
// the drift bug that killed `predictedMixtapeLogId` can't return. Mirrors the backfill's
// `mintPlanHandle`.
async function mintPlanHandle(id: string): Promise<string> {
  const db = await getDb();

  for (let attempt = 0; attempt < planHandleMaxAttempts; attempt++) {
    const slug = galaxySlug(id, attempt);
    const clash = await db.execute({
      args: [slug],
      sql: `select 1 from recordings where title = ? limit 1`,
    });

    if (clash.rows.length === 0) {
      return slug;
    }
  }

  // 64 salted collisions is astronomically unlikely — fall back to an id-tailed slug
  // (still deterministic + unique).
  return `${galaxySlug(id, 0)}-${id.slice(0, 8)}`;
}

export async function createRecording(input: RecordingInput): Promise<RecordingDTO> {
  const recordedAt = optionalIsoDate(input.recordedAt, "recordedAt");
  const id = randomUUID();
  const now = new Date().toISOString();
  const db = await getDb();

  // A PLAN (`kind: "plan"`) is a VIDELESS recording: `r2_key` stays NULL and the server
  // mints a Galaxy-vocab handle as the title (RFC §1). A TAKE (the default) owns a set
  // video: its `r2_key` is derived from the id and the video is uploaded separately, and
  // it requires an operator title.
  const isPlan = input.kind === "plan";
  const title = isPlan
    ? await mintPlanHandle(id)
    : requireText(input.title, "title", titleMaxLength);
  const r2Key = isPlan ? null : recordingR2Key(id);

  await db.execute({
    args: [id, title, r2Key, recordedAt ?? null, now, now],
    sql: `insert into recordings (id, title, r2_key, recorded_at, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?)`,
  });

  return getRecording(id);
}

export async function updateRecording(id: string, input: RecordingInput): Promise<RecordingDTO> {
  // Confirm it exists (clean 404).
  await getRecordingRow(id);

  const sets: string[] = [];
  const args: Array<number | string | null> = [];

  if (input.title !== undefined) {
    sets.push("title = ?");
    args.push(requireText(input.title, "title", titleMaxLength));
  }

  if (input.recordedAt !== undefined) {
    sets.push("recorded_at = ?");
    args.push(optionalIsoDate(input.recordedAt, "recordedAt") ?? null);
  }

  // The plan's upcoming live session — the plan editor's Live-session field. `""`/null
  // clears it (`/calendar.ics` + `getUpcoming` repoint here in Deploy-2; RFC §6).
  if (input.plannedFor !== undefined) {
    sets.push("planned_for = ?");
    args.push(optionalIsoDate(input.plannedFor, "plannedFor") ?? null);
  }

  let tracklistItems: RecordingTracklistItem[] | undefined;

  if (input.tracklistJson !== undefined) {
    tracklistItems = serializeTracklist(input.tracklistJson);
    sets.push("tracklist_json = ?");
    args.push(JSON.stringify(tracklistItems));
  }

  // Attach a take to its plan (RFC §2/§3). Setting a non-null `parentId` assigns the
  // take's `version` ATOMICALLY in the same UPDATE — `coalesce(max(version),0)+1` over
  // the plan's OTHER takes — so two concurrent attaches can't collide on the
  // `(parent_id, version)` unique index (a TS read-then-write would race; RFC §3, S6).
  // A null `parentId` detaches the take back to an orphan (its `version` is left as-is;
  // the unique index treats NULL parents as distinct).
  if (input.parentId !== undefined) {
    const parentId = optionalRecordingId(input.parentId);

    if (parentId === null) {
      sets.push("parent_id = ?");
      args.push(null);
    } else {
      // A clean 404 if the plan doesn't exist (getRecordingRow throws).
      await getRecordingRow(parentId);
      sets.push("parent_id = ?");
      args.push(parentId);
      sets.push(
        "version = (select coalesce(max(version), 0) + 1 from recordings where parent_id is ? and id <> ?)",
      );
      args.push(parentId, id);
    }
  }

  if (sets.length === 0) {
    throw new ApiError("no_fields", "No updatable fields provided", 400);
  }

  const now = new Date().toISOString();

  sets.push("updated_at = ?");
  args.push(now, id);

  const db = await getDb();
  await db.execute({ args, sql: `update recordings set ${sets.join(", ")} where id = ?` });

  // DUAL-WRITE (Deploy-1): a tracklist edit mirrors into `recording_cues` (the
  // forward home) so the two stay in lockstep until the Deploy-2 cutover retires
  // `tracklist_json`. Each cue's `finding_id` resolves by normalized title+artist
  // (never by its random-UUID `id` — the `no_resolvable_members` trap).
  if (tracklistItems !== undefined) {
    const findingIds = await resolveFindingIdsByText(tracklistItems);

    await db.batch(
      [
        { args: [id], sql: `delete from recording_cues where recording_id = ?` },
        ...tracklistItems.map((item, index) => ({
          args: [
            item.id,
            id,
            findingIds[index] ?? null,
            item.artists.length > 0 ? item.artists.join(", ") : null,
            item.title || null,
            index + 1,
            item.startMs ?? null,
            now,
            now,
          ],
          sql: `insert into recording_cues
                  (id, recording_id, finding_id, artists_text, title_text, position, start_ms, created_at, updated_at)
                values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        })),
      ],
      "write",
    );
  }

  return getRecording(id);
}

export async function deleteRecording(id: string): Promise<void> {
  // Confirm it exists (clean 404).
  await getRecordingRow(id);

  const db = await getDb();
  await db.batch(
    [
      { args: [id], sql: `delete from mixtape_clips where recording_id = ?` },
      { args: [id], sql: `delete from recording_cues where recording_id = ?` },
      { args: [id], sql: `delete from recordings where id = ?` },
    ],
    "write",
  );
}

/**
 * Transactionally REPLACE a recording's whole `recording_cues` set (RFC §4, the
 * `replace_recording_cues` op). The body is the ORDERED cue array `{ findingId?,
 * artistsText, titleText, position, startMs? }[]` — the Wave-3 Rekordbox derivation
 * script resolves each cue's `finding_id` by normalized title+artist and PUTs the
 * result here. Positions are REINDEXED 1..n from the given order (the array IS the
 * order), so the `(recording_id, position)` unique index always holds regardless of the
 * sparse positions the script emits. An empty array clears the recording's cues. Unlike
 * `update_recording`'s tracklist dual-write, this does NOT touch `tracklist_json` — it
 * is the forward, cues-only write path.
 */
export async function replaceRecordingCues(
  id: string,
  cues: RecordingCueInput[],
): Promise<RecordingDTO> {
  // Confirm the recording exists (clean 404).
  await getRecordingRow(id);

  if (!Array.isArray(cues)) {
    throw new ApiError("invalid_cues", "cues must be an array", 400);
  }

  // Validate + normalize each cue, keeping the given array ORDER (position is reindexed).
  const normalized = cues.map((raw, index) => {
    if (!raw || typeof raw !== "object") {
      throw new ApiError("invalid_cues", `Cue ${index + 1} must be an object`, 400);
    }

    const findingId = typeof raw.findingId === "string" && raw.findingId ? raw.findingId : null;
    const artistsText =
      typeof raw.artistsText === "string" && raw.artistsText.trim() ? raw.artistsText.trim() : null;
    const titleText =
      typeof raw.titleText === "string" && raw.titleText.trim() ? raw.titleText.trim() : null;

    // A cue must carry SOME identity — a finding link or snapshot text — or it renders
    // as an empty row and cannot resolve to canon.
    if (!findingId && !artistsText && !titleText) {
      throw new ApiError(
        "invalid_cues",
        `Cue ${index + 1} needs a findingId or artistsText/titleText`,
        400,
      );
    }

    let startMs: number | null = null;

    if (raw.startMs !== undefined && raw.startMs !== null) {
      if (typeof raw.startMs !== "number" || !Number.isInteger(raw.startMs) || raw.startMs < 0) {
        throw new ApiError(
          "invalid_cues",
          `Cue ${index + 1} startMs must be a non-negative integer (ms)`,
          400,
        );
      }

      startMs = raw.startMs;
    }

    return { artistsText, findingId, position: index + 1, startMs, titleText };
  });

  const now = new Date().toISOString();
  const db = await getDb();

  await db.batch(
    [
      { args: [id], sql: `delete from recording_cues where recording_id = ?` },
      ...normalized.map((cue) => ({
        args: [
          randomUUID(),
          id,
          cue.findingId,
          cue.artistsText,
          cue.titleText,
          cue.position,
          cue.startMs,
          now,
          now,
        ],
        sql: `insert into recording_cues
                (id, recording_id, finding_id, artists_text, title_text, position, start_ms, created_at, updated_at)
              values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      })),
      { args: [now, id], sql: `update recordings set updated_at = ? where id = ?` },
    ],
    "write",
  );

  return getRecording(id);
}

/**
 * Promote a recording to a published mixtape — IDEMPOTENT (mint-or-reuse; re-runnable
 * end to end). Minting burns a scarce coordinate, so a recording that already links a
 * mixtape reuses it and NEVER re-mints. The sequence:
 *   1. CLAIM-BEFORE-MINT — reuse `mixtapes.recording_id`'s mixtape if present; else
 *      CLAIM the link with an atomic conditional insert (a guarded draft insert carrying
 *      `recording_id`), THEN seed + mint it (`publishMixtape`). The claim is the guard
 *      (RFC §2, staff-eng SF-6): the old check-then-mint path could burn a second scarce
 *      coordinate on a concurrent double-promote (both saw no link, both minted). Now two
 *      concurrent promoters serialize on the claim insert — the loser inserts 0 rows and
 *      reuses the winner's row, so at most ONE coordinate is ever minted per recording.
 *   2. copy the set video to `<logId>/set.mp4` (overwrite-safe; skipped if already there).
 *   3. flip the mixtape's `setVideoAt` (the /log player + video SEO).
 *   4. repoint the recording's owned `r2Key` to `<logId>/set.mp4`.
 *   5. delete the OLD `recordings/<id>/set.mp4` LAST, best-effort, tolerating already-gone.
 * (Members are seeded in step 1 BEFORE the mint — `publishMixtape` requires ≥1 member.)
 */
export async function promoteRecording(id: string): Promise<RecordingDTO> {
  const recording = await getRecordingRow(id);

  // A PLAN (no video — `r2_key IS NULL`) has nothing to publish: promoting it
  // would mint a coordinate for a mixtape with no set. Capture a take first.
  if (!recording.r2_key) {
    throw new ApiError(
      "recording_has_no_video",
      "This recording has no set video — upload a take before promoting",
      409,
    );
  }

  const db = await getDb();

  // (1) Read any mixtape already linked to this recording. A fully-minted one is reused
  // as-is (its coordinate is already spent).
  const linkedResult = await db.execute({
    args: [id],
    sql: `select id, log_id from mixtapes where recording_id = ? limit 1`,
  });
  const linked = typedRow<{ id: string; log_id: string | null }>(linkedResult.rows);

  let mixtapeId: string;
  let logId: string;

  if (linked?.log_id) {
    // Reuse — NEVER re-mint (a scarce coordinate is already spent on this recording).
    mixtapeId = linked.id;
    logId = linked.log_id;
  } else {
    // Resolve the members FIRST (read-only), so a recording whose cues resolve to no
    // finding errors BEFORE any coordinate is at risk.
    const members = await resolveTracklistMembers(id, recording.tracklist_json);

    if (members.length === 0) {
      throw new ApiError(
        "no_resolvable_members",
        "The recording's tracklist resolves to no Fluncle finding — attach at least one finding before promoting",
        409,
      );
    }

    if (linked) {
      // A prior run CLAIMED the link but crashed before minting (a draft with no log_id):
      // reuse that same row and finish minting it — no new coordinate.
      mixtapeId = linked.id;
    } else {
      // CLAIM the link with an atomic conditional insert: create the draft mixtape
      // carrying `recording_id`, but only if no mixtape already claims it. This is the
      // race guard — writes serialize, so a second concurrent promoter inserts 0 rows.
      const claimId = randomUUID();
      const claimNow = new Date().toISOString();
      const claim = await db.execute({
        args: [claimId, id, recording.recorded_at ?? null, claimNow, claimNow, id],
        sql: `insert into mixtapes (id, recording_id, status, title, recorded_at, created_at, updated_at)
              select ?, ?, 'draft', '', ?, ?, ?
              where not exists (select 1 from mixtapes where recording_id = ?)`,
      });

      if (claim.rowsAffected === 1) {
        mixtapeId = claimId;
      } else {
        // Lost the race — reuse the winner's row (it now owns the link).
        const winnerResult = await db.execute({
          args: [id],
          sql: `select id from mixtapes where recording_id = ? limit 1`,
        });
        const winner = typedRow<{ id: string }>(winnerResult.rows);

        if (!winner) {
          throw new ApiError("promote_failed", "Could not claim the recording link", 409);
        }

        mixtapeId = winner.id;
      }
    }

    // Seed the claimed draft's tracklist + mint it — the ONLY mint. `publishMixtape`'s
    // `status = 'draft'` guard means a concurrent loser targeting the SAME row mints
    // nothing new (it errors; a retry reuses via the `linked?.log_id` branch above).
    await setMixtapeMembers(mixtapeId, { members });
    const minted = await publishMixtape(mixtapeId);

    if (!minted.logId) {
      throw new ApiError("promote_failed", "Mixtape was not minted (no Log ID)", 409);
    }

    logId = minted.logId;
  }

  const destKey = `${logId}/set.mp4`;
  const stalePath = recording.r2_key;

  // (2) copy the set video to the mixtape's derived key (overwrite-safe). Skip when the
  // recording is already repointed there (a fully-promoted re-run) — that also avoids a
  // copy-onto-itself.
  if (stalePath !== destKey) {
    await copyObject(stalePath, destKey);
  }

  // (3) flip the mixtape's setVideoAt so the /log player + <video> SEO light up.
  await updateMixtape(mixtapeId, { setVideoAt: new Date().toISOString() });

  // (4) repoint the recording's owned key + (5) delete the old key LAST, best-effort.
  if (stalePath !== destKey) {
    await db.execute({
      args: [destKey, new Date().toISOString(), id],
      sql: `update recordings set r2_key = ?, updated_at = ? where id = ?`,
    });

    // Best-effort, tolerating an already-gone key — the promote must not fail on cleanup.
    await deleteObject(stalePath).catch(() => {});
  }

  return getRecording(id);
}

// Resolve a recording's cues to the `setMixtapeMembers` shape: each cue with a
// `finding_id` becomes a `{ ref, startMs }` member, deduped by finding (a set can
// play a track twice), in cue order. `recording_cues.finding_id` is the honest
// link — the old `getTrackByIdOrLogId(cue.id)` lookup is DELETED (cue ids are
// random UUIDs, so it resolved to ZERO findings: the live `no_resolvable_members`
// trap; RFC plan→recording→mixtape §4/S4). DUAL-READ: a recording whose cues have
// not been backfilled yet falls back to `tracklist_json`, resolved by NORMALIZED
// title+artist. Cues that resolve to no finding are skipped — the clip overlay
// still reads them, but the spine tracklist only holds real findings. (Findings
// are Spotify-backed and cannot be minted from a bare `{ artists, title }`, so
// this resolves rather than creates.)
async function resolveTracklistMembers(
  recordingId: string,
  tracklistJson: string | null,
): Promise<Array<{ ref: string; startMs?: number }>> {
  const members: Array<{ ref: string; startMs?: number }> = [];
  const seen = new Set<string>();
  const push = (findingId: string | null, startMs: number | null | undefined): void => {
    if (!findingId || seen.has(findingId)) {
      return;
    }

    seen.add(findingId);
    members.push(
      startMs === null || startMs === undefined ? { ref: findingId } : { ref: findingId, startMs },
    );
  };

  const cues = await getCueRows(recordingId);

  if (cues.length > 0) {
    for (const cue of cues) {
      push(cue.finding_id, cue.start_ms);
    }

    return members;
  }

  // Legacy fallback (pre-backfill rows): resolve the JSON cues by text.
  const tracklist = parseTracklist(tracklistJson);
  const findingIds = await resolveFindingIdsByText(tracklist);

  for (const [index, cue] of tracklist.entries()) {
    push(findingIds[index] ?? null, cue.startMs);
  }

  return members;
}

// Resolve each `{ artists, title }` item to a finding's trackId (or null) by
// normalized title+artist against the full catalogue — the key_backfill matcher
// discipline (see ./track-match). One catalogue read per call; tracklists are
// tiny and this path is admin-only.
async function resolveFindingIdsByText(
  items: RecordingTracklistItem[],
): Promise<Array<string | null>> {
  if (items.length === 0) {
    return [];
  }

  const db = await getDb();
  const result = await db.execute({ sql: `select track_id, title, artists_json from tracks` });
  const index = buildTrackMatchIndex(
    typedRows<{ artists_json: string; title: string; track_id: string }>(result.rows).map(
      (row) => ({
        artists: parseArtistsJson(row.artists_json),
        title: row.title,
        trackId: row.track_id,
      }),
    ),
  );

  return items.map((item) => resolveTrackByText(index, item.artists, item.title));
}

/** Parse a `tracks.artists_json` cell into a string[] (tolerating bad JSON). */
function parseArtistsJson(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);

    return Array.isArray(parsed) ? parsed.map((value) => String(value)) : [];
  } catch {
    return [];
  }
}

// Validate the update's `tracklistJson` (the whole `[{ id, artists, title, startMs? }]`
// array) into the canonical items the caller both stores as JSON text AND mirrors
// into `recording_cues` (the Deploy-1 dual-write). A cue with no `id` gets a fresh one.
function serializeTracklist(value: unknown): RecordingTracklistItem[] {
  if (!Array.isArray(value)) {
    throw new ApiError("invalid_tracklist", "tracklistJson must be an array of cues", 400);
  }

  const items: RecordingTracklistItem[] = value.map((raw, index) => {
    if (!raw || typeof raw !== "object") {
      throw new ApiError("invalid_tracklist", `Cue ${index + 1} must be an object`, 400);
    }

    const entry = raw as Record<string, unknown>;
    const title = typeof entry.title === "string" ? entry.title.trim() : "";

    if (!title) {
      throw new ApiError("invalid_tracklist", `Cue ${index + 1} needs a title`, 400);
    }

    const artists = Array.isArray(entry.artists)
      ? entry.artists.filter((artist): artist is string => typeof artist === "string")
      : [];

    if (
      entry.startMs !== undefined &&
      entry.startMs !== null &&
      (typeof entry.startMs !== "number" || !Number.isInteger(entry.startMs) || entry.startMs < 0)
    ) {
      throw new ApiError(
        "invalid_tracklist",
        `Cue ${index + 1} startMs must be a non-negative integer (ms)`,
        400,
      );
    }

    const id = typeof entry.id === "string" && entry.id ? entry.id : randomUUID();
    const startMs = typeof entry.startMs === "number" ? entry.startMs : undefined;

    return startMs === undefined ? { artists, id, title } : { artists, id, startMs, title };
  });

  return items;
}

function requireText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError("invalid_input", `${field} is required`, 400);
  }

  return value.trim().slice(0, maxLength);
}

// A take→plan link value: a non-empty recording id (attach), or `null`/`""` (detach to
// an orphan). `undefined` is filtered out by the caller before this runs.
function optionalRecordingId(value: unknown): string | null {
  if (value === null || value === "") {
    return null;
  }

  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError("invalid_parent", "parentId must be a recording id or null", 400);
  }

  return value.trim();
}

function optionalIsoDate(value: unknown, field: string): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || value === "") {
    return null;
  }

  if (typeof value !== "string") {
    throw new ApiError("invalid_date", `${field} must be a valid date`, 400);
  }

  const date = new Date(value.trim());

  if (Number.isNaN(date.getTime())) {
    throw new ApiError("invalid_date", `${field} must be a valid date`, 400);
  }

  return date.toISOString();
}
