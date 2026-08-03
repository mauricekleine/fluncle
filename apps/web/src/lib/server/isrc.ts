// The `has_isrc` mirror's write contract (schema.ts § `has_isrc`). The stored column mirrors
// `isrc is not null and trim(isrc) <> ''` so the anchor worklist's drain order can lead with
// anchorability as an index walk (`ANCHOR_ORDER` / `tracks_anchor_order_idx`) — a btree cannot
// key on the expression itself. A mirror is only worth having if it cannot drift, so every
// statement that assigns `isrc` must assign `has_isrc` alongside it, through one of the two
// spellings here. `isrc-mirror.test.ts` scans the server source and fails the build on a writer
// that skips both; `scripts/backfill-has-isrc.ts` reconciles history and drift on every deploy.

/**
 * THE FILL-EMPTY ASSIGNMENT — `isrc = coalesce(isrc, ?)` and its `has_isrc` mirror as ONE `SET`
 * fragment, so the pair provably cannot be written apart (the `CLEAR_EMBEDDING_SQL` shape). The
 * caller must bind the SAME candidate ISRC to BOTH placeholders, consecutively. The mirror
 * re-derives presence from the assignment's own result: `coalesce(isrc, ?)` evaluates against the
 * OLD row, so the second `coalesce` sees exactly what the column will hold, and the trailing `''`
 * arm keeps the comparison NULL-safe (both sides absent reads 0, never NULL into a NOT NULL
 * column). An empty-string legacy `isrc` wins the coalesce unchanged and honestly mirrors to 0.
 */
export const FILL_ISRC_SQL = `isrc = coalesce(isrc, ?),
              has_isrc = (trim(coalesce(isrc, ?, '')) <> '')`;

/**
 * The mirror's value for a fresh ISRC assignment — the JS twin of the SQL spelling above, for the
 * insert paths and the generic update, where the assigned value is already in hand.
 */
export function hasIsrc(isrc: null | string | undefined): 0 | 1 {
  return isrc?.trim() ? 1 : 0;
}
