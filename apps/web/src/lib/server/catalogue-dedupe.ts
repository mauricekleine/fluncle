// THE CATALOGUE DEDUPE CONTRACT — the one place two metadata acquirers converge on ONE row.
//
// Two independent paths now mint an uncertified `tracks` row for the same recording:
//   - the MusicBrainz crawl (crawl.ts) — `track_id = mb_<recording-mbid>`, the graph WALK;
//   - the MusicKit freshness tap (apple-releases.ts) — `track_id = ap_<apple-song-id>`, the
//     day-one FRESHNESS probe over enabled seed labels.
//
// Whichever lands first, the other MUST recognise it instead of minting a duplicate twin. The
// strong key is the ISRC (both carry it when the vendor has one), and that catches most cases.
// But an Apple-minted row can arrive with a MISSING or DIVERGENT ISRC (Apple and MusicBrainz
// occasionally disagree on a recording's ISRC), and then the later MB walk of the same release
// would mint an `mb_` twin. This module closes that hole with a SECOND, tighter fold: an EXACT
// title fold WITHIN the same album (`tracks.album_id`). Two pressings/paths of one recording
// share an album row (folded on the release-group MBID, or on the album-title slug when Apple has
// no release group), so an equal album_id + an equal title fold is the same track. The fold is
// deliberately TIGHT — exact, and only within one album — so a VIP/remix (a DIFFERENT title:
// "Foo VIP" folds apart from "Foo") is never merged into its original.

import { getDb, typedRows } from "./db";

/**
 * Fold a track title to a bare alphanumeric key for the same-album exact-title convergence check.
 * The `labelFold` shape (NFKD → lowercase → drop every non-alphanumeric), applied to titles: it
 * absorbs cosmetic spelling/punctuation drift ("Foo!" ⇄ "Foo") between Apple's and MusicBrainz's
 * title strings, while a VIP/remix — which carries an extra distinguishing WORD ("Foo VIP") — folds
 * to a DIFFERENT key and is never merged. Pure, so the convergence tests pin it directly.
 */
export function foldTrackTitle(title: string): string {
  return title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * Every existing track on one album, as a `foldTrackTitle(title) → track_id` map — the convergence
 * index both writers read before minting. Returns an empty map for a null album (nothing to
 * converge on) so callers need no branch. One indexed seek on `tracks.album_id`, bounded by an
 * album's tracklist (a handful of rows), never a table scan. First-seen wins per folded title (a
 * genuine same-title collision is already one logical track for this purpose).
 */
export async function existingAlbumTitleFolds(
  albumId: null | string,
): Promise<Map<string, string>> {
  if (!albumId) {
    return new Map();
  }

  const db = await getDb();
  const result = await db.execute({
    args: [albumId],
    sql: `select track_id, title from tracks where album_id = ?`,
  });

  const byFold = new Map<string, string>();

  for (const row of typedRows<{ title: null | string; track_id: string }>(result.rows)) {
    const title = typeof row.title === "string" ? row.title.trim() : "";

    if (!title) {
      continue;
    }

    const fold = foldTrackTitle(title);

    if (fold && !byFold.has(fold)) {
      byFold.set(fold, row.track_id);
    }
  }

  return byFold;
}
