import { randomUUID } from "node:crypto";
import { mixtapeLogId } from "../mixtape-log-id";
import { type MixtapeDTO, type MixtapeStatus, rowToMixtape } from "../mixtapes";
import { getDb, typedRow, typedRows } from "./db";
import { purgeLogCache } from "./edge-cache";
import { ApiError } from "./spotify";
import { postMixtapeToTelegram } from "./telegram";
import { getTrackByIdOrLogId, getTracksForMixtape } from "./tracks";

function purgeMixtapeLogCache(mixtape: MixtapeDTO): MixtapeDTO {
  purgeLogCache(mixtape.logId);

  return mixtape;
}

const noteMaxLength = 1_200;
const urlMaxLength = 500;

export const DEFAULT_MIXTAPE_TITLE = "Fluncle Drum & Bass Mixtape";
const LEGACY_MIXTAPE_TITLE = "Untitled mixtape";

type MixtapeRow = {
  added_at: string | null;
  announced_at: string | null;
  created_at: string;
  duration_ms: number | null;
  id: string;
  log_id: string | null;
  member_count: number | null;
  mixcloud_url: string | null;
  note: string | null;
  published_at: string | null;
  recorded_at: string | null;
  recording_id: string | null;
  sequence_number: number | null;
  set_video_at: string | null;
  soundcloud_url: string | null;
  status: MixtapeStatus;
  title: string;
  updated_at: string;
  youtube_url: string | null;
};

type PublishRow = {
  log_id: string;
  sequence_number: number;
};

type StatusRow = {
  log_id: string | null;
  status: MixtapeStatus;
};

export type MixtapeInput = {
  durationMs?: unknown;
  note?: unknown;
  recordedAt?: unknown;
  setVideoAt?: unknown;
  soundcloudUrl?: unknown;
};

export type MixtapeMemberInput = {
  members?: Array<string | { ref: string; startMs?: number }>;
};

export type MixtapeMembership = {
  logId?: string;
  mixtapeId: string;
  status: MixtapeStatus;
  title: string;
};

export async function updateMixtape(id: string, input: MixtapeInput): Promise<MixtapeDTO> {
  const current = await getMixtapeById(id);
  const fields = validateMixtapeInput(input);

  if (current.status === "published" && fields.recordedAt !== undefined) {
    throw new ApiError(
      "recorded_at_immutable",
      "The recorded date is locked once a mixtape is published",
      409,
    );
  }

  const sets: string[] = [];
  const args: Array<number | string | null> = [];

  for (const [column, value] of [
    ["duration_ms", fields.durationMs],
    ["note", fields.note],
    ["recorded_at", fields.recordedAt],
    ["set_video_at", fields.setVideoAt],
  ] as const) {
    if (value !== undefined) {
      sets.push(`${column} = ?`);
      args.push(value ?? null);
    }
  }

  if (sets.length === 0 && fields.soundcloudUrl === undefined) {
    throw new ApiError("no_fields", "No updatable fields provided", 400);
  }

  if (sets.length > 0) {
    sets.push("updated_at = ?");
    args.push(new Date().toISOString(), id);

    const db = await getDb();
    await db.execute({
      args,
      sql: `update mixtapes set ${sets.join(", ")} where id = ?`,
    });
  }

  if (fields.soundcloudUrl !== undefined) {
    await setMixtapeSoundcloud(id, fields.soundcloudUrl);
  }

  return purgeMixtapeLogCache(await getMixtapeById(id));
}

async function setMixtapeSoundcloud(mixtapeId: string, url: string | null): Promise<void> {
  const now = new Date().toISOString();
  const db = await getDb();

  if (url) {
    await db.execute({
      args: [randomUUID(), mixtapeId, url, now, now, now, url, now],
      sql: `insert into mixtape_social_posts (id, mixtape_id, platform, status, url, published_at, created_at, updated_at)
            values (?, ?, 'soundcloud', 'published', ?, ?, ?, ?)
            on conflict(mixtape_id, platform) do update set
              status = 'published',
              url = ?,
              published_at = coalesce(mixtape_social_posts.published_at, ?),
              updated_at = excluded.updated_at`,
    });
  } else {
    await db.execute({
      args: [mixtapeId],
      sql: `delete from mixtape_social_posts where mixtape_id = ? and platform = 'soundcloud'`,
    });
  }

  await db.execute({
    args: [now, mixtapeId],
    sql: `update mixtapes set updated_at = ? where id = ?`,
  });
}

export async function setMixtapeMembers(
  id: string,
  input: MixtapeMemberInput,
): Promise<MixtapeDTO> {
  if (!Array.isArray(input.members) || input.members.length === 0) {
    throw new ApiError("invalid_members", "Add at least one finding to the mixtape", 400);
  }

  await assertUnmintedMixtape(id);

  const seen = new Set<string>();
  const entries: { startMs: number | null; trackId: string }[] = [];

  for (const raw of input.members) {
    const ref = typeof raw === "string" ? raw : raw?.ref;
    const startMs = typeof raw === "string" ? undefined : raw?.startMs;

    const value = requireText(ref, "member", 80);

    if (startMs !== undefined) {
      if (typeof startMs !== "number" || !Number.isInteger(startMs) || startMs < 0) {
        throw new ApiError(
          "invalid_start_ms",
          "Cue timestamps must be non-negative integers (ms)",
          400,
        );
      }
    }

    const track = await getTrackByIdOrLogId(value);

    if (!track) {
      throw new ApiError("member_not_found", `No finding with id ${value}`, 400);
    }

    if (seen.has(track.trackId)) {
      throw new ApiError("duplicate_member", "A finding can only appear once", 400);
    }

    seen.add(track.trackId);
    entries.push({ startMs: startMs ?? null, trackId: track.trackId });
  }

  const db = await getDb();
  await db.batch(
    [
      { args: [id], sql: `delete from mixtape_tracks where mixtape_id = ?` },
      ...entries.map((entry, index) => ({
        args: [id, entry.trackId, entry.trackId, index + 1, entry.startMs],
        sql: `insert into mixtape_tracks (mixtape_id, track_id, finding_id, position, start_ms) values (?, ?, ?, ?, ?)`,
      })),
      {
        args: [new Date().toISOString(), id],
        sql: `update mixtapes set updated_at = ? where id = ?`,
      },
    ],
    "write",
  );

  return purgeMixtapeLogCache(await getMixtapeById(id));
}

export type MixtapeCueInput = {
  cues?: Array<{ ref?: unknown; startMs?: unknown }>;
};

export async function setMixtapeCues(id: string, input: MixtapeCueInput): Promise<MixtapeDTO> {
  if (!Array.isArray(input.cues) || input.cues.length === 0) {
    throw new ApiError("invalid_cues", "Provide a cue for every track", 400);
  }

  const mixtape = await getMixtapeById(id);

  if (!mixtape.logId) {
    throw new ApiError(
      "mixtape_not_minted",
      "Cues backfill a minted set — promote the recording first",
      409,
    );
  }

  const byRef = new Map<string, number>();

  for (const raw of input.cues) {
    const ref = typeof raw?.ref === "string" ? raw.ref.trim() : "";
    const startMs = raw?.startMs;

    if (!ref) {
      throw new ApiError("invalid_cues", "Each cue needs a track ref", 400);
    }

    if (typeof startMs !== "number" || !Number.isInteger(startMs) || startMs < 0) {
      throw new ApiError(
        "invalid_start_ms",
        "Cue timestamps must be non-negative integers (ms)",
        400,
      );
    }

    if (byRef.has(ref)) {
      throw new ApiError("duplicate_cue", "A track can only carry one cue", 400);
    }

    byRef.set(ref, startMs);
  }

  const db = await getDb();
  const membersResult = await db.execute({
    args: [id],
    sql: `select track_id, position from mixtape_tracks where mixtape_id = ? order by position`,
  });
  const members = typedRows<{ position: number; track_id: string }>(membersResult.rows);

  if (members.length !== byRef.size) {
    throw new ApiError(
      "member_set_changed",
      "Cues must cover exactly the current tracklist (one per track)",
      409,
    );
  }

  for (const ref of byRef.keys()) {
    if (!members.some((member) => member.track_id === ref)) {
      throw new ApiError("non_member_cue", `No current member with id ${ref}`, 400);
    }
  }

  let previous = -1;

  for (const [index, member] of members.entries()) {
    const startMs = byRef.get(member.track_id) ?? 0;

    if (index === 0 && startMs !== 0) {
      throw new ApiError("cue_not_start_at_zero", "The first cue must start at 0 ms", 400);
    }

    if (startMs <= previous) {
      throw new ApiError(
        "cue_not_monotonic",
        "Cues must increase along the tracklist (no repeats, in order)",
        400,
      );
    }

    previous = startMs;
  }

  const now = new Date().toISOString();
  await db.batch(
    [
      ...members.map((member) => ({
        args: [byRef.get(member.track_id) ?? 0, id, member.track_id],
        sql: `update mixtape_tracks set start_ms = ? where mixtape_id = ? and track_id = ?`,
      })),
      { args: [now, id], sql: `update mixtapes set updated_at = ? where id = ?` },
    ],
    "write",
  );

  return purgeMixtapeLogCache(await getMixtapeById(id));
}

export async function listMixtapeMembershipsForTracks(
  trackIds: string[],
): Promise<Record<string, MixtapeMembership[]>> {
  if (trackIds.length === 0) {
    return {};
  }

  const db = await getDb();
  const placeholders = trackIds.map(() => "?").join(", ");
  const result = await db.execute({
    args: trackIds,
    sql: `select mt.track_id, m.id as mixtape_id, m.log_id, m.title, m.status
          from mixtape_tracks mt
          join mixtapes m on m.id = mt.mixtape_id
          where mt.track_id in (${placeholders})
          order by m.sequence_number, m.created_at`,
  });

  const byTrack: Record<string, MixtapeMembership[]> = {};

  for (const row of typedRows<{
    log_id: string | null;
    mixtape_id: string;
    status: MixtapeStatus;
    title: string;
    track_id: string;
  }>(result.rows)) {
    (byTrack[row.track_id] ??= []).push({
      logId: row.log_id ?? undefined,
      mixtapeId: row.mixtape_id,
      status: row.status,
      title: row.title,
    });
  }

  return byTrack;
}

export async function publishMixtape(id: string): Promise<MixtapeDTO> {
  const claim = await getMixtapeById(id);

  if (claim.logId) {
    if (claim.status === "published") {
      throw new ApiError("already_published", "Published mixtapes keep their coordinate", 409);
    }

    throw new ApiError(
      "already_minted",
      "This mixtape already has its coordinate — distribution is in progress",
      409,
    );
  }

  if (claim.memberCount < 1) {
    throw new ApiError("missing_members", "Add at least one finding before publishing", 409);
  }

  if ((await nextMixtapeSequence()) > 54) {
    throw new ApiError("mixtape_cap_reached", "The mixtape spine is full (54)", 409);
  }

  const recordedAt = claim.recordedAt ?? new Date().toISOString();
  const sectorPrefix = mixtapeLogId(recordedAt, 1).slice(0, -2);
  const now = new Date().toISOString();
  const db = await getDb();
  const [publishResult] = await db.batch(
    [
      {
        args: [sectorPrefix, recordedAt, now, now, id],
        sql: `with next_sequence(n) as (
                select coalesce(max(sequence_number), 0) + 1
                from mixtapes
                where sequence_number is not null
              )
              update mixtapes
              set
                sequence_number = (select n from next_sequence),
                log_id = ? || cast(((select n from next_sequence) - 1) / 6 + 1 as integer)
                  || substr('ABCDEF', ((select n from next_sequence) - 1) % 6 + 1, 1),
                status = 'distributing',
                recorded_at = ?,
                added_at = ?,
                updated_at = ?
              where id = ?
                and log_id is null
                and (select n from next_sequence) <= 54
              returning log_id, sequence_number`,
      },
    ],
    "write",
  );

  if (publishResult === undefined) {
    throw new ApiError("publish_failed", "Mixtape could not be minted", 409);
  }

  const row = typedRow<PublishRow>(publishResult.rows);

  if (!row) {
    throw new ApiError("publish_failed", "Mixtape could not be minted", 409);
  }

  const currentTitle = claim.title.trim();
  const isStub =
    currentTitle === "" ||
    currentTitle === DEFAULT_MIXTAPE_TITLE ||
    currentTitle === LEGACY_MIXTAPE_TITLE;

  if (isStub) {
    await db.execute({
      args: [`Fluncle Drum & Bass Mixtape #${row.sequence_number} | ${row.log_id}`, now, id],
      sql: `update mixtapes set title = ?, updated_at = ? where id = ?`,
    });
  }

  return purgeMixtapeLogCache(await getMixtapeById(id));
}

export async function announceMixtape(
  id: string,
): Promise<{ message: string; mixtape: MixtapeDTO }> {
  const mixtape = await getMixtapeById(id);

  if (!mixtape.logId) {
    throw new ApiError(
      "mixtape_not_minted",
      "Promote the recording before announcing it to the crew",
      409,
    );
  }

  if (mixtape.status !== "published") {
    throw new ApiError(
      "mixtape_not_published",
      "Distribute a listen link before announcing the mixtape to the crew",
      409,
    );
  }

  const now = new Date().toISOString();
  const db = await getDb();
  const claim = await db.execute({
    args: [now, now, id],
    sql: `update mixtapes set announced_at = ?, updated_at = ? where id = ? and announced_at is null`,
  });

  if ((claim.rowsAffected ?? 0) === 0) {
    throw new ApiError(
      "already_announced",
      "This mixtape has already been announced to the crew",
      409,
    );
  }

  let message: string;

  try {
    message = await postMixtapeToTelegram(mixtape);
  } catch (error) {
    await db.execute({
      args: [id],
      sql: `update mixtapes set announced_at = null where id = ?`,
    });

    throw error;
  }

  return { message, mixtape: purgeMixtapeLogCache(await getMixtapeById(id)) };
}

export async function getMixtapeByLogId(logId: string): Promise<MixtapeDTO | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [logId],
    sql: `${MIXTAPE_SELECT} where m.log_id = ? and m.status = 'published' limit 1`,
  });
  const row = typedRow<MixtapeRow>(result.rows);

  return row ? hydrateMixtape(row) : undefined;
}

export async function getMixtapeForRender(logId: string): Promise<MixtapeDTO | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [logId],
    sql: `${MIXTAPE_SELECT} where m.log_id = ? and m.status in ('published', 'distributing') limit 1`,
  });
  const row = typedRow<MixtapeRow>(result.rows);

  return row ? hydrateMixtape(row) : undefined;
}

async function nextMixtapeSequence(): Promise<number> {
  const db = await getDb();
  const result = await db.execute({
    sql: `select coalesce(max(sequence_number), 0) + 1 as n
          from mixtapes where sequence_number is not null`,
  });
  const row = typedRow<{ n: number }>(result.rows);

  return Number(row?.n ?? 1);
}

export async function getMixtapeById(id: string): Promise<MixtapeDTO> {
  const db = await getDb();
  const result = await db.execute({
    args: [id],
    sql: `${MIXTAPE_SELECT} where m.id = ? limit 1`,
  });
  const row = typedRow<MixtapeRow>(result.rows);

  if (!row) {
    throw new ApiError("mixtape_not_found", "Mixtape not found", 404);
  }

  return hydrateMixtape(row);
}

export async function listMixtapes({
  hydrateMembers = false,
  includeUnpublished = false,
  limit = 54,
}: {
  hydrateMembers?: boolean;

  includeUnpublished?: boolean;
  limit?: number;
} = {}): Promise<MixtapeDTO[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [Math.min(Math.max(limit, 1), 54)],
    sql: `${MIXTAPE_SELECT}
          ${includeUnpublished ? "" : "where m.status = 'published'"}
          order by coalesce(m.added_at, m.created_at) desc, m.id desc
          limit ?`,
  });

  const rows = typedRows<MixtapeRow>(result.rows);

  return hydrateMembers
    ? Promise.all(rows.map((row) => hydrateMixtape(row)))
    : rows.map((row) => rowToMixtape(row, []));
}

export async function listCalendarMixtapes(): Promise<MixtapeDTO[]> {
  const db = await getDb();
  const result = await db.execute({
    sql: `${MIXTAPE_SELECT}
          where m.status = 'published'
          order by coalesce(m.recorded_at, m.added_at, m.created_at) asc, m.id asc
          limit 108`,
  });

  const rows = typedRows<MixtapeRow>(result.rows);

  return Promise.all(rows.map((row) => hydrateMixtape(row)));
}

const MIXTAPE_SELECT = `select
  m.id,
  m.status,
  m.log_id,
  m.sequence_number,
  m.title,
  m.duration_ms,
  m.note,
  (select url from mixtape_social_posts s
     where s.mixtape_id = m.id and s.platform = 'mixcloud' and s.status = 'published' and s.url is not null
     order by published_at desc limit 1) as mixcloud_url,
  (select url from mixtape_social_posts s
     where s.mixtape_id = m.id and s.platform = 'youtube' and s.status = 'published' and s.url is not null
     order by published_at desc limit 1) as youtube_url,
  (select url from mixtape_social_posts s
     where s.mixtape_id = m.id and s.platform = 'soundcloud' and s.status = 'published' and s.url is not null
     order by published_at desc limit 1) as soundcloud_url,
  m.added_at,
  m.announced_at,
  m.recorded_at,
  m.recording_id,
  m.published_at,
  m.set_video_at,
  m.created_at,
  m.updated_at,
  (select count(*) from mixtape_tracks mt where mt.mixtape_id = m.id) as member_count
  from mixtapes m`;

async function hydrateMixtape(row: MixtapeRow): Promise<MixtapeDTO> {
  return rowToMixtape(row, await getTracksForMixtape(row.id));
}

async function assertUnmintedMixtape(id: string): Promise<void> {
  const db = await getDb();
  const result = await db.execute({
    args: [id],
    sql: `select status, log_id from mixtapes where id = ? limit 1`,
  });
  const row = typedRow<StatusRow>(result.rows);

  if (!row) {
    throw new ApiError("mixtape_not_found", "Mixtape not found", 404);
  }

  if (row.log_id !== null) {
    throw new ApiError(
      "published_immutable",
      "Published mixtapes keep their checkpoint fixed",
      409,
    );
  }
}

function validateMixtapeInput(input: MixtapeInput): {
  durationMs?: number | null;
  note?: string | null;
  recordedAt?: string | null;
  setVideoAt?: string | null;
  soundcloudUrl?: string | null;
} {
  return {
    durationMs: optionalInteger(input.durationMs, "durationMs"),
    note: optionalText(input.note, noteMaxLength),
    recordedAt: optionalIsoDate(input.recordedAt, "recordedAt"),
    setVideoAt: optionalIsoDate(input.setVideoAt, "setVideoAt"),
    soundcloudUrl: optionalUrl(input.soundcloudUrl),
  };
}

function requireText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError("invalid_input", `${field} is required`, 400);
  }

  return value.trim().slice(0, maxLength);
}

function optionalText(value: unknown, maxLength: number): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || value === "") {
    return null;
  }

  if (typeof value !== "string") {
    throw new ApiError("invalid_input", "Expected text input", 400);
  }

  return value.trim() ? value.trim().slice(0, maxLength) : null;
}

function optionalInteger(value: unknown, field: string): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || value === "") {
    return null;
  }

  if (typeof value !== "number" && typeof value !== "string") {
    throw new ApiError("invalid_input", `${field} must be a non-negative integer`, 400);
  }

  const number = typeof value === "number" ? value : Number.parseInt(value, 10);

  if (!Number.isInteger(number) || number < 0) {
    throw new ApiError("invalid_input", `${field} must be a non-negative integer`, 400);
  }

  return number;
}

function optionalIsoDate(value: unknown, field: string): string | null | undefined {
  const text = optionalText(value, 80);

  if (text === undefined || text === null) {
    return text;
  }

  const date = new Date(text);

  if (Number.isNaN(date.getTime())) {
    throw new ApiError("invalid_date", `${field} must be a valid date`, 400);
  }

  return date.toISOString();
}

function optionalUrl(value: unknown): string | null | undefined {
  const text = optionalText(value, urlMaxLength);

  if (text === undefined || text === null) {
    return text;
  }

  try {
    const url = new URL(text);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("bad protocol");
    }
  } catch {
    throw new ApiError("invalid_url", "External links must be valid http(s) URLs", 400);
  }

  return text;
}
