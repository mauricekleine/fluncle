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

/**
 * `get_frontier_minting` → `GET /admin/frontier/minting` (operationId `getFrontierMinting`).
 *
 * ADMIN tier (agent-allowed read): whether the DEFAULT-DENY kill switch is open — the
 * `get_capture_budget` precedent (a read of an operator dial is not the dial).
 */
export const getFrontierMinting = oc
  .route({
    method: "GET",
    operationId: "getFrontierMinting",
    path: "/admin/frontier/minting",
    summary: "Whether Frontier minting is open (the kill switch's state)",
    tags: ["Admin"],
  })
  .input(z.object({}))
  .output(z.object({ ok: z.literal(true), open: z.boolean() }));

/**
 * `set_frontier_minting` → `PUT /admin/frontier/minting` (operationId `setFrontierMinting`).
 *
 * OPERATOR tier (`adminAuth` + `operatorGuard`) — the `set_capture_budget` precedent:
 * opening minting lets the machine create public playlists on the operator's own Spotify
 * account, which is exactly the class of authority an agent token must never grant
 * itself. One write, effective on the next mint, no deploy (the switch is the
 * `frontier.minting` settings row; DEFAULT-DENY, only the literal "true" opens).
 */
export const setFrontierMinting = oc
  .route({
    method: "PUT",
    operationId: "setFrontierMinting",
    path: "/admin/frontier/minting",
    summary: "Open or close Frontier minting — the kill switch (operator)",
    tags: ["Admin"],
  })
  .input(z.object({ open: z.boolean() }))
  .output(z.object({ ok: z.literal(true), open: z.boolean() }));

/** The `admin-frontier` domain's ops, merged into the root contract by `./index.ts`. */
export const adminFrontierContract = {
  get_frontier_minting: getFrontierMinting,
  refresh_frontier_playlists: refreshFrontierPlaylists,
  set_frontier_minting: setFrontierMinting,
};
