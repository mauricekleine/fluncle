import { randomUUID } from "node:crypto";
import { type RecordingDTO, type RecordingTracklistItem } from "@fluncle/contracts/orpc";
import { galaxySlug } from "@fluncle/contracts/util/galaxy-slug";
import { getDb, typedRow, typedRows } from "./db";
import { publishMixtape, setMixtapeMembers, updateMixtape } from "./mixtapes";
import { copyObject, deleteObject } from "./r2-presign";
import { ApiError } from "./spotify";
import { buildTrackMatchIndex, resolveTrackByText } from "./track-match";

const titleMaxLength = 200;
const planHandleMaxAttempts = 64;

export function recordingR2Key(id: string): string {
  return `recordings/${id}/set.mp4`;
}

type RecordingRow = {
  created_at: string;
  duration_ms: number | null;
  id: string;
  parent_id: string | null;
  planned_for: string | null;
  r2_key: string | null;
  recorded_at: string | null;
  title: string;
  updated_at: string;
  version: number;
};

export type CueRow = {
  artists_text: string | null;
  finding_id: string | null;
  id: string;
  position: number;
  start_ms: number | null;
  title_text: string | null;
};

type RecordingJoinRow = RecordingRow & {
  mixtape_id: string | null;
  mixtape_log_id: string | null;
};

export type RecordingInput = {
  kind?: unknown;
  parentId?: unknown;
  plannedFor?: unknown;
  recordedAt?: unknown;
  title?: unknown;
  tracklistJson?: unknown;
};

export type RecordingCueInput = {
  artistsText?: unknown;
  findingId?: unknown;
  position?: unknown;
  startMs?: unknown;
  titleText?: unknown;
};

export type RecordingListFilter = {
  kind?: "plan" | "take";
  parentId?: string;
};

function cueRowToTracklistItem(row: CueRow): RecordingTracklistItem {
  return {
    artists: row.artists_text ? row.artists_text.split(", ") : [],
    findingId: row.finding_id ?? undefined,
    id: row.id,
    startMs: row.start_ms ?? undefined,
    title: row.title_text ?? "",
  };
}

function rowToRecording(row: RecordingJoinRow, cues: RecordingTracklistItem[]): RecordingDTO {
  return {
    createdAt: row.created_at,
    durationMs: row.duration_ms ?? undefined,
    hasVideo: row.r2_key !== null,
    id: row.id,
    logId: row.mixtape_log_id ?? undefined,
    mixtapeId: row.mixtape_id ?? undefined,
    parentId: row.parent_id ?? undefined,
    plannedFor: row.planned_for ?? undefined,
    r2Key: row.r2_key ?? undefined,
    recordedAt: row.recorded_at ?? undefined,
    title: row.title,
    tracklist: cues,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

const CUE_SELECT = `select id, recording_id, finding_id, artists_text, title_text, position, start_ms
  from recording_cues`;

async function getCueRows(recordingId: string): Promise<CueRow[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [recordingId],
    sql: `${CUE_SELECT} where recording_id = ? order by position`,
  });

  return typedRows<CueRow>(result.rows);
}

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
  r.updated_at,
  r.version,
  m.id as mixtape_id,
  m.log_id as mixtape_log_id
  from recordings r
  left join mixtapes m on m.recording_id = r.id`;

async function getRecordingRow(id: string): Promise<RecordingRow> {
  const db = await getDb();
  const result = await db.execute({
    args: [id],
    sql: `select created_at, duration_ms, id, parent_id, planned_for, r2_key, recorded_at, title, updated_at, version
          from recordings where id = ? limit 1`,
  });
  const row = typedRow<RecordingRow>(result.rows);

  if (!row) {
    throw new ApiError("recording_not_found", "Recording not found", 404);
  }

  return row;
}

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

export async function listUpcomingPlans(nowIso: string): Promise<RecordingDTO[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [nowIso],
    sql: `${RECORDING_SELECT}
          where r.planned_for is not null and r.planned_for > ?
          order by r.planned_for asc, r.id asc
          limit 54`,
  });
  const cueTracklists = await getCueTracklists();

  return typedRows<RecordingJoinRow>(result.rows).map((row) =>
    rowToRecording(row, cueTracklists.get(row.id) ?? []),
  );
}

export type PlanMembership = {
  recordingId: string;
  title: string;
};

export async function listPlanMembershipsForTracks(
  trackIds: string[],
): Promise<Record<string, PlanMembership[]>> {
  if (trackIds.length === 0) {
    return {};
  }

  const db = await getDb();
  const placeholders = trackIds.map(() => "?").join(", ");
  const result = await db.execute({
    args: trackIds,
    sql: `select rc.finding_id, r.id as recording_id, r.title
          from recording_cues rc
          join recordings r on r.id = rc.recording_id
          where r.r2_key is null and rc.finding_id in (${placeholders})
          order by r.created_at, r.id, rc.position`,
  });

  const byTrack: Record<string, PlanMembership[]> = {};

  for (const row of typedRows<{
    finding_id: string;
    recording_id: string;
    title: string;
  }>(result.rows)) {
    const memberships = (byTrack[row.finding_id] ??= []);

    if (!memberships.some((membership) => membership.recordingId === row.recording_id)) {
      memberships.push({ recordingId: row.recording_id, title: row.title });
    }
  }

  return byTrack;
}

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

  return `${galaxySlug(id, 0)}-${id.slice(0, 8)}`;
}

export async function createRecording(input: RecordingInput): Promise<RecordingDTO> {
  const recordedAt = optionalIsoDate(input.recordedAt, "recordedAt");
  const id = randomUUID();
  const now = new Date().toISOString();
  const db = await getDb();

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

  if (input.plannedFor !== undefined) {
    sets.push("planned_for = ?");
    args.push(optionalIsoDate(input.plannedFor, "plannedFor") ?? null);
  }

  const tracklistItems: RecordingTracklistItem[] | undefined =
    input.tracklistJson === undefined ? undefined : serializeTracklist(input.tracklistJson);

  if (input.parentId !== undefined) {
    const parentId = optionalRecordingId(input.parentId);

    if (parentId === null) {
      sets.push("parent_id = ?");
      args.push(null);
    } else {
      await getRecordingRow(parentId);
      sets.push("parent_id = ?");
      args.push(parentId);
      sets.push(
        "version = (select coalesce(max(version), 0) + 1 from recordings where parent_id is ? and id <> ?)",
      );
      args.push(parentId, id);
    }
  }

  if (sets.length === 0 && tracklistItems === undefined) {
    throw new ApiError("no_fields", "No updatable fields provided", 400);
  }

  const now = new Date().toISOString();

  sets.push("updated_at = ?");
  args.push(now, id);

  const db = await getDb();
  await db.execute({ args, sql: `update recordings set ${sets.join(", ")} where id = ?` });

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

export async function replaceRecordingCues(
  id: string,
  cues: RecordingCueInput[],
): Promise<RecordingDTO> {
  await getRecordingRow(id);

  if (!Array.isArray(cues)) {
    throw new ApiError("invalid_cues", "cues must be an array", 400);
  }

  const normalized = cues.map((raw, index) => {
    if (!raw || typeof raw !== "object") {
      throw new ApiError("invalid_cues", `Cue ${index + 1} must be an object`, 400);
    }

    const findingId = typeof raw.findingId === "string" && raw.findingId ? raw.findingId : null;
    const artistsText =
      typeof raw.artistsText === "string" && raw.artistsText.trim() ? raw.artistsText.trim() : null;
    const titleText =
      typeof raw.titleText === "string" && raw.titleText.trim() ? raw.titleText.trim() : null;

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
      {
        args: [now, id],
        sql: `update recordings set updated_at = ? where id = ?`,
      },
    ],
    "write",
  );

  return getRecording(id);
}

export async function promoteRecording(id: string): Promise<RecordingDTO> {
  const recording = await getRecordingRow(id);

  if (!recording.r2_key) {
    throw new ApiError(
      "recording_has_no_video",
      "This recording has no set video — upload a take before promoting",
      409,
    );
  }

  const db = await getDb();

  const linkedResult = await db.execute({
    args: [id],
    sql: `select id, log_id from mixtapes where recording_id = ? limit 1`,
  });
  const linked = typedRow<{ id: string; log_id: string | null }>(linkedResult.rows);

  let mixtapeId: string;
  let logId: string;

  if (linked?.log_id) {
    mixtapeId = linked.id;
    logId = linked.log_id;
  } else {
    const members = await resolveTracklistMembers(id);

    if (members.length === 0) {
      throw new ApiError(
        "no_resolvable_members",
        "The recording's tracklist resolves to no Fluncle finding — attach at least one finding before promoting",
        409,
      );
    }

    if (linked) {
      mixtapeId = linked.id;
    } else {
      const claimId = randomUUID();
      const claimNow = new Date().toISOString();
      const claim = await db.execute({
        args: [claimId, id, recording.recorded_at ?? null, claimNow, claimNow, id],
        sql: `insert into mixtapes (id, recording_id, status, title, recorded_at, created_at, updated_at)
              select ?, ?, 'distributing', '', ?, ?, ?
              where not exists (select 1 from mixtapes where recording_id = ?)`,
      });

      if (claim.rowsAffected === 1) {
        mixtapeId = claimId;
      } else {
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

    await setMixtapeMembers(mixtapeId, { members });
    const minted = await publishMixtape(mixtapeId);

    if (!minted.logId) {
      throw new ApiError("promote_failed", "Mixtape was not minted (no Log ID)", 409);
    }

    logId = minted.logId;
  }

  const destKey = `${logId}/set.mp4`;
  const stalePath = recording.r2_key;

  if (stalePath !== destKey) {
    await copyObject(stalePath, destKey);
  }

  await updateMixtape(mixtapeId, { setVideoAt: new Date().toISOString() });

  if (stalePath !== destKey) {
    await db.execute({
      args: [destKey, new Date().toISOString(), id],
      sql: `update recordings set r2_key = ?, updated_at = ? where id = ?`,
    });

    await deleteObject(stalePath).catch(() => {});
  }

  return getRecording(id);
}

async function resolveTracklistMembers(
  recordingId: string,
): Promise<Array<{ ref: string; startMs?: number }>> {
  const members: Array<{ ref: string; startMs?: number }> = [];
  const seen = new Set<string>();

  for (const cue of await getCueRows(recordingId)) {
    if (!cue.finding_id || seen.has(cue.finding_id)) {
      continue;
    }

    seen.add(cue.finding_id);
    members.push(
      cue.start_ms === null
        ? { ref: cue.finding_id }
        : { ref: cue.finding_id, startMs: cue.start_ms },
    );
  }

  return members;
}

export const FINDING_MATCH_CORPUS_SQL = `select tracks.track_id, tracks.title, tracks.artists_json
      from findings cross join tracks on tracks.track_id = findings.track_id`;

async function resolveFindingIdsByText(
  items: RecordingTracklistItem[],
): Promise<Array<string | null>> {
  if (items.length === 0) {
    return [];
  }

  const db = await getDb();
  const result = await db.execute({ sql: FINDING_MATCH_CORPUS_SQL });
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

function parseArtistsJson(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);

    return Array.isArray(parsed) ? parsed.map((value) => String(value)) : [];
  } catch {
    return [];
  }
}

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
