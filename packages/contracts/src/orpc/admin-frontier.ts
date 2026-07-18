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
 * It writes the next edition for every user with at least one existing edition REGARDLESS
 * of the kill switch (the edition is the shelf's source of truth); only the Spotify mirror
 * stays conditional (`switchOff` is reported for observability, never a short-circuit). A
 * draft-phase user with zero editions is skipped by construction. It walks up to `limit`
 * users oldest-edition first. Best-effort per user: one Spotify fault is counted in `failed`
 * and the walk continues. The counts are the sweep's JSON summary.
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
      // Editions written without a Spotify mirror (minting dark this tick).
      editionOnly: z.number(),
      // Users whose sync threw a Spotify fault (best-effort; the walk continues).
      failed: z.number(),
      // Playlists newly created this tick (a user who minted since last refresh).
      minted: z.number(),
      ok: z.literal(true),
      // Playlists whose item list changed and was re-mirrored (distinct from `minted`).
      refreshed: z.number(),
      // Any unforeseen per-user status (defensive; expected 0).
      skipped: z.number(),
      // True ⇒ the kill switch is closed; editions were still written, the Spotify mirror skipped.
      switchOff: z.boolean(),
      // How many users the tick walked.
      total: z.number(),
      // Users whose desired list matched their latest edition (nothing written or mirrored).
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

/**
 * `upload_frontier_covers` → `POST /admin/frontier/covers` (operationId `uploadFrontierCovers`).
 *
 * ADMIN tier (adminAuth only, agent-allowed) — the `refresh_frontier_playlists` precedent: the
 * box's weekly cron (and the operator) drive it with the agent-scoped token. It touches only
 * playlists their owners already minted, so it creates no new public authority.
 *
 * THE COVER RETRY DRAIN. The custom per-user cover renders IN THE WORKER at mint time; this op
 * is the backfill for the ones that missed — a cover that failed at mint (a Spotify hiccup, a
 * missing scope) or a playlist minted before covers shipped. It walks the `cover_uploaded_at IS
 * NULL` rows, renders each cover in the Worker (Satori → JPEG), and uploads it. NO image input:
 * the Worker renders now (Remotion can't run in a Worker; Satori can). Best-effort per target;
 * the counts are the summary. Inert until the operator re-auths with `ugc-image-upload` — every
 * upload degrades cleanly (`missingScope`) and the row stays queued.
 */
export const uploadFrontierCovers = oc
  .route({
    method: "POST",
    operationId: "uploadFrontierCovers",
    path: "/admin/frontier/covers",
    summary:
      "Render + upload every Frontier cover still owing (the mint-cover retry drain; agent-tier)",
    tags: ["Admin"],
  })
  .input(z.object({ limit: z.number().int().positive().optional() }))
  .output(
    z.object({
      // Covers whose render or upload faulted (best-effort; retried next tick).
      failed: z.number(),
      // Covers rendered but NOT uploaded — the grant lacks `ugc-image-upload` (the dark state).
      missingScope: z.number(),
      ok: z.literal(true),
      // Covers rendered to a JPEG this tick.
      rendered: z.number(),
      // Rows walked (playlists with no cover yet).
      targets: z.number(),
      // Covers that landed on Spotify this tick.
      uploaded: z.number(),
    }),
  );

/** The `admin-frontier` domain's ops, merged into the root contract by `./index.ts`. */
export const adminFrontierContract = {
  get_frontier_minting: getFrontierMinting,
  refresh_frontier_playlists: refreshFrontierPlaylists,
  set_frontier_minting: setFrontierMinting,
  upload_frontier_covers: uploadFrontierCovers,
};
