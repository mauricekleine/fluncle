// The `me-frontier` domain contract module — a signed-in user's ONE public Spotify
// playlist, "Fluncle's Frontier" (E2, the public recommendation machine;
// docs/planning/ROADMAP.md § the public recommendation machine). The playlist lives on
// FLUNCLE'S OWN Spotify account (no per-user OAuth) and mirrors the user's current
// recommendations (the E1 blend), refreshed weekly. The mint is a CSRF-guarded write
// gated on a VERIFIED email; the read is a plain cookie-session read. A future wave
// adds an op here and one import line in `./index.ts`, touching no other domain's file.

import { oc } from "@orpc/contract";
import * as z from "zod";

/**
 * `mint_private_frontier_playlist` → `POST /me/frontier-playlist`
 * (operationId `mintPrivateFrontierPlaylist`).
 *
 * Mint (or, if it already exists, REFRESH) the signed-in user's Frontier playlist from
 * their current recommendations. CSRF-guarded, verified-email gated (403
 * `email_unverified`), and rate-limited (4/h — a real Spotify create/replace). The
 * empty request body keeps oRPC from pre-rejecting a bodyless POST.
 *
 * `status` reports what happened: `minted` (created), `refreshed` (items changed),
 * `unchanged` (the mirror guard skipped the PUT), or `switch_off` (the DEFAULT-DENY
 * kill switch is closed — nothing was created, `playlistUrl` absent). `playlistUrl` is
 * present on every outcome that has a playlist.
 */
export const mintPrivateFrontierPlaylist = oc
  .route({
    method: "POST",
    operationId: "mintPrivateFrontierPlaylist",
    path: "/me/frontier-playlist",
    summary: "Mint or refresh the signed-in user's Frontier playlist",
    tags: ["Me"],
  })
  .input(z.looseObject({}))
  .output(
    z.object({
      ok: z.literal(true),
      playlistUrl: z.string().optional(),
      status: z.enum(["minted", "refreshed", "unchanged", "switch_off"]),
    }),
  );

/**
 * `get_private_frontier_playlist` → `GET /me/frontier-playlist`
 * (operationId `getPrivateFrontierPlaylist`).
 *
 * The signed-in user's Frontier state: the playlist URL + when it last synced (both
 * absent until the first mint), plus `mintingOpen` — the kill-switch state — so the
 * page can message honestly (offer the mint, or say minting is closed) instead of
 * rendering a button that 503s. A missing session is the rails-encoded 401.
 */
export const getPrivateFrontierPlaylist = oc
  .route({
    method: "GET",
    operationId: "getPrivateFrontierPlaylist",
    path: "/me/frontier-playlist",
    summary: "Read the signed-in user's Frontier playlist state",
    tags: ["Me"],
  })
  .output(
    z.object({
      lastSyncedAt: z.string().optional(),
      mintingOpen: z.boolean(),
      ok: z.literal(true),
      playlistUrl: z.string().optional(),
    }),
  );

/** The `me-frontier` domain's ops, merged into the root contract by `./index.ts`. */
export const meFrontierContract = {
  get_private_frontier_playlist: getPrivateFrontierPlaylist,
  mint_private_frontier_playlist: mintPrivateFrontierPlaylist,
};
