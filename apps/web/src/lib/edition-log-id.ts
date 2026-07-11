// The edition coordinate — the `L`-marked Log ID on the spine, e.g. "023.L.1A".
//
// A sent newsletter edition is the letter Fluncle posts back down the trail (LORE.md):
// a first-class object on the Log ID spine, sibling to the finding (a digit in the
// middle slot) and the mixtape (an `F`). Its marker is the literal `L` — the letter —
// and it can collide with neither.
//
// DERIVED, NEVER STORED. Both inputs are frozen the moment the edition goes out: the
// send mints `number` (`max(number)+1`, unique, never reused across a delete) and
// stamps `sent_at`, and a sent edition is immutable from then on (`updateEdition`
// 409s). So the coordinate is a pure function of two permanent facts — the same move
// the mixtape cover makes (derived from the Log ID, no stored column). It needs no
// column, no migration, and no backfill: every back-issue already sent is spine-native
// the moment this ships. A DRAFT has no number and no send date, so it has no
// coordinate — the coordinate IS the record of having gone out.
//
// Client-safe (no server-only deps): the sector is the day-granular `sectorDay`
// primitive shared with the finding + mixtape Log IDs.

import { isEditionLogId } from "./log-id";
import { sectorDay } from "./log-id-shared";

const EDITION_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * The cap on the mark: digit `1–9` × letter `A–Z` = 234 editions, ~4.5 years of a
 * weekly letter. Past that the alphabet or the digit range widens — a bridge to cross
 * then, exactly as the mixtape's cap-54 tail says.
 */
export const MAX_EDITION_NUMBER = 9 * EDITION_LETTERS.length;

/**
 * The mark for an edition number: `<digit><letter>` — the finding's own mark shape, so
 * the coordinate reads on-format and nothing screams. #1 → `1A`, #26 → `1Z`, #27 →
 * `2A`, … #234 → `9Z`. Human-meaningful (it counts letters), not a content hash.
 */
export function editionTail(number: number): string {
  if (!Number.isInteger(number) || number < 1 || number > MAX_EDITION_NUMBER) {
    throw new Error(`edition-log-id: number must be between 1 and ${MAX_EDITION_NUMBER}`);
  }

  const digit = Math.floor((number - 1) / EDITION_LETTERS.length) + 1;
  const letter = EDITION_LETTERS[(number - 1) % EDITION_LETTERS.length];

  return `${digit}${letter}`;
}

/**
 * An edition's coordinate: the sector-day it was sent, the `L` marker, and its number
 * as the mark. Returns undefined when either frozen fact is missing (a draft, or a
 * number past the cap) — the callers treat a coordinate-less edition as not yet on the
 * spine rather than inventing one.
 */
export function editionLogId(sentAt: string | undefined, number: number | undefined): string {
  if (sentAt === undefined || number === undefined) {
    return "";
  }

  if (!Number.isInteger(number) || number < 1 || number > MAX_EDITION_NUMBER) {
    return "";
  }

  return `${String(sectorDay(sentAt)).padStart(3, "0")}.L.${editionTail(number)}`;
}

/**
 * The inverse of the mark: a coordinate → the edition number it names, or undefined
 * when the string isn't an edition coordinate. The `/log/<id>` resolver reads the
 * number out of the mark, loads THAT edition, and then re-derives the coordinate to
 * confirm the sector agrees — so a well-shaped coordinate with the wrong sector 404s
 * instead of serving a visitor the wrong letter.
 */
export function editionNumberFromLogId(logId: string): number | undefined {
  if (!isEditionLogId(logId)) {
    return undefined;
  }

  const mark = logId.split(".")[2];
  const digit = Number.parseInt(mark?.slice(0, 1) ?? "", 10);
  const letterIndex = EDITION_LETTERS.indexOf(mark?.slice(1, 2) ?? "");

  if (!Number.isInteger(digit) || digit < 1 || letterIndex === -1) {
    return undefined;
  }

  return (digit - 1) * EDITION_LETTERS.length + letterIndex + 1;
}
