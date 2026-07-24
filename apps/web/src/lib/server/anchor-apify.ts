// THE APIFY-FALLBACK KILL-FLAG — the operator switch that turns "out of Apify budget" from a STALL
// into a clean, self-managing state (anchor slice 3).
//
// ── THE STALL THIS FIXES ─────────────────────────────────────────────────────────────────────────
// The anchor waterfall (lib/server/anchor.ts) resolves a crawled `tracks` row to a Spotify id through
// FREE rungs (Deezer ISRC-recovery + ListenBrainz + the dark Spotify search), then a PAID Apify search
// fallback over the free-rung misses. The free rungs anchor with `stampOnMiss: false` deliberately —
// "leave Apify its turn" — so a full free-rung miss is NOT stamped `spotify_anchor_attempted_at`, and
// only the Apify rung (via `anchorTrack`) stamps the re-ask backoff (track-work.ts
// `ANCHOR_REASK_AFTER_DAYS`).
//
// When Apify hits its account cap it returns `403 "Monthly usage hard limit exceeded"`. The box sweep
// catches the failed actor run as a `skipped` chunk and continues — but a failed run posts NO
// candidates, so `anchorTrack` never runs and those rows are NEVER stamped. Un-stamped rows never enter
// the 14-day backoff, so they recirculate at the head of the anchor worklist every tick and the drain
// STALLS (observed: 0 anchored / 200 skipped per tick, the tens of thousands behind them unreachable).
//
// ── THE FLAG, DEFAULT ON ─────────────────────────────────────────────────────────────────────────
// This flag is the operator's answer: flip it OFF when out of Apify budget, and the sweep becomes a
// clean free-rungs-only drain. Two behaviours change, both driven by this ONE flag (lib/server/anchor.ts
// `resolveAnchorFree` + docs/agents/hermes/scripts/anchor-sweep.ts):
//   1. The free rungs STAMP-AND-BACK-OFF their full misses — no Apify rung is coming to take its turn,
//      so a genuinely-exhausted row backs off (14 days) instead of recirculating.
//   2. The box sweep SKIPS the Apify actor call entirely — no wasted 403s — and counts those rows as
//      honestly missed (terminal free attempt + stamp), not skipped-for-retry.
//
// It rides the same lean `settings` KV every other kill switch does (./settings.ts) — never a second
// flag mechanism. Unlike the DEFAULT-OFF dark flags (clip drip, the anchor SEARCH flag), this one is
// DEFAULT ON: the correct steady state is "Apify runs". So the read is default-ALLOW — only the exact
// string "false" disables it; an unset row, an empty database, a fresh preview, or any unrecognised
// value all read as ON. A lost row must NOT silently disable the paid rung.
//
// ── THE FLIP-ON REQUEUE — undoing the off-window priority inversion ────────────────────────────────
// While the flag is OFF the free rungs stamp-and-back-off their full misses (`resolveAnchorFree`), so
// every skipped row enters the 14-day `ANCHOR_REASK_AFTER_DAYS` backoff. But the anchor worklist is
// PRIORITY-ORDERED (track-work.ts `ANCHOR_ORDER`: embedding-present, then closeness to findings), so the
// rows skipped while OFF are the HIGHER-priority ones — and once budget returns they would still wait out
// ~14 days while Apify works lower-priority rows first. That is a priority inversion, so flipping the flag
// back ON re-queues exactly the off-window deferrals: it nulls the `spotify_anchor_attempted_at` stamp on
// every un-anchored row stamped at-or-after the moment the flag went OFF (recorded in `ANCHOR_APIFY_DISABLED_AT_KEY`),
// so those rows re-enter the worklist and re-sort by `ANCHOR_ORDER` at their real priority immediately.
//
// WHY THAT IS PROVABLY SAFE: while the flag is OFF the box makes ZERO Apify attempts, so EVERY stamp
// written during the off-window is a "deferred, never actually tried" stamp — never a real miss-backoff.
// Genuine Apify-attempt backoffs all PREDATE the off-window (`attempted_at < disabled_at`), so clearing
// stamps `>= disabled_at` targets ONLY the deferrals and leaves every real prior backoff untouched. The
// off-window start is stamped ONCE, on the on→off transition only (earliest-wins), so a repeated OFF→OFF
// keeps the EARLIEST time and the window covers the whole outage. The requeue is a ONE-SHOT operator write
// (the flip-ON), never a per-tick/hot path, so its full-table scan is acceptable.

import { getDb } from "./db";
import { deleteSetting, getSetting, setSetting } from "./settings";

/** The kill-flag on the shared `settings` KV. DEFAULT ON — only the literal "false" disables it. */
export const ANCHOR_APIFY_ENABLED_KEY = "anchor_apify_enabled";

/**
 * The off-window START marker on the shared `settings` KV — an ISO-8601 timestamp (so it compares
 * lexicographically-as-chronologically against `spotify_anchor_attempted_at`, which is stored the same
 * way). Written ONCE on the on→off transition (earliest-wins across a repeated OFF→OFF), read by the
 * flip-ON requeue to bound exactly the off-window deferrals, and deleted once that requeue has run.
 */
export const ANCHOR_APIFY_DISABLED_AT_KEY = "anchor_apify_disabled_at";

/**
 * Whether the metered Apify anchor-search FALLBACK is enabled — THE KILL-FLAG, default ON.
 *
 * DEFAULT-ALLOW, the opposite of the dark flags' default-deny: ONLY the explicit string "false"
 * disables the fallback. An unset key, an empty database, a fresh preview, or any value nobody
 * recognises all read as ON. The steady state is "Apify runs"; the operator flips this to "false"
 * only while out of budget, and a lost/corrupt row falls back to the paid rung being ENABLED rather
 * than silently starving the waterfall of its last resort.
 */
export async function isAnchorApifyEnabled(): Promise<boolean> {
  return (await getSetting(ANCHOR_APIFY_ENABLED_KEY)) !== "false";
}

/**
 * Re-queue exactly the off-window deferrals — the rows stamped `spotify_anchor_attempted_at` at-or-after
 * the moment the flag went OFF — by nulling that stamp so they re-enter the priority-ordered anchor
 * worklist immediately. A no-op (returns 0) when the off-window marker is unset (the flag was already on,
 * or never went off). Returns the number of rows re-queued.
 *
 * BOUNDED OPERATOR WRITE, off the hot path: this runs ONLY on the operator's flip-ON of the kill-flag,
 * never on any per-tick sweep, so a full-table scan of `tracks` here is acceptable (unlike the anchor
 * worklist read, which rides `tracks_anchor_fill_queue_idx`). The WHERE targets ONLY un-anchored rows
 * (`spotify_uri is null`) whose stamp is `>= disabled_at`: every such stamp was written while the box made
 * ZERO Apify attempts, so it is a deferral, never a genuine miss-backoff — and genuine backoffs, which all
 * predate the off-window (`attempted_at < disabled_at`), are left untouched.
 */
async function requeueOffWindowDeferrals(): Promise<number> {
  const disabledAt = await getSetting(ANCHOR_APIFY_DISABLED_AT_KEY);

  if (!disabledAt) {
    return 0;
  }

  const db = await getDb();
  const result = await db.execute({
    args: [disabledAt],
    sql: `update tracks
          set spotify_anchor_attempted_at = null
          where spotify_uri is null
            and spotify_anchor_attempted_at >= ?`,
  });

  return result.rowsAffected;
}

/**
 * Flip the kill-flag (operator). Writing "false" disables the Apify fallback; anything else enables it.
 *
 * OFF (on→off): also records the off-window start (`ANCHOR_APIFY_DISABLED_AT_KEY`) — but ONLY if it is
 * not already set, so a repeated OFF→OFF keeps the EARLIEST off-time and the window covers the whole
 * outage. ON (off→on): re-queues the off-window deferrals FIRST (so the marker is still readable), then
 * clears the marker. Returns the number of rows re-queued (0 for a flip-OFF, or a flip-ON with no
 * off-window recorded).
 */
export async function setAnchorApifyEnabled(enabled: boolean): Promise<number> {
  if (!enabled) {
    await setSetting(ANCHOR_APIFY_ENABLED_KEY, "false");

    // Stamp the off-window start ONCE — only the on→off transition writes it (earliest-wins).
    if (!(await getSetting(ANCHOR_APIFY_DISABLED_AT_KEY))) {
      await setSetting(ANCHOR_APIFY_DISABLED_AT_KEY, new Date().toISOString());
    }

    return 0;
  }

  await setSetting(ANCHOR_APIFY_ENABLED_KEY, "true");

  // Re-queue while the marker is still present, THEN clear it (a failed requeue leaves the marker so a
  // later flip retries — self-healing). A no-op when the flag was already on (no marker set).
  const requeued = await requeueOffWindowDeferrals();
  await deleteSetting(ANCHOR_APIFY_DISABLED_AT_KEY);

  return requeued;
}
