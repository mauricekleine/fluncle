// THE ECHO GATE'S LEDGER — the reads and writes behind "a rejected note is held, not
// binned".
//
// The echo gate (`gateNoteEcho`, note.ts) refuses to STORE an auto-note that lifts a
// phrase from a sonic neighbour or reuses its words wholesale. That refusal is correct
// and unchanged. What was wrong was that the refusal was SILENT: the line the model wrote
// went straight to /dev/null, so the operator could not read what was binned, could not
// judge whether it was genuinely worse than nothing, and could not tell a well-set
// threshold from a wrong one — the evidence that would settle it was the very thing being
// destroyed. A pipeline that throws work away without telling anyone is not one anybody
// can supervise.
//
// So the rejection becomes an OBJECT: a row here (the note, the neighbour it echoed, a
// snapshot of that neighbour's note, the lifted phrase, the score, and the thresholds in
// force), and a row in the `/admin` attention queue. The operator reads it and rules —
// keep it, edit it, or bin it.
//
// THE FILL-EMPTY-ONLY RAIL SURVIVES INTACT. Accepting a held note writes it through
// `fillEmptyNote` — the same atomic `and (note is null or trim(note) = '')` DB predicate
// the agent's own write goes through — so an operator note that landed in the meantime is
// never clobbered, and a held note can never overwrite anything. A held rejection likewise
// never BLOCKS a future good draft: the finding stays in the note queue (`hasNote=false`),
// the sweep keeps trying, and a fresh line that clears the gate simply fills the note and
// resolves nothing. The ledger observes the pipeline; it never gates it.

import { parseArtistsJson } from "./artists";
import { getSetting, setSetting } from "./settings";
import { getDb, typedRow, typedRows } from "./db";
import { NOTE_ECHO_DEFAULTS, type NoteEcho, type NoteEchoThresholds } from "./note";
import { ApiError } from "./spotify";
import { FINDINGS_FROM } from "./tracks";
import { fillEmptyNote } from "./track-update";

// ── The tunable dials (a flip, not a deploy) ─────────────────────────────────────
//
// The thresholds live in the `settings` KV — the house's one flag store, whose whole
// reason for existing is that an automation's behaviour must be changeable without a
// build and a Cloudflare rebuild. #502 calibrated them against a 61-note archive; that
// number is a measurement, not a law, and the corpus it was taken from is growing. When
// the operator reads a run of rejections and concludes the gate is too tight, he must be
// able to act on that in one move.

const MIN_PHRASE_WORDS_KEY = "note_echo_min_phrase_words";
const MAX_OVERLAP_KEY = "note_echo_max_overlap";

/** Parse a KV value into a finite number within bounds, else fall back to the default. */
function parseDial(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(raw);

  return raw !== undefined && Number.isFinite(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

/**
 * The gate's dials as they stand right now — the KV values, or the built-in defaults when
 * unset. Read once per gating run, so a retune takes effect on the very next sweep tick
 * with no deploy.
 *
 * Both are BOUNDED on read as well as on write: a nonsense value in the KV (hand-edited,
 * or a botched write) degrades to the default rather than disabling the gate outright. A
 * `maxOverlap` of 0 would reject every note; a `minPhraseWords` of 1 would reject every
 * sentence sharing a word. The gate must fail toward its calibrated defaults, never open
 * and never shut.
 */
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

/**
 * Retune the gate. Operator-tier: this changes what the archive will and won't say about
 * itself, so it is publish-class in the same way naming a galaxy is. Each dial is
 * independently settable (an absent field leaves that dial alone) and validated against
 * the same bounds the read enforces.
 */
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

// ── The ledger ───────────────────────────────────────────────────────────────────

/** A held rejection, dressed with the finding it belongs to (the queue + dialog read). */
export type NoteRejection = {
  /** Cover art for the queue row / dialog. */
  artUrl?: string;
  artists: string[];
  /** How many times this finding's note has bounced while this rejection stayed open. */
  attempts: number;
  /** The FIRST hold — the queue's oldest-first anchor. Never moves on a re-bounce. */
  createdAt: string;
  id: string;
  logId?: string;
  /** The overlap threshold in force when it was rejected (NOT necessarily today's). */
  maxOverlap: number;
  /** The lifted-phrase threshold in force when it was rejected. */
  minPhraseWords: number;
  /** The neighbour it echoed hardest. */
  neighborLogId?: string;
  /** That neighbour's note as it read at rejection time — the other half of the pair. */
  neighborNote?: string;
  /** THE EVIDENCE — the note the model wrote, verbatim. */
  note: string;
  /** The measured content-word overlap against that neighbour. */
  overlap: number;
  /** The run of words lifted from it; "" when the rejection was overlap-only. */
  phrase: string;
  resolution?: "accepted" | "discarded";
  resolvedAt?: string;
  title: string;
  trackId: string;
  /** The LATEST bounce — the diagnostic, never the anchor. */
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

/**
 * Hold a rejected note. Called by the `note_track` handler the instant the echo gate
 * decides against a line, BEFORE the 422 goes back to the sweep — so the evidence is
 * durable even though the request fails.
 *
 * UPSERT onto the finding's one OPEN row (the `note_rejections_open_track_idx` partial
 * unique index is the conflict target): a re-author that echoes again REPLACES the held
 * note with the fresher one and bumps `attempts`, rather than appending. The sweep
 * re-authors once per tick and a note-less finding stays queued forever, so appending
 * would let one stubborn finding write hundreds of rows a day and raise hundreds of queue
 * rows. Bounded by the archive, not by the cron.
 *
 * Best-effort by contract: this must never convert a gate rejection into a 500. If the
 * ledger write fails, the gate still rejects (the note still doesn't get stored) — we lose
 * the evidence for that one bounce, not the safety property.
 */
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
    // NOTE the omission: `created_at` is deliberately NOT updated. It is the attention
    // queue's oldest-first anchor, and the sweep re-authors a note-less finding every tick —
    // so a `created_at` that moved with each bounce would reset the row's age on every
    // failure, and the row would NEVER age into the operator's bounded working set. The
    // finding that keeps failing is precisely the one he most needs to look at; anchoring on
    // its last failure would bury it the deepest. First-hold wins.
  });
}

/**
 * Read the ledger. `open: true` (the default) is the queue's read — every rejection still
 * waiting on the operator's eye, oldest first, so it ages like every other queue row.
 * `open: false` reads the settled ones (the retune evidence: what he kept, what he binned).
 *
 * Drives through `FINDINGS_FROM` — an INNER join onto the certification layer — so a row
 * whose finding was somehow decertified simply stops being read, and a catalogue track can
 * never surface here even if a row for one existed.
 *
 * A HELD NOTE IS ONLY OPEN WHILE THE FINDING IS NOTE-LESS. The ledger never gates the
 * pipeline: while a rejection sits held, the sweep keeps re-authoring, and a fresh line that
 * clears the gate fills the note normally. The moment that happens — or the moment the
 * operator types his own note — the held line is MOOT: there is nothing left to rule on,
 * because a note already stands and fill-empty-only means it can never be replaced by the
 * held one anyway.
 *
 * So the open read carries the finding's note-emptiness as a PREDICATE rather than trusting
 * a write path to come back and tidy up. That is the attention queue's trust rule ("never
 * surface a row the system can't confirm is actionable") enforced structurally: the row
 * cannot go stale, whichever path filled the note — the agent's, the operator's, or a hand
 * edit in the database.
 */
export async function listNoteRejections(
  options: { id?: string; open?: boolean; trackId?: string } = {},
): Promise<NoteRejection[]> {
  const { id, open = true, trackId } = options;
  const db = await getDb();
  // `id` addresses one exact row, so it is the whole predicate — an id lookup must not
  // also have to guess whether the row it wants is open or settled.
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

/** The `AttentionSource` row shape — one open rejection, trimmed to what the queue shows. */
export type NoteRejectionReviewRow = {
  /** The oldest-first anchor — the FIRST hold, so a re-bouncing row still ages in. */
  anchorAt: string;
  artUrl?: string;
  artists: string[];
  /** How many times it has bounced — the datum that says "this one is stuck". */
  attempts: number;
  id: string;
  logId?: string;
  title: string;
  trackId: string;
};

/** Every held rejection awaiting the operator's ruling — the attention queue's source read. */
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
  /** The finding's note after the ruling (the accepted line, or whatever already stood). */
  note?: string;
  rejection: NoteRejection;
  /**
   * True when `accepted` did NOT write, because the finding already carried a note (the
   * operator hand-wrote one in the meantime). The rejection is still resolved — the held
   * line is moot — but the standing note is untouched. The fill-empty-only rail, observable.
   */
  skipped: boolean;
};

/**
 * The operator's ruling on a held note.
 *
 * `accepted` — he read it and it is good. The line is written to the finding through
 * `fillEmptyNote`: the SAME atomic fill-empty-only predicate the agent's own write uses,
 * so a note that landed since the rejection cannot be clobbered. If it was, we report
 * `skipped` and resolve the rejection anyway (the held line is moot — the finding has a
 * note). Deliberately, the accepted line is NOT re-run through the echo gate: the gate's
 * verdict is exactly what he is overruling, and a human reading both notes side by side is
 * the higher authority. It IS still the operator's own note from that moment on, and the
 * agent will never touch it again (fill-empty-only).
 *
 * `discarded` — the gate was right. The finding stays note-less and in the queue; the next
 * sweep tick is free to author a better line, which will fill the note normally. Binning a
 * held note blocks nothing.
 */
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
    // The fill-empty-only rail — the agent's write and the operator's acceptance of the
    // agent's write go through the same atomic predicate. A `false` here means an operator
    // note landed since the gate rejected this one; it stands, and we never clobber it.
    const filled = await fillEmptyNote(row.track_id, row.note);
    skipped = !filled;
    note = row.note;
  }

  // CLAIM the row (`and resolved_at is null`) so two rapid rulings can't both "win" and
  // double-report — the same claim shape the submissions queue uses.
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
