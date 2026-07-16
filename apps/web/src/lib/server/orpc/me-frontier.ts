// The `me-frontier` domain router module — a signed-in user's ONE public Spotify
// playlist, "Fluncle's Frontier" (E2). The GET read is on `privateUserAuth` (401
// without a session); the mint is on `privateUserMutation` (CSRF + a 4/h rate limit)
// PLUS an in-handler verified-email gate (403 `email_unverified`) — the mint creates a
// real, public artifact on the operator's Spotify account, so it is held to the same
// verified-email bar the recommendation engine is.

import { ORPCError } from "@orpc/server";
import {
  FRONTIER_MINT_RATE_LIMIT,
  getFrontierState,
  mintOrRefreshFrontierPlaylist,
} from "../frontier-playlist";
import { privateUserAuth, privateUserMutation } from "../orpc-auth";
import { apiFault, type Implementer } from "./_shared";

/**
 * Build the `me-frontier` domain's handlers.
 *
 *   - `get_private_frontier_playlist` — the Frontier state (playlist URL + last sync +
 *     the kill-switch state). Session read.
 *   - `mint_private_frontier_playlist` — mint or refresh. CSRF + the
 *     `account.frontier.mint`/4-per-hour rate limit, and a verified-email gate in the
 *     handler (a mint creates a public playlist; an unverified account 403s). A closed
 *     kill switch is a clean `{ ok: true, status: "switch_off" }`, never a fault.
 */
export function meFrontierHandlers(os: Implementer) {
  const getFrontier = os.get_private_frontier_playlist
    .use(privateUserAuth)
    .handler(async ({ context }) => {
      try {
        return await getFrontierState(context.user);
      } catch (error) {
        if (error instanceof ORPCError) {
          throw error;
        }

        throw apiFault(error);
      }
    });

  const mintFrontier = os.mint_private_frontier_playlist
    .use(privateUserMutation({ action: "account.frontier.mint", limit: FRONTIER_MINT_RATE_LIMIT }))
    .handler(async ({ context }) => {
      try {
        // The verified-email gate, on TOP of the session/CSRF/rate-limit tier. A mint
        // creates a public playlist, so it is held to the same bar the rec engine is.
        if (!context.user.emailVerified) {
          throw new ORPCError("FORBIDDEN", {
            data: {
              apiCode: "email_unverified",
              apiMessage: "Verify your email to get your Frontier playlist.",
            },
            message: "Verify your email to get your Frontier playlist.",
            status: 403,
          });
        }

        const result = await mintOrRefreshFrontierPlaylist(context.user);

        if (!result.ok) {
          // A best-effort fault (a Spotify hiccup, or the daily mint cap) surfaces as a
          // 503 the page can retry — the mint is idempotent, so a retry is safe.
          throw new ORPCError("SERVICE_UNAVAILABLE", {
            data: {
              apiCode:
                result.reason === "mint_cap_reached" ? "mint_cap_reached" : "frontier_sync_failed",
              apiMessage:
                result.reason === "mint_cap_reached"
                  ? "The Frontier is minting a lot right now. Try again shortly."
                  : "Couldn't reach Spotify for your Frontier. Try again shortly.",
            },
            message: "Frontier sync failed",
            status: 503,
          });
        }

        return {
          ok: true as const,
          playlistUrl: result.playlistUrl,
          status: result.status,
        };
      } catch (error) {
        if (error instanceof ORPCError) {
          throw error;
        }

        throw apiFault(error);
      }
    });

  return {
    get_private_frontier_playlist: getFrontier,
    mint_private_frontier_playlist: mintFrontier,
  };
}
