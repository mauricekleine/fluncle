// The recording data layer (RFC recording-primitive, Design B). A RECORDING is a
// captured DJ set that is NOT (yet) a published mixtape: it OWNS its R2 key
// (`recordings/<id>/set.mp4` in the public `fluncle-videos` bucket — accept-obscurity,
// no private bucket), carries an optional cue tracklist, and is deliberately
// COORDINATE-LESS. The clip pipeline cuts clips from a recording's set video without
// minting a scarce Log ID; only `promoteRecording` (→ a full published mixtape) ever
// mints one. Mirrors the validate-and-throw style of `./mixtapes`.

import { randomUUID } from "node:crypto";
import { type RecordingDTO, type RecordingTracklistItem } from "@fluncle/contracts/orpc";
import { getDb, typedRow, typedRows } from "./db";
import { createMixtape, publishMixtape, setMixtapeMembers, updateMixtape } from "./mixtapes";
import { copyObject, deleteObject } from "./r2-presign";
import { ApiError } from "./spotify";
import { getTrackByIdOrLogId } from "./tracks";

const titleMaxLength = 200;

// The recording's OWNED R2 key — derived from its id, so the key exists the moment the
// row does (the upload presign targets exactly this). Standalone recordings live under
// `recordings/<id>/set.mp4` in the existing `fluncle-videos` bucket.
export function recordingR2Key(id: string): string {
  return `recordings/${id}/set.mp4`;
}

// The recordings table row (no join).
type RecordingRow = {
  created_at: string;
  duration_ms: number | null;
  id: string;
  r2_key: string;
  recorded_at: string | null;
  title: string;
  tracklist_json: string | null;
  updated_at: string;
};

// The recordings row LEFT JOINed to the mixtape it was promoted into (if any), for the
// public DTO's `logId` + `mixtapeId`.
type RecordingJoinRow = RecordingRow & {
  mixtape_id: string | null;
  mixtape_log_id: string | null;
};

/** The operator-authored fields a recording create/update accepts. */
export type RecordingInput = {
  recordedAt?: unknown;
  title?: unknown;
  // The whole cue tracklist, an array of `{ id, artists, title, startMs? }` (update only).
  tracklistJson?: unknown;
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

function rowToRecording(row: RecordingJoinRow): RecordingDTO {
  return {
    createdAt: row.created_at,
    durationMs: row.duration_ms ?? undefined,
    id: row.id,
    logId: row.mixtape_log_id ?? undefined,
    mixtapeId: row.mixtape_id ?? undefined,
    r2Key: row.r2_key,
    recordedAt: row.recorded_at ?? undefined,
    title: row.title,
    tracklist: parseTracklist(row.tracklist_json),
    updatedAt: row.updated_at,
  };
}

const RECORDING_SELECT = `select
  r.created_at,
  r.duration_ms,
  r.id,
  r.r2_key,
  r.recorded_at,
  r.title,
  r.tracklist_json,
  r.updated_at,
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
    sql: `select created_at, duration_ms, id, r2_key, recorded_at, title, tracklist_json, updated_at
          from recordings where id = ? limit 1`,
  });
  const row = typedRow<RecordingRow>(result.rows);

  if (!row) {
    throw new ApiError("recording_not_found", "Recording not found", 404);
  }

  return row;
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

  return rowToRecording(row);
}

export async function listRecordings(): Promise<RecordingDTO[]> {
  const db = await getDb();
  const result = await db.execute({
    sql: `${RECORDING_SELECT} order by r.created_at desc, r.id desc`,
  });

  return typedRows<RecordingJoinRow>(result.rows).map(rowToRecording);
}

export async function createRecording(input: RecordingInput): Promise<RecordingDTO> {
  const title = requireText(input.title, "title", titleMaxLength);
  const recordedAt = optionalIsoDate(input.recordedAt, "recordedAt");
  const id = randomUUID();
  const r2Key = recordingR2Key(id);
  const now = new Date().toISOString();
  const db = await getDb();

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

  if (input.tracklistJson !== undefined) {
    sets.push("tracklist_json = ?");
    args.push(serializeTracklist(input.tracklistJson));
  }

  if (sets.length === 0) {
    throw new ApiError("no_fields", "No updatable fields provided", 400);
  }

  sets.push("updated_at = ?");
  args.push(new Date().toISOString(), id);

  const db = await getDb();
  await db.execute({ args, sql: `update recordings set ${sets.join(", ")} where id = ?` });

  return getRecording(id);
}

export async function deleteRecording(id: string): Promise<void> {
  // Confirm it exists (clean 404).
  await getRecordingRow(id);

  const db = await getDb();
  await db.batch(
    [
      { args: [id], sql: `delete from mixtape_clips where recording_id = ?` },
      { args: [id], sql: `delete from recordings where id = ?` },
    ],
    "write",
  );
}

/**
 * Promote a recording to a published mixtape — IDEMPOTENT (mint-or-reuse; re-runnable
 * end to end). Minting burns a scarce coordinate, so a recording that already links a
 * mixtape reuses it and NEVER re-mints. The sequence:
 *   1. mint-or-reuse — reuse `mixtapes.recording_id`'s mixtape if present; else create a
 *      draft, seed it from the tracklist, mint it (`publishMixtape`), and link it back.
 *   2. copy the set video to `<logId>/set.mp4` (overwrite-safe; skipped if already there).
 *   3. flip the mixtape's `setVideoAt` (the /log player + video SEO).
 *   4. repoint the recording's owned `r2Key` to `<logId>/set.mp4`.
 *   5. delete the OLD `recordings/<id>/set.mp4` LAST, best-effort, tolerating already-gone.
 * (Members are seeded in step 1 BEFORE the mint — `publishMixtape` requires ≥1 member.)
 */
export async function promoteRecording(id: string): Promise<RecordingDTO> {
  const recording = await getRecordingRow(id);
  const db = await getDb();

  // (1) mint-or-reuse. A minted mixtape already linked to this recording is reused as-is.
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
    // Create + mint a fresh mixtape from the recording. Seed the tracklist FIRST (mint
    // requires ≥1 member), resolving each cue to an existing finding.
    const members = await resolveTracklistMembers(parseTracklist(recording.tracklist_json));

    if (members.length === 0) {
      throw new ApiError(
        "no_resolvable_members",
        "The recording's tracklist resolves to no Fluncle finding — attach at least one finding before promoting",
        409,
      );
    }

    const draft = await createMixtape({ recordedAt: recording.recorded_at ?? undefined });

    if (!draft.id) {
      throw new ApiError("promote_failed", "Could not create the mixtape draft", 500);
    }

    mixtapeId = draft.id;
    await setMixtapeMembers(mixtapeId, { members });
    const minted = await publishMixtape(mixtapeId);

    if (!minted.logId) {
      throw new ApiError("promote_failed", "Mixtape was not minted (no Log ID)", 409);
    }

    logId = minted.logId;

    // Link the minted mixtape back to the recording (so a re-run reuses, never re-mints).
    await db.execute({
      args: [id, mixtapeId],
      sql: `update mixtapes set recording_id = ? where id = ?`,
    });
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

// Resolve a recording's cue tracklist to the `setMixtapeMembers` shape: each cue whose
// `id` resolves to an existing Fluncle finding becomes a `{ ref, startMs }` member,
// deduped by resolved trackId (a set can play a track twice), in tracklist order. Cues
// that resolve to no finding are skipped — the clip overlay still reads them from
// `tracklist_json`, but the spine tracklist only holds real findings. (Findings are
// Spotify-backed and cannot be minted from a bare `{ artists, title }`, so this resolves
// rather than creates.)
async function resolveTracklistMembers(
  tracklist: RecordingTracklistItem[],
): Promise<Array<{ ref: string; startMs?: number }>> {
  const members: Array<{ ref: string; startMs?: number }> = [];
  const seen = new Set<string>();

  for (const cue of tracklist) {
    const track = await getTrackByIdOrLogId(cue.id);

    if (!track || seen.has(track.trackId)) {
      continue;
    }

    seen.add(track.trackId);
    members.push(
      cue.startMs === undefined ? { ref: cue.id } : { ref: cue.id, startMs: cue.startMs },
    );
  }

  return members;
}

// Validate the update's `tracklistJson` (the whole `[{ id, artists, title, startMs? }]`
// array) and serialize it to the stored JSON text. A cue with no `id` gets a fresh one.
function serializeTracklist(value: unknown): string {
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

  return JSON.stringify(items);
}

function requireText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError("invalid_input", `${field} is required`, 400);
  }

  return value.trim().slice(0, maxLength);
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
