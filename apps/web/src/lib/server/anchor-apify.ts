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

import { getSetting, setSetting } from "./settings";

/** The kill-flag on the shared `settings` KV. DEFAULT ON — only the literal "false" disables it. */
export const ANCHOR_APIFY_ENABLED_KEY = "anchor_apify_enabled";

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

/** Flip the kill-flag (operator). Writing "false" disables the Apify fallback; anything else enables it. */
export async function setAnchorApifyEnabled(enabled: boolean): Promise<void> {
  await setSetting(ANCHOR_APIFY_ENABLED_KEY, enabled ? "true" : "false");
}
