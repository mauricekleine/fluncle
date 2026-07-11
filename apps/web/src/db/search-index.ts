// THE SEARCH INDEX — the FTS5 full-text index over `tracks`, and the one place its DDL
// is written down.
//
// ── WHY THIS IS NOT A DRIZZLE MIGRATION ──────────────────────────────────────────────
// Drizzle's schema DSL cannot model a virtual table or a trigger, so an FTS5 index has no
// `schema.ts` expression and therefore no generated migration — and this repo does not
// hand-write migrations (AGENTS.md; a guard hook enforces it). It does not need one. An
// FTS index is a DERIVED artifact, not schema history: every byte in it is reconstructible
// from `tracks` in a single SELECT, and dropping it loses nothing. So it is built the way
// derived artifacts are built here — an IDEMPOTENT, self-healing step folded into
// `db:migrate` (package.json), which is exactly the set of places a migration would have
// reached: the Cloudflare deploy (`deploy:cf` → `db:migrate`), every local dev boot
// (`scripts/dev.ts` → `db:migrate`), and the in-memory integration harness
// (`lib/server/integration-db.ts` calls `ensureSearchIndex` right after `migrate()`).
//
// It also sidesteps libsql#1811 — the open FTS5-inside-`db.batch()` panic — for free:
// `drizzle-kit migrate` applies a migration file through `batch()`, and these statements
// are executed one at a time.
//
// ── THE SHAPE ────────────────────────────────────────────────────────────────────────
// A STANDALONE fts5 table (its own content), not an external-content one. External content
// would require `tracks` to expose a column literally named `artists`; it stores
// `artists_json`, and denormalising a second copy of the artist list onto the universal
// music object to satisfy an index is a worse trade than the few hundred KB this costs.
//
// The FTS rowid is pinned to the `tracks` rowid, so the sync triggers delete by rowid
// (O(1)) instead of scanning the index. The join back out still goes through `track_id`
// (carried UNINDEXED), so nothing downstream depends on rowid stability.
//
// `artists_json` is indexed RAW (`["Netsky","Montell2099"]`): unicode61 treats the
// brackets, quotes and commas as separators, so the tokens that land in the index are
// exactly `netsky` / `montell2099`. Flattening it first would buy nothing.
//
// ── THE WRITE PATH ───────────────────────────────────────────────────────────────────
// The app NEVER writes to `tracks_fts` — the three triggers do, inside the same
// transaction as the `tracks` write, so the index cannot drift from the row it describes.
// The update trigger is narrowed with `UPDATE OF` so the enrichment sweeps (bpm, key,
// embedding, capture state — most of the writes this archive takes) never re-index a row
// whose text did not change.
//
// ONE TRAP, and it is a SQLite trap rather than an FTS one: `INSERT OR REPLACE INTO tracks`
// does NOT fire the delete trigger unless `recursive_triggers` is on, so a REPLACE would
// leave the old FTS row behind and index the new one beside it. Every write path in the app
// is a plain `INSERT` (publish.ts) or an `UPDATE` (track-update.ts), both of which are exact,
// and a REPLACE must never be introduced on this table. The count reconcile below is the
// backstop if one ever is.
//
// ── AND WHY IT IS SAFE TO BUILD ──────────────────────────────────────────────────────
// `tracks` holds 60 rows today, so the initial populate is a 60-row insert. This is the
// cheapest hour the index will ever cost. It is also the exact OPPOSITE of the
// `libsql_vector_idx` foot-gun (docs/local-database.md): that one wedged hosted Turso's
// write path for 20+ minutes and silently built an EMPTY index locally. FTS5 does neither
// — it was measured at ~114 ms over 100k rows in the Turso scale spike.

import { type Client } from "@libsql/client";

/** The FTS5 virtual table + the three triggers that keep it in step with `tracks`. */
const SEARCH_INDEX_DDL = [
  `create virtual table if not exists tracks_fts using fts5(
     track_id unindexed,
     title,
     artists,
     album,
     label,
     tokenize = 'unicode61 remove_diacritics 2'
   )`,
  `create trigger if not exists tracks_fts_insert after insert on tracks begin
     insert into tracks_fts (rowid, track_id, title, artists, album, label)
     values (new.rowid, new.track_id, new.title, new.artists_json, new.album, new.label);
   end`,
  `create trigger if not exists tracks_fts_delete after delete on tracks begin
     delete from tracks_fts where rowid = old.rowid;
   end`,
  `create trigger if not exists tracks_fts_update
   after update of title, artists_json, album, label on tracks begin
     delete from tracks_fts where rowid = old.rowid;
     insert into tracks_fts (rowid, track_id, title, artists, album, label)
     values (new.rowid, new.track_id, new.title, new.artists_json, new.album, new.label);
   end`,
];

/** What one `ensureSearchIndex` run did — the line the deploy log prints. */
export type SearchIndexResult = {
  /** Rows in `tracks_fts` after the run (equals the `tracks` count). */
  indexed: number;
  /** True when the run had to (re)populate the index from `tracks`. */
  rebuilt: boolean;
};

/**
 * Create the FTS5 index + its triggers if absent, then make sure its contents match
 * `tracks`. IDEMPOTENT and SELF-HEALING: on a steady-state database the counts already
 * agree and it does nothing but three `if not exists` no-ops.
 *
 * The reconcile is a count comparison, not a row diff, because the triggers make per-row
 * drift impossible — the only way the two can disagree is a rebuild that has not happened
 * yet (a fresh database, a restored snapshot, or a hand-dropped index). When they do
 * disagree, the index is emptied and repopulated in one statement from the table that is
 * the source of truth.
 */
export async function ensureSearchIndex(client: Client): Promise<SearchIndexResult> {
  for (const statement of SEARCH_INDEX_DDL) {
    await client.execute(statement);
  }

  const counts = await client.execute(
    `select (select count(*) from tracks) as tracks, (select count(*) from tracks_fts) as indexed`,
  );
  const row = counts.rows[0];
  const trackCount = Number(row?.tracks ?? 0);
  const indexedCount = Number(row?.indexed ?? 0);

  if (trackCount === indexedCount) {
    return { indexed: indexedCount, rebuilt: false };
  }

  await client.execute(`delete from tracks_fts`);
  await client.execute(
    `insert into tracks_fts (rowid, track_id, title, artists, album, label)
     select rowid, track_id, title, artists_json, album, label from tracks`,
  );

  return { indexed: trackCount, rebuilt: true };
}
