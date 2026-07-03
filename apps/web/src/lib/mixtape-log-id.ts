// The mixtape coordinate — the `F`-marked Log ID on the spine, e.g. "019.F.1A".
//
// Client-safe (no server-only deps): the sector is the day-granular `sectorDay`
// primitive shared with the finding Log ID, and the tail is a pure function of the
// mint sequence. The mint lives server-side (publishMixtape in
// lib/server/mixtapes.ts) and mints ONLY at publish — the old reserved-coordinate
// prediction (`predictedMixtapeLogId`) is deleted, so the drift bug it carried
// can't return (RFC plan→recording→mixtape §6: a plan's stable handle is the
// Galaxy-vocab slug instead).

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
