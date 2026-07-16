// The `admin-frontier` domain contract module — the weekly Frontier refresh (E2, the
// public recommendation machine). ONE op: `refresh_frontier_playlists`, the engine the
// on-box `fluncle-frontier-refresh` weekly cron drives to re-mirror every crew member's
// Frontier playlist from their current recommendations.

import { oc } from "@orpc/contract";
import * as z from "zod";

/**
 * `refresh_frontier_playlists` → `POST /admin/frontier-playlists/refresh`
 * (operationId `refreshFrontierPlaylists`).
 *
 * ADMIN tier (adminAuth only, no operatorGuard): the box's weekly `fluncle-frontier-
 * refresh` cron drives it with the agent-scoped token — the `advance_publish_queue` /
 * `rank_catalogue` precedent (the Worker owns the Spotify grant; the box only triggers).
 * It creates NO new public authority the operator did not already give: every playlist
 * it touches already exists, minted by its own owner.
 *
 * It respects the DEFAULT-DENY kill switch first (a closed switch returns
 * `switchOff: true` and touches nothing), then walks up to `limit` minted playlists
 * oldest first and mint-or-refreshes each. Best-effort per user: one Spotify fault is
 * counted in `failed` and the walk continues. The counts are the sweep's JSON summary.
 */
export const refreshFrontierPlaylists = oc
  .route({
    method: "POST",
    operationId: "refreshFrontierPlaylists",
    path: "/admin/frontier-playlists/refresh",
    summary: "Refresh every crew member's Frontier playlist (weekly cron; agent-tier)",
    tags: ["Admin"],
  })
  .input(z.object({ limit: z.number().int().positive().optional() }))
  .output(
    z.object({
      // Users whose sync threw a Spotify fault (best-effort; the walk continues).
      failed: z.number(),
      // Playlists newly created this tick (a user who minted since last refresh).
      minted: z.number(),
      ok: z.literal(true),
      // Playlists whose item list changed and was re-mirrored (distinct from `minted`).
      refreshed: z.number(),
      // Rows the switch flipped out from under mid-walk (rare).
      skipped: z.number(),
      // True ⇒ the kill switch is closed; nothing was touched.
      switchOff: z.boolean(),
      // How many minted playlists the tick walked.
      total: z.number(),
      // Playlists the mirror guard left untouched (nothing changed).
      unchanged: z.number(),
    }),
  );

/** The `admin-frontier` domain's ops, merged into the root contract by `./index.ts`. */
export const adminFrontierContract = {
  refresh_frontier_playlists: refreshFrontierPlaylists,
};
