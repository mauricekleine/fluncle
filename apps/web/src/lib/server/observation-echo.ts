// observation-echo.ts — the anti-sameness rail for the SPOKEN observation, the written
// sibling of the note echo gate (note.ts). The observations were the worst-measured
// generated family Fluncle has and the only written family with NO rail: echoing 59/61,
// mean pairwise word overlap 0.0816, a closer that reads verbatim across a third of the
// corpus ("…enjoy cosmonauts" as the last words of 32/61) and a body-reaction lifted
// verbatim across two scripts ("my shoulders went before i'd clocked the coordinate").
// See docs/planning/homogenisation-evidence.md, the 2026-07-14 full-corpus audit.
//
// This ports the notes' PROVEN mechanism (which cut within-region overlap 0.041 → 0.015):
//   1. the AUTHOR is handed its sonic neighbours' scripts as SPENT moves (the box
//      observe-sweep's neighbour block — openers, closers, images already used nearby).
//   2. the WORKER re-reads those same neighbours and mechanically REJECTS a draft that
//      lifts a run of words from one or reuses its words wholesale, BEFORE the Cartesia
//      render spends a cent (observe_track). A rejected script is HELD in the
//      `observation_rejections` ledger, not binned.
//
// ONE DEFINITION OF "SAME". The scoring is the shared `scoreEcho` the note gate uses, over a
// `{ logId, text }` neighbourhood — so a lifted phrase means exactly the same thing whether
// the text is a one-line note or a 40-second spoken script. This module only renames the
// generic `text` to `script` and carries the observation-specific error + defaults.
//
// PURE. No DB, no I/O — the neighbourhood is read elsewhere (observation-neighbours.ts) and
// the thresholds are read from the KV elsewhere (observation-rejections.ts). This file is
// just the measure, so the corpus harness and the Worker gate share one definition.

import { type Echo, type NoteEchoThresholds, scoreEcho } from "./note";
import { ApiError } from "./spotify";

/**
 * The observation gate's two dials — the same shape as the note gate's, and calibrated to
 * the same starting values, because "a lifted phrase" and "the same words reshuffled" read
 * the same in a spoken script as in a written note. They are OPERATOR-TUNABLE at runtime
 * (their own `settings` KV keys — `getObservationEchoThresholds` in observation-rejections.ts),
 * because the observation corpus is longer prose than a note and the honest threshold will
 * move as the corpus grows; finding that out must never require a deploy.
 *
 * A four-word run with a content word ("shoulders went before i'd", "before the drop even
 * lands") is a borrowed move, not a coincidence; a content-word Jaccard at or above 0.3 is
 * the same observation wearing a new coat. The corpus mean is 0.0816, so 0.3 bites on the
 * genuine echoes and lets an honestly-different read through.
 */
export const OBSERVATION_ECHO_DEFAULTS: NoteEchoThresholds = {
  maxOverlap: 0.3,
  minPhraseWords: 4,
};

/** One neighbour script the candidate is measured against (the scripts the agent was shown). */
export type ObservationNeighbor = { logId: string; script: string };

/** The worst echo a candidate observation script makes against its sonic neighbourhood. */
export type ObservationEcho = {
  /** True when the candidate crosses either threshold — it must not be rendered. */
  echoes: boolean;
  /** The neighbour it echoes hardest (its Log ID), or null when there is nothing to echo. */
  logId: string | null;
  /** The run of words lifted from that neighbour, or "" when none reaches the threshold. */
  phrase: string;
  /** The measured content-word overlap with that neighbour (0..1). */
  overlap: number;
  /** That neighbour's script, as it read at scoring time ("" when there is nothing to echo). */
  script: string;
};

/**
 * Score a candidate observation script against its sonic neighbours' scripts — the mechanical
 * anti-sameness measurement behind the observation echo gate. Delegates to the shared
 * `scoreEcho`, then renames the generic `text` back to `script`. An empty neighbourhood (a
 * finding with no embedding yet, or the first observation in a region) scores
 * `{ echoes: false, overlap: 0 }` — nothing to echo, so nothing to gate.
 */
export function scoreObservationEcho(
  script: string,
  neighbors: readonly ObservationNeighbor[],
  thresholds: NoteEchoThresholds = OBSERVATION_ECHO_DEFAULTS,
): ObservationEcho {
  const echo: Echo = scoreEcho(
    script,
    neighbors.map((neighbor) => ({ logId: neighbor.logId, text: neighbor.script })),
    thresholds,
  );

  return {
    echoes: echo.echoes,
    logId: echo.logId,
    overlap: echo.overlap,
    phrase: echo.phrase,
    script: echo.text,
  };
}

/**
 * Hard-fail an agent-authored observation script that ECHOES its sonic neighbourhood, throwing
 * a clean ApiError the handler turns into a 422. Names the neighbour and the lifted phrase, so
 * the sweep can re-author against it (the note gate's `note_echoes_neighbours` precedent).
 *
 * The rail: the neighbour scripts INFORM the authoring — they show the region's register and
 * the moves already spent — but they must never be templated. An observation whose only read
 * echoes its neighbours stays unwritten; silence beats a generic read, and this rejects BEFORE
 * the render so a bounced draft costs nothing.
 */
export function observationEchoError(echo: ObservationEcho): ApiError {
  const detail = echo.phrase
    ? `it lifts "${echo.phrase}" straight from ${echo.logId}`
    : `it reuses ${Math.round(echo.overlap * 100)}% of ${echo.logId}'s words`;

  return new ApiError(
    "observation_echoes_neighbours",
    `The observation echoes its sonic neighbourhood: ${detail}. The neighbours inform the read, they never template it — say what is true of THIS record's arrival and nothing else. It is held for the operator's eye, not thrown away.`,
    422,
  );
}
