// logbook-echo.ts — the anti-sameness rail for Fluncle's Logbook body, the third
// written family to get one after the notes (note.ts) and the spoken observations
// (observation-echo.ts). The logbook was measured homogenising hard on prod: three of
// eight entries titled "Shoulders Down", a shared quiet-sector opener, a shared body-clock
// formula, and the worn-through "Enjoy, cosmonauts." closer (docs/planning/
// homogenisation-evidence.md, the 07-16 + 07-18 entries).
//
// It ports the SAME proven mechanism (which cut the notes' within-region overlap
// 0.041 → 0.015):
//   1. the AUTHOR is handed the recent entries' titles + opener/closer moves as SPENT
//      (the sweep's `spent` block — every listed title/move is taken).
//   2. the WORKER re-reads the recent entries and mechanically REJECTS a draft body that
//      lifts a run of words from one or reuses its words wholesale, on the CREATE path,
//      BEFORE the entry is stored (`body_echoes_logbook`).
//
// ONE DEFINITION OF "SAME". The scoring is the shared `scoreEcho` the note + observation
// gates use, over a `{ logId, text }` neighbourhood — the logbook's "neighbour" is
// identified by its SECTOR (its natural key), mapped to the generic `logId` slot. This
// module only renames the generic `text` to `body`, keys by `sector`, and carries the
// logbook-specific error + defaults + tunable thresholds.
//
// DELIBERATELY LIGHTER THAN OBSERVATIONS: there is NO `logbook_rejections` ledger and NO
// attention source. The sweep's stay-queued behaviour (the day stays in the gap list and
// is re-authored next tick) IS the ledger here — a rejected body is simply not stored, the
// day stays a gap, and the next tick tries again with the spent moves in hand.

import { type Echo, type NoteEchoThresholds, scoreEcho } from "./note";
import { getSetting } from "./settings";
import { ApiError } from "./spotify";

/**
 * The logbook gate's two dials — the same shape + starting values as the note/observation
 * gates, because "a lifted phrase" and "the same words reshuffled" read the same in a
 * long-form travelogue as in a one-line note. A four-word run with a content word is a
 * borrowed move; a content-word Jaccard at or above 0.3 is the same entry wearing a new
 * coat. They are OPERATOR-TUNABLE at runtime (the `settings` KV keys below), because the
 * honest threshold moves as the logbook grows and finding that out must never need a deploy.
 */
export const LOGBOOK_ECHO_DEFAULTS: NoteEchoThresholds = {
  maxOverlap: 0.3,
  minPhraseWords: 4,
};

const MIN_PHRASE_WORDS_KEY = "logbook_echo_min_phrase_words";
const MAX_OVERLAP_KEY = "logbook_echo_max_overlap";

/** Parse a KV value into a finite number within bounds, else fall back to the default. */
function parseDial(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(raw);

  return raw !== undefined && Number.isFinite(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

/**
 * The logbook gate's dials as they stand right now — the KV values, or the built-in
 * defaults when unset. Read once per gating run, so a retune takes effect on the very next
 * sweep tick with no deploy. Both are BOUNDED on read as well: a nonsense KV value degrades
 * to the calibrated default rather than disabling the gate outright (maxOverlap 0 would
 * reject every body; minPhraseWords 1 every sentence), so the gate fails toward its
 * defaults, never open and never shut.
 */
export async function getLogbookEchoThresholds(): Promise<NoteEchoThresholds> {
  const [phrase, overlap] = await Promise.all([
    getSetting(MIN_PHRASE_WORDS_KEY),
    getSetting(MAX_OVERLAP_KEY),
  ]);

  return {
    maxOverlap: parseDial(overlap, LOGBOOK_ECHO_DEFAULTS.maxOverlap, 0.05, 1),
    minPhraseWords: parseDial(phrase, LOGBOOK_ECHO_DEFAULTS.minPhraseWords, 2, 20),
  };
}

/** One neighbour entry the candidate body is measured against (a recent OTHER entry). */
export type LogbookEchoNeighbor = { body: string; sector: number };

/** The worst echo a candidate logbook body makes against the recent logbook. */
export type LogbookEcho = {
  /** That neighbour's body, as it read at scoring time ("" when there is nothing to echo). */
  body: string;
  /** True when the candidate crosses either threshold — it must not be stored. */
  echoes: boolean;
  /** The measured content-word overlap with that neighbour (0..1). */
  overlap: number;
  /** The run of words lifted from that neighbour, or "" when none reaches the threshold. */
  phrase: string;
  /** The sector it echoes hardest, or null when there is nothing to echo. */
  sector: number | null;
};

/**
 * Score a candidate logbook body against the recent OTHER entries' bodies — the mechanical
 * anti-sameness measurement behind the logbook echo gate. Delegates to the shared
 * `scoreEcho` (the sector rides the generic `logId` slot), then renames `text` → `body`
 * and `logId` → `sector`. An empty neighbourhood (the first entry, or a fresh logbook)
 * scores `{ echoes: false, overlap: 0 }` — nothing to echo, so nothing to gate.
 */
export function scoreLogbookEcho(
  body: string,
  neighbors: readonly LogbookEchoNeighbor[],
  thresholds: NoteEchoThresholds = LOGBOOK_ECHO_DEFAULTS,
): LogbookEcho {
  const echo: Echo = scoreEcho(
    body,
    neighbors.map((neighbor) => ({ logId: String(neighbor.sector), text: neighbor.body })),
    thresholds,
  );

  return {
    body: echo.text,
    echoes: echo.echoes,
    overlap: echo.overlap,
    phrase: echo.phrase,
    sector: echo.logId === null ? null : Number(echo.logId),
  };
}

/**
 * Hard-fail a logbook body that ECHOES the recent logbook, throwing a clean ApiError the
 * handler turns into a 422. Names the sector + the lifted phrase in the SAME `it lifts "…"`
 * shape the note/observation gates use, so the sweep's `readEchoedMove` parses it for the
 * one re-author pass (the `note_echoes_neighbours` precedent).
 *
 * The rail: the recent entries INFORM the authoring — they show what is already spent — but
 * they must never be re-used. A day whose only body echoes the logbook stays a gap and is
 * re-authored next tick; silence beats a body that reads like every other day.
 */
export function logbookBodyEchoError(echo: LogbookEcho): ApiError {
  const detail = echo.phrase
    ? `it lifts "${echo.phrase}" straight from sector ${echo.sector}`
    : `it reuses ${Math.round(echo.overlap * 100)}% of sector ${echo.sector}'s words`;

  return new ApiError(
    "body_echoes_logbook",
    `The entry echoes the recent logbook: ${detail}. The past entries show what is already spent, they never template a new day — write what was true of THIS day and no other.`,
    422,
  );
}
