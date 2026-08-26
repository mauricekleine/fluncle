// The global string→string KV (the `settings` table) — the ONE store for any value that has
// to change without a deploy. That requirement is what the store is FOR: an automation that
// misbehaves at 3am must be stoppable from the admin UI or the CLI in one move, with no
// build, no push, no Cloudflare rebuild. So each value is a single row here, read by its own
// caller's tick before it does anything.
//
// THE INVARIANT EVERY READER OWES THE STORE: a row can be absent (a fresh deploy, a preview
// branch, a wiped KV) or hold a value nothing here validates on write — `setSetting` takes
// any string. So a read MUST degrade, never throw: parse into a bounded default, or treat
// the row as cold and recompute. Concretely — a flag's unset state is its documented
// default; a budget or a dial that fails to parse falls back to the calibrated constant
// (smaller budget, never "unlimited"); a JSON cache that will not parse is a MISS that falls
// through to the live read. No reader may make a `settings` row load-bearing for
// correctness, because nothing guarantees the row is there or well-formed. Shape (7) below is
// the ONE argued exception, and it states its own reason.
//
// WHAT RIDES IT TODAY — 38 keys across 17 modules, in seven shapes (grep `getSetting(` for the
// live list; each module owns its own exported key constant and its own default):
//
//   1. OPERATOR FLIPS — `"true"`/`"false"`, and the unset state is the deliberate default
//      (some default-deny, some default-allow; each module's comment states which):
//      `clip_drip_paused` (./clip-social.ts), `publish_advance_paused` (./publish-advance.ts),
//      `catalogue_capture_paused` (./capture-budget.ts), `anchor_apify_enabled`
//      (./anchor-apify.ts), `anchor_spotify_search_enabled` (./anchor-spotify-search.ts),
//      `frontier.minting` (./frontier-playlist.ts).
//   2. THE SIX SONAR DARK FLAGS (./sonar.ts) — `sonar_sonic_enabled`, `sonar_artists_enabled`,
//      `sonar_log_enabled`, `sonar_recs_enabled`, `sonar_recs_catalogue_enabled`,
//      `sonar_mix_enabled`. Same shape as (1), all DEFAULT-DENY, one per surface: this is how
//      the vector sidecar ships dark and is lit surface by surface (docs/vector-serving.md).
//   3. BUDGETS — a non-negative integer as a string: `catalogue_capture_daily_tracks` /
//      `catalogue_capture_daily_bytes`, the capture budget's rolling-24h caps
//      (./capture-budget.ts). Unset or malformed ⇒ the conservative DEFAULT.
//   4. VOICE-GATE DIALS — a bounded number, retunable between sweep ticks:
//      `{logbook,note,observation}_echo_min_phrase_words` / `…_max_overlap`
//      (./logbook-echo.ts, ./note-rejections.ts, ./observation-rejections.ts). Out-of-bounds
//      or nonsense degrades to the calibrated default, so the gate fails toward its defaults
//      rather than open or shut.
//   5. RUNTIME STATE the code itself writes (not operator dials) — the rolling rate-limit
//      windows `spotify_calls_window_start` / `…_count` (./spotify-budget.ts) and
//      `apple_calls_window_start` / `…_count`, the circuit breaker's
//      `apple_auth_breaker_tripped_at` / `apple_auth_breaker_failures` (./apple-breaker.ts),
//      the Spotify anchor breaker's `spotify_anchor_breaker_tripped_at` /
//      `…_failures` / `…_reason` / `…_last_failure_at` (./spotify-anchor-breaker.ts),
//      the `anchor_apify_disabled_at` trip marker (./anchor-apify.ts), and the two telescope
//      pointers `telescope.spotify_playlist_id` / `telescope.last_mirror`
//      (./telescope-playlist.ts).
//   6. JSON CACHES — `catalogue_summary_cache`, `catalogue_affinity_cache`, and
//      `catalogue_rank_state_cache` (./catalogue.ts),
//      the one shape that is not a scalar. BLESSED, and the invariant above is exactly why it
//      is safe: both are precomputed reads whose cache is an OPTIMISATION, never the truth.
//      The summary's six counts are maintained as ±1 deltas and a cold or unparseable row
//      makes the delta a NO-OP (the next read cold-fills from one authoritative scan, and the
//      rank sweep's recompute heals any drift); the affinity cache is display-only and a
//      cold/corrupt row falls back to the live `readArchiveAffinity`. Every
//      authorization-critical caller reads live, never the cache. A future cache belongs here
//      only on the same terms: parse-or-recompute, and never the source of truth.
//
//   7. THE ONE SECURITY COUNTER, and the ONE documented exception to the invariant above:
//      `admin_grant_epoch` (./env.ts, `ADMIN_GRANT_EPOCH_KEY`) — the revocation handle for
//      the stateless admin grant cookie. Every grant bakes the epoch it was minted under;
//      bumping this integer (`fluncle admin auth revoke-grants`) makes every outstanding
//      browser session stop verifying at once, with no deploy and no secret rotation. It
//      belongs here for exactly the store's reason: cutting a leaked session must be a flip.
//      Its ABSENT state degrades as the invariant demands (unset ⇒ epoch 0 ⇒ the pre-epoch
//      behaviour). But a read that FAILS or a value that will not parse **refuses the
//      cookie** rather than falling back — a revocation that fails open is not a revocation,
//      so this one reader is deliberately load-bearing on the unhappy path. The cost is
//      bounded and recoverable: a DB blip 401s the browser board (a reload fixes it once the
//      DB is back — the cookie is not cleared), the Bearer carriers are never epoch-scoped,
//      and a malformed value is repaired by the revoke op itself. A NEW key does not inherit
//      this exception; it needs the same explicit argument.
//
// Reuse these three functions for the next one; never invent a second flag store.

import { getDb, typedRow } from "./db";

/** Read a global flag from the `settings` KV, or undefined if unset. */
export async function getSetting(key: string): Promise<string | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [key],
    sql: `select value from settings where key = ? limit 1`,
  });

  return typedRow<{ value: string }>(result.rows)?.value;
}

/** Upsert a global flag into the `settings` KV. */
export async function setSetting(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.execute({
    args: [key, value, value],
    sql: `insert into settings (key, value) values (?, ?)
          on conflict(key) do update set value = ?`,
  });
}

/** Remove a global flag from the `settings` KV — a no-op when the key is already unset. */
export async function deleteSetting(key: string): Promise<void> {
  const db = await getDb();
  await db.execute({
    args: [key],
    sql: `delete from settings where key = ?`,
  });
}
