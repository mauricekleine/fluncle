// The mixtape coordinate — the `F`-marked Log ID on the spine, e.g. "019.F.1A".
//
// Client-safe (no server-only deps): the sector is the day-granular `sectorDay`
// primitive shared with the finding Log ID, and the tail is a pure function of the
// mint sequence. The mint lives server-side (publishMixtape in
// lib/server/mixtapes.ts) but reuses these same pure functions, so the coordinate
// the admin RESERVES for a draft (predictedMixtapeLogId) equals the one that gets
// minted.

import { sectorDay } from "./log-id-shared";

const MIXTAPE_LETTERS = "ABCDEF";
const maxMixtapeSequence = 54;

export function mixtapeTail(sequenceNumber: number): string {
  if (
    !Number.isInteger(sequenceNumber) ||
    sequenceNumber < 1 ||
    sequenceNumber > maxMixtapeSequence
  ) {
    throw new Error("mixtape-log-id: sequence number must be between 1 and 54");
  }

  const digit = Math.floor((sequenceNumber - 1) / MIXTAPE_LETTERS.length) + 1;
  const letter = MIXTAPE_LETTERS[(sequenceNumber - 1) % MIXTAPE_LETTERS.length];

  return `${digit}${letter}`;
}

export function mixtapeLogId(recordedAt: string, sequenceNumber: number): string {
  return `${String(sectorDay(recordedAt)).padStart(3, "0")}.F.${mixtapeTail(sequenceNumber)}`;
}

/**
 * The coordinate a still-draft mixtape will mint into — the coordinate the admin
 * RESERVES so the operator can name their Beatport playlist / USB folders /
 * Rekordbox playlist with it before recording.
 *
 * The sector date resolves the SAME way publishMixtape's mint does: the live
 * session (`plannedFor`) wins as the committed record day, then the recorded date.
 * They agree by construction, so the reserved ID equals the minted one.
 *
 * Returns `undefined` when there is no date basis (no live session AND no recorded
 * date) — the mint falls back to today, but a today-based guess would DRIFT day to
 * day, so the UI shows a "set a live session to reserve the ID" state instead of a
 * moving target. Also `undefined` once the spine is full (nextSequence past 54).
 */
export function predictedMixtapeLogId({
  nextSequence,
  plannedFor,
  recordedAt,
}: {
  nextSequence: number;
  plannedFor?: string | null;
  recordedAt?: string | null;
}): string | undefined {
  const basis = plannedFor?.trim() || recordedAt?.trim();

  if (!basis) {
    return undefined;
  }

  if (!Number.isInteger(nextSequence) || nextSequence < 1 || nextSequence > maxMixtapeSequence) {
    return undefined;
  }

  return mixtapeLogId(basis, nextSequence);
}
