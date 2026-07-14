// THE OBSERVATION ECHO GATE'S LEDGER — the spoken sibling of note-rejections.ts. When the
// observe_track gate refuses to RENDER a script because it echoes a sonic neighbour's script,
// the script is not binned: it becomes a row here (the script, the neighbour it echoed, a
// snapshot of that neighbour's script, the lifted phrase, the score, and the thresholds in
// force) plus a row in the `/admin` attention queue. The operator reads what the model wrote
// and rules — render it anyway (`accepted`), or agree with the gate (`discarded`).
//
// Same reasoning as the note ledger: a gate whose rejections nobody can see is a gate nobody
// can supervise. The dials are tunable (the `settings` KV) precisely so that this evidence can
// change them. The gate is NOT weakened — the observe render still refuses exactly what it
// refused before; it simply no longer does it in the dark. And because the gate rejects BEFORE
// the Cartesia render, a held rejection never cost a cent.

import { parseArtistsJson } from "./artists";
import { getDb, typedRow, typedRows } from "./db";
import { type NoteEchoThresholds } from "./note";
import { OBSERVATION_ECHO_DEFAULTS, type ObservationEcho } from "./observation-echo";
import { type RenderObservationResult, renderAndStoreObservation } from "./observation-render";
import { getSetting, setSetting } from "./settings";
import { ApiError } from "./spotify";
import { FINDINGS_FROM, getTrackByIdOrLogId } from "./tracks";

// ── The tunable dials (a flip, not a deploy) ─────────────────────────────────────
//
// Their OWN KV keys, independent of the note gate's: the observation corpus is longer prose
// than a note, so the honest threshold can drift differently. Read once per gating run, so a
// retune takes effect on the very next sweep tick with no deploy. Both are bounded on read as
// well as write: a nonsense KV value degrades to the calibrated default rather than disabling
// the gate outright (maxOverlap 0 would reject every script; minPhraseWords 1 every sentence).

const MIN_PHRASE_WORDS_KEY = "observation_echo_min_phrase_words";
const MAX_OVERLAP_KEY = "observation_echo_max_overlap";

/** Parse a KV value into a finite number within bounds, else fall back to the default. */
function parseDial(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(raw);

  return raw !== undefined && Number.isFinite(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

/**
 * The observation gate's dials as they stand right now — the KV values, or the built-in
 * defaults when unset. Read once per gating run, so a retune takes effect on the next tick.
 */
export async function getObservationEchoThresholds(): Promise<NoteEchoThresholds> {
  const [phrase, overlap] = await Promise.all([
    getSetting(MIN_PHRASE_WORDS_KEY),
    getSetting(MAX_OVERLAP_KEY),
  ]);

  return {
    maxOverlap: parseDial(overlap, OBSERVATION_ECHO_DEFAULTS.maxOverlap, 0.05, 1),
    minPhraseWords: parseDial(phrase, OBSERVATION_ECHO_DEFAULTS.minPhraseWords, 2, 20),
  };
}

/**
 * Retune the observation gate. Operator-tier: this changes what the archive will and won't say
 * (out loud) about itself, so it is publish-class. Each dial is independently settable (an
 * absent field leaves it alone) and validated against the same bounds the read enforces.
 */
export async function setObservationEchoThresholds(
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
        "maxOverlap must be between 0.05 and 1 (it is a Jaccard overlap; at 0 the gate would reject every script).",
        400,
      );
    }
    await setSetting(MAX_OVERLAP_KEY, String(next.maxOverlap));
  }

  return getObservationEchoThresholds();
}

// ── The ledger ───────────────────────────────────────────────────────────────────

/** A held observation rejection, dressed with the finding it belongs to (the queue + dialog read). */
export type ObservationRejection = {
  artUrl?: string;
  artists: string[];
  /** How many times this finding's observation has bounced while this rejection stayed open. */
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
  /** That neighbour's script as it read at rejection time — the other half of the pair. */
  neighborScript?: string;
  /** The measured content-word overlap against that neighbour. */
  overlap: number;
  /** The run of words lifted from it; "" when the rejection was overlap-only. */
  phrase: string;
  resolution?: "accepted" | "discarded";
  resolvedAt?: string;
  /** THE EVIDENCE — the observation script the model wrote, verbatim. */
  script: string;
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
  neighbor_script: string | null;
  overlap: number;
  phrase: string;
  resolution: "accepted" | "discarded" | null;
  resolved_at: string | null;
  script: string;
  title: string;
  track_id: string;
  updated_at: string;
};

function toRejection(row: RejectionRow, artists: string[]): ObservationRejection {
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
    ...(row.neighbor_script ? { neighborScript: row.neighbor_script } : {}),
    overlap: row.overlap,
    phrase: row.phrase,
    ...(row.resolution ? { resolution: row.resolution } : {}),
    ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
    script: row.script,
    title: row.title,
    trackId: row.track_id,
    updatedAt: row.updated_at,
  };
}

/**
 * Hold a rejected observation script. Called by the `observe_track` handler the instant the
 * echo gate decides against a script, BEFORE the 422 goes back to the sweep — so the evidence
 * is durable even though the request fails.
 *
 * UPSERT onto the finding's one OPEN row (the partial-unique index is the conflict target): a
 * re-author that echoes again REPLACES the held script with the fresher one and bumps
 * `attempts`, rather than appending. `created_at` is deliberately NOT updated — it is the
 * attention queue's oldest-first anchor, and the sweep re-authors an observation-less finding
 * every tick, so an anchor that moved with each bounce would never age into the working set.
 *
 * Best-effort by contract: this must never convert a gate rejection into a 500.
 */
export async function recordObservationRejection(
  trackId: string,
  script: string,
  echo: ObservationEcho,
  thresholds: NoteEchoThresholds,
): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();

  await db.execute({
    args: [
      crypto.randomUUID(),
      trackId,
      script,
      echo.logId,
      echo.script,
      echo.phrase,
      echo.overlap,
      thresholds.minPhraseWords,
      thresholds.maxOverlap,
      now,
      now,
    ],
    sql: `insert into observation_rejections
            (id, track_id, script, neighbor_log_id, neighbor_script, phrase, overlap,
             min_phrase_words, max_overlap, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict (track_id) where resolved_at is null
          do update set
            script = excluded.script,
            neighbor_log_id = excluded.neighbor_log_id,
            neighbor_script = excluded.neighbor_script,
            phrase = excluded.phrase,
            overlap = excluded.overlap,
            min_phrase_words = excluded.min_phrase_words,
            max_overlap = excluded.max_overlap,
            updated_at = excluded.updated_at,
            attempts = observation_rejections.attempts + 1`,
  });
}

/**
 * Read the ledger. `open: true` (the default) is the queue's read — every rejection still
 * waiting on the operator's eye, oldest first. `open: false` reads the settled ones (the
 * retune evidence). Drives through `FINDINGS_FROM` so a decertified finding stops being read
 * and a catalogue track can never surface here.
 *
 * A HELD REJECTION IS ONLY OPEN WHILE THE FINDING IS OBSERVATION-LESS: the open read carries
 * `findings.observation_audio_url is null` as a predicate, so the moment a fresh script clears
 * the gate (or the operator renders one), the held row is MOOT and drops out — the attention
 * queue's "never surface a row the system can't confirm is actionable" rule, enforced structurally.
 */
export async function listObservationRejections(
  options: { id?: string; open?: boolean; trackId?: string } = {},
): Promise<ObservationRejection[]> {
  const { id, open = true, trackId } = options;
  const db = await getDb();
  const filters: string[] = id
    ? []
    : open
      ? [`r.resolved_at is null`, `findings.observation_audio_url is null`]
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
    sql: `select r.id, r.track_id, r.script, r.neighbor_log_id, r.neighbor_script, r.phrase,
                 r.overlap, r.min_phrase_words, r.max_overlap, r.attempts, r.created_at,
                 r.updated_at, r.resolution, r.resolved_at,
                 tracks.title, tracks.artists_json, tracks.album_image_url, findings.log_id
          from observation_rejections r
          join (${FINDINGS_FROM}) on findings.track_id = r.track_id
          where ${filters.join(" and ")}
          order by r.created_at asc`,
  });

  return typedRows<RejectionRow>(result.rows).map((row) =>
    toRejection(row, parseArtistsJson(row.artists_json)),
  );
}

/** The `AttentionSource` row shape — one open rejection, trimmed to what the queue shows. */
export type ObservationRejectionReviewRow = {
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
export async function listObservationRejectionReviewRows(): Promise<
  ObservationRejectionReviewRow[]
> {
  const rejections = await listObservationRejections({ open: true });

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

export type ResolveObservationResult = {
  rejection: ObservationRejection;
  /** The render result when `accepted` actually rendered; absent otherwise. */
  rendered?: RenderObservationResult;
  /**
   * True when `accepted` did NOT render because the finding already carried an observation (a
   * fresh script cleared the gate, or the operator rendered one, since the hold). The rejection
   * resolves anyway — the held script is moot — but the standing observation is untouched. The
   * spoken analogue of the note ledger's fill-empty-only rail.
   */
  skipped: boolean;
};

/**
 * The operator's ruling on a held observation.
 *
 * `accepted` — he read the script and it is good. It is RENDERED to the finding through the
 * shared render path (`renderAndStoreObservation`), overruling the echo gate the way a human
 * reading both scripts side by side is the higher authority. A finding that already carries an
 * observation (a fresh script cleared the gate meanwhile) is left untouched and reported
 * `skipped` — the spoken analogue of fill-empty-only, so a render is never wasted overwriting
 * a good one.
 *
 * `discarded` — the gate was right. The finding stays observation-less and queued; the next
 * sweep tick is free to author a colder script. Binning a held observation blocks nothing.
 */
export async function resolveObservationRejection(
  id: string,
  resolution: "accepted" | "discarded",
): Promise<ResolveObservationResult> {
  const db = await getDb();
  const result = await db.execute({
    args: [id],
    sql: `select id, track_id, script, resolved_at from observation_rejections where id = ? limit 1`,
  });
  const row = typedRow<{
    id: string;
    resolved_at: string | null;
    script: string;
    track_id: string;
  }>(result.rows);

  if (!row) {
    throw new ApiError("not_found", `No held observation with id ${id}`, 404);
  }

  if (row.resolved_at) {
    throw new ApiError("already_resolved", "That held observation has already been ruled on.", 409);
  }

  let skipped = false;
  let rendered: RenderObservationResult | undefined;

  if (resolution === "accepted") {
    const track = await getTrackByIdOrLogId(row.track_id);

    if (!track || !track.logId) {
      throw new ApiError("not_found", `No finding with id ${row.track_id}`, 404);
    }

    // Fill-empty-only, spoken: a fresh observation that cleared the gate (or an operator
    // render) since the hold already stands, so accepting the held script would waste a render
    // overwriting a good one. Skip it; the rejection resolves anyway (the held script is moot).
    if (track.observationAudioUrl) {
      skipped = true;
    } else {
      // The held script was authored under whatever prompt version drafted it; the ledger does
      // not store that, and this is an operator override, so the render is stamped as an
      // operator write (null provenance) — the same honest "no registry prompt wrote THIS
      // render decision" the generic update path uses.
      rendered = await renderAndStoreObservation(track, row.script, {
        durationTargetSec: 30,
        promptVersion: null,
      });
    }
  }

  // CLAIM the row (`and resolved_at is null`) so two rapid rulings can't both "win".
  const claimed = await db.execute({
    args: [resolution, new Date().toISOString(), id],
    sql: `update observation_rejections
            set resolution = ?, resolved_at = ?
          where id = ? and resolved_at is null`,
  });

  if (claimed.rowsAffected === 0) {
    throw new ApiError("already_resolved", "That held observation has already been ruled on.", 409);
  }

  const [rejection] = await listObservationRejections({ id });

  if (!rejection) {
    throw new ApiError("not_found", `No held observation with id ${id}`, 404);
  }

  return {
    rejection,
    ...(rendered ? { rendered } : {}),
    skipped,
  };
}
