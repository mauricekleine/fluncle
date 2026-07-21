// The `fluncle admin reach` commands — the /reach collector's thin HTTP client.
//
// REACH is how far Fluncle's tentacles stretch across the web: the follower /
// subscriber / play / star counts on every platform, snapshotted daily. `collect` is
// a bare trigger (the Worker owns every platform credential and does all the
// fetching) — the on-box `fluncle-reach` `--no-agent` cron drives it with the box's
// agent token, exactly like `admin catalogue rank`. The CLI is a pacer, not an
// engine.

import { adminApiPost } from "../api";

/** A platform whose numbers landed this collect (its metric names). */
export type ReachCollectedPlatform = { metrics: string[]; platform: string };

/** A platform skipped this collect (unconfigured, or a best-effort fetch fault). */
export type ReachSkippedPlatform = { platform: string; reason: string };

/** The `record_platform_stats` outcome envelope. */
export type ReachCollectResult = {
  collected: ReachCollectedPlatform[];
  inserted: number;
  ok: true;
  skipped: ReachSkippedPlatform[];
};

/**
 * Collect + record one daily reach snapshot. `fluncle admin reach collect`.
 *
 * Fires the agent-tier `record_platform_stats` op: the Worker fetches every Tier-1
 * platform (each best-effort), writes one idempotent snapshot row per (platform,
 * metric), and returns which platforms landed, which were skipped, and how many rows
 * were actually written (a same-day re-run lands `inserted: 0`).
 */
export async function reachCollectCommand(): Promise<ReachCollectResult> {
  return adminApiPost<ReachCollectResult>("/api/v1/admin/reach/collect", {});
}
