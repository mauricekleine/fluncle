import { randomUUID } from "node:crypto";
import {
  hasExternalUrl,
  type MixtapeDTO,
  type MixtapeExternalUrls,
  type MixtapeStatus,
  rowToMixtape,
} from "../mixtapes";
import { getDb, typedRow, typedRows } from "./db";
import { mixtapeLogId } from "./mixtape-log-id";
import { ApiError } from "./spotify";
import { getTrackByIdOrLogId, getTracksForMixtape } from "./tracks";

const titleMaxLength = 160;
const noteMaxLength = 1_200;
const urlMaxLength = 500;

type MixtapeRow = {
  added_at: string | null;
  cover_image_url: string | null;
  created_at: string;
  duration_ms: number | null;
  id: string;
  log_id: string | null;
  member_count: number | null;
  mixcloud_url: string | null;
  note: string | null;
  published_at: string | null;
  recorded_at: string | null;
  sequence_number: number | null;
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
  status: MixtapeStatus;
};

export type MixtapeInput = {
  coverImageUrl?: unknown;
  durationMs?: unknown;
  mixcloudUrl?: unknown;
  note?: unknown;
  recordedAt?: unknown;
  soundcloudUrl?: unknown;
  title?: unknown;
  youtubeUrl?: unknown;
};

export type MixtapeMemberInput = {
  members?: unknown;
};

export async function createMixtape(input: MixtapeInput): Promise<MixtapeDTO> {
  const fields = validateMixtapeInput(input, { requireTitle: true });
  const now = new Date().toISOString();
  const id = randomUUID();
  const db = await getDb();

  await db.execute({
    args: [
      id,
      "draft",
      fields.title as string,
      fields.coverImageUrl ?? null,
      fields.durationMs ?? null,
      fields.note ?? null,
      fields.mixcloudUrl ?? null,
      fields.youtubeUrl ?? null,
      fields.soundcloudUrl ?? null,
      fields.recordedAt ?? null,
      now,
      now,
    ],
    sql: `insert into mixtapes (
        id, status, title, cover_image_url, duration_ms, note,
        mixcloud_url, youtube_url, soundcloud_url, recorded_at, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  });

  return getMixtapeById(id, { includeDrafts: true });
}

export async function updateMixtape(id: string, input: MixtapeInput): Promise<MixtapeDTO> {
  // A published mixtape stays editable — title, note, cover, and the external links
  // can change over time — but its minted coordinate freezes two things: the recorded
  // date the sector was derived from, and the rule that it always keeps somewhere to
  // listen. Drafts have no such limits. (Members stay draft-only; see setMixtapeMembers.)
  const current = await getMixtapeById(id, { includeDrafts: true });
  const fields = validateMixtapeInput(input, { requireTitle: false });

  if (current.status === "published") {
    if (fields.recordedAt !== undefined) {
      throw new ApiError(
        "recorded_at_immutable",
        "The recorded date is locked once a mixtape is published",
        409,
      );
    }

    const nextUrls: MixtapeExternalUrls = {
      mixcloud: resolveUrlUpdate(fields.mixcloudUrl, current.externalUrls.mixcloud),
      soundcloud: resolveUrlUpdate(fields.soundcloudUrl, current.externalUrls.soundcloud),
      youtube: resolveUrlUpdate(fields.youtubeUrl, current.externalUrls.youtube),
    };

    if (!hasExternalUrl(nextUrls)) {
      throw new ApiError(
        "missing_external_url",
        "A published mixtape must keep at least one Mixcloud, YouTube, or SoundCloud link",
        409,
      );
    }
  }

  const sets: string[] = [];
  const args: Array<number | string | null> = [];

  for (const [column, value] of [
    ["title", fields.title],
    ["cover_image_url", fields.coverImageUrl],
    ["duration_ms", fields.durationMs],
    ["note", fields.note],
    ["mixcloud_url", fields.mixcloudUrl],
    ["youtube_url", fields.youtubeUrl],
    ["soundcloud_url", fields.soundcloudUrl],
    ["recorded_at", fields.recordedAt],
  ] as const) {
    if (value !== undefined) {
      sets.push(`${column} = ?`);
      args.push(value ?? null);
    }
  }

  if (sets.length === 0) {
    throw new ApiError("no_fields", "No updatable fields provided", 400);
  }

  sets.push("updated_at = ?");
  args.push(new Date().toISOString(), id);

  const db = await getDb();
  await db.execute({
    args,
    sql: `update mixtapes set ${sets.join(", ")} where id = ?`,
  });

  return getMixtapeById(id, { includeDrafts: true });
}

// undefined means the field was not part of this update (keep the current value); a
// string or null is the new value (null clears the link). Used to confirm a published
// mixtape never loses its last listenable link.
function resolveUrlUpdate(
  update: string | null | undefined,
  current: string | undefined,
): string | undefined {
  if (update === undefined) {
    return current;
  }

  return update ?? undefined;
}

export async function setMixtapeMembers(
  id: string,
  input: MixtapeMemberInput,
): Promise<MixtapeDTO> {
  await assertDraftMixtape(id);

  if (!Array.isArray(input.members) || input.members.length === 0) {
    throw new ApiError("invalid_members", "Add at least one finding to the mixtape", 400);
  }

  const seen = new Set<string>();
  const trackIds: string[] = [];

  for (const raw of input.members) {
    const value = requireText(raw, "member", 80);
    const track = await getTrackByIdOrLogId(value);

    if (!track) {
      throw new ApiError("member_not_found", `No finding with id ${value}`, 400);
    }

    if (seen.has(track.trackId)) {
      throw new ApiError("duplicate_member", "A finding can only appear once", 400);
    }

    seen.add(track.trackId);
    trackIds.push(track.trackId);
  }

  const db = await getDb();
  await db.batch(
    [
      { args: [id], sql: `delete from mixtape_tracks where mixtape_id = ?` },
      ...trackIds.map((trackId, index) => ({
        args: [id, trackId, index + 1],
        sql: `insert into mixtape_tracks (mixtape_id, track_id, position) values (?, ?, ?)`,
      })),
      {
        args: [new Date().toISOString(), id],
        sql: `update mixtapes set updated_at = ? where id = ?`,
      },
    ],
    "write",
  );

  return getMixtapeById(id, { includeDrafts: true });
}

export async function publishMixtape(id: string): Promise<MixtapeDTO> {
  const draft = await getMixtapeById(id, { includeDrafts: true });

  if (draft.status === "published") {
    throw new ApiError("already_published", "Published mixtapes keep their coordinate", 409);
  }

  if (!hasExternalUrl(draft.externalUrls)) {
    throw new ApiError(
      "missing_external_url",
      "Publishing needs a Mixcloud, YouTube, or SoundCloud link",
      409,
    );
  }

  const recordedAt = draft.recordedAt ?? new Date().toISOString();
  const sectorPrefix = mixtapeLogId(recordedAt, 1).slice(0, -2);
  const now = new Date().toISOString();
  const db = await getDb();
  const [publishResult] = await db.batch(
    [
      {
        args: [sectorPrefix, now, recordedAt, now, now, id],
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
                status = 'published',
                published_at = ?,
                recorded_at = ?,
                added_at = ?,
                updated_at = ?
              where id = ?
                and status = 'draft'
                and (select n from next_sequence) <= 54
              returning log_id, sequence_number`,
      },
    ],
    "write",
  );
  const row = typedRow<PublishRow>(publishResult.rows);

  if (!row) {
    throw new ApiError("publish_failed", "Mixtape could not be published", 409);
  }

  const published = await getMixtapeByLogId(row.log_id);

  if (!published) {
    throw new ApiError("publish_failed", "Published mixtape could not be read", 500);
  }

  return published;
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

export async function getMixtapeById(
  id: string,
  options: { includeDrafts?: boolean } = {},
): Promise<MixtapeDTO> {
  const db = await getDb();
  const result = await db.execute({
    args: [id],
    sql: `${MIXTAPE_SELECT} where m.id = ? ${options.includeDrafts ? "" : "and m.status = 'published'"} limit 1`,
  });
  const row = typedRow<MixtapeRow>(result.rows);

  if (!row) {
    throw new ApiError("mixtape_not_found", "Mixtape not found", 404);
  }

  return hydrateMixtape(row);
}

export async function listMixtapes({
  hydrateMembers = false,
  includeDrafts = false,
  limit = 54,
}: {
  hydrateMembers?: boolean;
  includeDrafts?: boolean;
  limit?: number;
} = {}): Promise<MixtapeDTO[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [Math.min(Math.max(limit, 1), 54)],
    sql: `${MIXTAPE_SELECT}
          ${includeDrafts ? "" : "where m.status = 'published'"}
          order by coalesce(m.added_at, m.created_at) desc, m.id desc
          limit ?`,
  });

  const rows = typedRows<MixtapeRow>(result.rows);

  return hydrateMembers
    ? Promise.all(rows.map(hydrateMixtape))
    : rows.map((row) => rowToMixtape(row));
}

const MIXTAPE_SELECT = `select
  m.id,
  m.status,
  m.log_id,
  m.sequence_number,
  m.title,
  m.cover_image_url,
  m.duration_ms,
  m.note,
  m.mixcloud_url,
  m.youtube_url,
  m.soundcloud_url,
  m.added_at,
  m.recorded_at,
  m.published_at,
  m.created_at,
  m.updated_at,
  (select count(*) from mixtape_tracks mt where mt.mixtape_id = m.id) as member_count
  from mixtapes m`;

async function hydrateMixtape(row: MixtapeRow): Promise<MixtapeDTO> {
  return rowToMixtape(row, await getTracksForMixtape(row.id));
}

async function assertDraftMixtape(id: string): Promise<void> {
  const db = await getDb();
  const result = await db.execute({
    args: [id],
    sql: `select status from mixtapes where id = ? limit 1`,
  });
  const row = typedRow<StatusRow>(result.rows);

  if (!row) {
    throw new ApiError("mixtape_not_found", "Mixtape not found", 404);
  }

  if (row.status !== "draft") {
    throw new ApiError(
      "published_immutable",
      "Published mixtapes keep their checkpoint fixed",
      409,
    );
  }
}

function validateMixtapeInput(
  input: MixtapeInput,
  options: { requireTitle: boolean },
): {
  coverImageUrl?: string | null;
  durationMs?: number | null;
  mixcloudUrl?: string | null;
  note?: string | null;
  recordedAt?: string | null;
  soundcloudUrl?: string | null;
  title?: string;
  youtubeUrl?: string | null;
} {
  return {
    coverImageUrl: optionalUrl(input.coverImageUrl),
    durationMs: optionalInteger(input.durationMs, "durationMs"),
    mixcloudUrl: optionalUrl(input.mixcloudUrl),
    note: optionalText(input.note, noteMaxLength),
    recordedAt: optionalIsoDate(input.recordedAt),
    soundcloudUrl: optionalUrl(input.soundcloudUrl),
    title: options.requireTitle
      ? requireText(input.title, "title", titleMaxLength)
      : (optionalText(input.title, titleMaxLength) ?? undefined),
    youtubeUrl: optionalUrl(input.youtubeUrl),
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

function optionalIsoDate(value: unknown): string | null | undefined {
  const text = optionalText(value, 80);

  if (text === undefined || text === null) {
    return text;
  }

  const date = new Date(text);

  if (Number.isNaN(date.getTime())) {
    throw new ApiError("invalid_date", "recordedAt must be a valid date", 400);
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
