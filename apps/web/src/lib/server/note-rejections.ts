import { parseArtistsJson } from "./artists";
import { getSetting, setSetting } from "./settings";
import { getDb, typedRow, typedRows } from "./db";
import { NOTE_ECHO_DEFAULTS, type NoteEcho, type NoteEchoThresholds } from "./note";
import { ApiError } from "./spotify";
import { FINDINGS_FROM } from "./tracks";
import { fillEmptyNote } from "./track-update";

const MIN_PHRASE_WORDS_KEY = "note_echo_min_phrase_words";
const MAX_OVERLAP_KEY = "note_echo_max_overlap";

function parseDial(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(raw);

  return raw !== undefined && Number.isFinite(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

export async function getNoteEchoThresholds(): Promise<NoteEchoThresholds> {
  const [phrase, overlap] = await Promise.all([
    getSetting(MIN_PHRASE_WORDS_KEY),
    getSetting(MAX_OVERLAP_KEY),
  ]);

  return {
    maxOverlap: parseDial(overlap, NOTE_ECHO_DEFAULTS.maxOverlap, 0.05, 1),
    minPhraseWords: parseDial(phrase, NOTE_ECHO_DEFAULTS.minPhraseWords, 2, 20),
  };
}

export async function setNoteEchoThresholds(
  next: Partial<NoteEchoThresholds>,
): Promise<NoteEchoThresholds> {
  if (next.minPhraseWords !== undefined) {
    if (
      !Number.isInteger(next.minPhraseWords) ||
      next.minPhraseWords < 2 ||
      next.minPhraseWords > 20
    ) {
      throw new ApiError(
        "invalid_request",
        "minPhraseWords must be a whole number between 2 and 20 (a lift is a run of words; below 2 it would catch every sentence).",
        400,
      );
    }
    await setSetting(MIN_PHRASE_WORDS_KEY, String(next.minPhraseWords));
  }

  if (next.maxOverlap !== undefined) {
    if (!Number.isFinite(next.maxOverlap) || next.maxOverlap < 0.05 || next.maxOverlap > 1) {
      throw new ApiError(
        "invalid_request",
        "maxOverlap must be between 0.05 and 1 (it is a Jaccard overlap; at 0 the gate would reject every note).",
        400,
      );
    }
    await setSetting(MAX_OVERLAP_KEY, String(next.maxOverlap));
  }

  return getNoteEchoThresholds();
}

export type NoteRejection = {
  artUrl?: string;
  artists: string[];

  attempts: number;

  createdAt: string;
  id: string;
  logId?: string;

  maxOverlap: number;

  minPhraseWords: number;

  neighborLogId?: string;

  neighborNote?: string;

  note: string;

  overlap: number;

  phrase: string;
  resolution?: "accepted" | "discarded";
  resolvedAt?: string;
  title: string;
  trackId: string;

  updatedAt: string;
};

type RejectionRow = {
  album_image_url: string | null;
  artists_json: string;
  attempts: number;
  created_at: string;
  id: string;
  log_id: string | null;
  max_overlap: number;
  min_phrase_words: number;
  neighbor_log_id: string | null;
  neighbor_note: string | null;
  note: string;
  overlap: number;
  phrase: string;
  resolution: "accepted" | "discarded" | null;
  resolved_at: string | null;
  title: string;
  track_id: string;
  updated_at: string;
};

function toRejection(row: RejectionRow, artists: string[]): NoteRejection {
  return {
    ...(row.album_image_url ? { artUrl: row.album_image_url } : {}),
    artists,
    attempts: row.attempts,
    createdAt: row.created_at,
    id: row.id,
    ...(row.log_id ? { logId: row.log_id } : {}),
    maxOverlap: row.max_overlap,
    minPhraseWords: row.min_phrase_words,
    ...(row.neighbor_log_id ? { neighborLogId: row.neighbor_log_id } : {}),
    ...(row.neighbor_note ? { neighborNote: row.neighbor_note } : {}),
    note: row.note,
    overlap: row.overlap,
    phrase: row.phrase,
    ...(row.resolution ? { resolution: row.resolution } : {}),
    ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
    title: row.title,
    trackId: row.track_id,
    updatedAt: row.updated_at,
  };
}

export async function recordNoteRejection(
  trackId: string,
  note: string,
  echo: NoteEcho,
  thresholds: NoteEchoThresholds,
): Promise<void> {
  const db = await getDb();

  const now = new Date().toISOString();

  await db.execute({
    args: [
      crypto.randomUUID(),
      trackId,
      note,
      echo.logId,
      echo.note,
      echo.phrase,
      echo.overlap,
      thresholds.minPhraseWords,
      thresholds.maxOverlap,
      now,
      now,
    ],
    sql: `insert into note_rejections
            (id, track_id, note, neighbor_log_id, neighbor_note, phrase, overlap,
             min_phrase_words, max_overlap, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict (track_id) where resolved_at is null
          do update set
            note = excluded.note,
            neighbor_log_id = excluded.neighbor_log_id,
            neighbor_note = excluded.neighbor_note,
            phrase = excluded.phrase,
            overlap = excluded.overlap,
            min_phrase_words = excluded.min_phrase_words,
            max_overlap = excluded.max_overlap,
            updated_at = excluded.updated_at,
            attempts = note_rejections.attempts + 1`,
  });
}

export async function listNoteRejections(
  options: { id?: string; open?: boolean; trackId?: string } = {},
): Promise<NoteRejection[]> {
  const { id, open = true, trackId } = options;
  const db = await getDb();

  const filters: string[] = id
    ? []
    : open
      ? [`r.resolved_at is null`, `(findings.note is null or trim(findings.note) = '')`]
      : [`r.resolved_at is not null`];
  const args: string[] = [];

  if (id) {
    filters.push(`r.id = ?`);
    args.push(id);
  }

  if (trackId) {
    filters.push(`r.track_id = ?`);
    args.push(trackId);
  }

  const result = await db.execute({
    args,
    sql: `select r.id, r.track_id, r.note, r.neighbor_log_id, r.neighbor_note, r.phrase,
                 r.overlap, r.min_phrase_words, r.max_overlap, r.attempts, r.created_at,
                 r.updated_at, r.resolution, r.resolved_at,
                 tracks.title, tracks.artists_json, tracks.album_image_url, findings.log_id
          from note_rejections r
          join (${FINDINGS_FROM}) on findings.track_id = r.track_id
          where ${filters.join(" and ")}
          order by r.created_at asc`,
  });

  return typedRows<RejectionRow>(result.rows).map((row) =>
    toRejection(row, parseArtistsJson(row.artists_json)),
  );
}

export type NoteRejectionReviewRow = {
  anchorAt: string;
  artUrl?: string;
  artists: string[];

  attempts: number;
  id: string;
  logId?: string;
  title: string;
  trackId: string;
};

export async function listNoteRejectionReviewRows(): Promise<NoteRejectionReviewRow[]> {
  const rejections = await listNoteRejections({ open: true });

  return rejections.map((rejection) => ({
    anchorAt: rejection.createdAt,
    ...(rejection.artUrl ? { artUrl: rejection.artUrl } : {}),
    artists: rejection.artists,
    attempts: rejection.attempts,
    id: rejection.id,
    ...(rejection.logId ? { logId: rejection.logId } : {}),
    title: rejection.title,
    trackId: rejection.trackId,
  }));
}

export type ResolveResult = {
  note?: string;
  rejection: NoteRejection;

  skipped: boolean;
};

export async function resolveNoteRejection(
  id: string,
  resolution: "accepted" | "discarded",
): Promise<ResolveResult> {
  const db = await getDb();
  const result = await db.execute({
    args: [id],
    sql: `select id, track_id, note, resolved_at from note_rejections where id = ? limit 1`,
  });
  const row = typedRow<{
    id: string;
    note: string;
    resolved_at: string | null;
    track_id: string;
  }>(result.rows);

  if (!row) {
    throw new ApiError("not_found", `No held note with id ${id}`, 404);
  }

  if (row.resolved_at) {
    throw new ApiError("already_resolved", "That held note has already been ruled on.", 409);
  }

  let skipped = false;
  let note: string | undefined;

  if (resolution === "accepted") {
    const filled = await fillEmptyNote(row.track_id, row.note);
    skipped = !filled;
    note = row.note;
  }

  const claimed = await db.execute({
    args: [resolution, new Date().toISOString(), id],
    sql: `update note_rejections
            set resolution = ?, resolved_at = ?
          where id = ? and resolved_at is null`,
  });

  if (claimed.rowsAffected === 0) {
    throw new ApiError("already_resolved", "That held note has already been ruled on.", 409);
  }

  const [rejection] = await listNoteRejections({ id });

  if (!rejection) {
    throw new ApiError("not_found", `No held note with id ${id}`, 404);
  }

  return {
    ...(note ? { note } : {}),
    rejection,
    skipped,
  };
}
