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
import { buildTrackMatchIndex, resolveTrackByText } from "./track-match";

const titleMaxLength = 200;

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
  r2_key: string | null;
  recorded_at: string | null;
  title: string;
  tracklist_json: string | null;
  updated_at: string;
};

// One `recording_cues` row (the forward home of a recording's cues; RFC
// plan→recording→mixtape §2). `finding_id` is the honest link to canon.
type CueRow = {
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
    id: row.id,
    logId: row.mixtape_log_id ?? undefined,
    mixtapeId: row.mixtape_id ?? undefined,
    r2Key: row.r2_key ?? undefined,
    recordedAt: row.recorded_at ?? undefined,
    title: row.title,
    tracklist: legacy.length > 0 ? legacy : cues,
    updatedAt: row.updated_at,
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

  return rowToRecording(row, (await getCueRows(id)).map(cueRowToTracklistItem));
}

export async function listRecordings(): Promise<RecordingDTO[]> {
  const db = await getDb();
  const result = await db.execute({
    sql: `${RECORDING_SELECT} order by r.created_at desc, r.id desc`,
  });
  const cueTracklists = await getCueTracklists();

  return typedRows<RecordingJoinRow>(result.rows).map((row) =>
    rowToRecording(row, cueTracklists.get(row.id) ?? []),
  );
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

  let tracklistItems: RecordingTracklistItem[] | undefined;

  if (input.tracklistJson !== undefined) {
    tracklistItems = serializeTracklist(input.tracklistJson);
    sets.push("tracklist_json = ?");
    args.push(JSON.stringify(tracklistItems));
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
    const members = await resolveTracklistMembers(id, recording.tracklist_json);

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
