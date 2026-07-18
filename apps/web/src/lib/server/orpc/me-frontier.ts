// The `me-frontier` domain router module — a signed-in user's ONE public Spotify
// playlist, "Fluncle's Frontier" (E2). The GET read is on `privateUserAuth` (401
// without a session); the mint is on `privateUserMutation` (CSRF + a 4/h rate limit)
// PLUS an in-handler verified-email gate (403 `email_unverified`) — the mint creates a
// real, public artifact on the operator's Spotify account, so it is held to the same
// verified-email bar the recommendation engine is.

import { waitUntil } from "cloudflare:workers";
import { ORPCError } from "@orpc/server";
import { getFrontierEdition, getFrontierEditions } from "../frontier-editions";
import {
  FRONTIER_MINT_RATE_LIMIT,
  getFrontierState,
  mintOrRefreshFrontierPlaylist,
} from "../frontier-playlist";
import { logEvent } from "../log";
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

        // THE COVER LANDS WITH THE MINT. On a fresh CREATE only (a refresh already has its
        // cover), fire the in-Worker Satori render + Spotify upload on `waitUntil` so it runs
        // after the response — the mint never waits on it, and a cover failure never fails the
        // mint (the row keeps its NULL stamp and the `upload_frontier_covers` backfill retries).
        // The lazy `import` keeps `workers-og` out of the `./orpc` module graph (frontier-cover.ts).
        if (result.status === "minted" && result.playlistId) {
          const playlistId = result.playlistId;
          const crewNumber = context.user.crewNumber ?? null;
          const userId = context.user.id;

          waitUntil(
            import("../frontier-cover")
              .then((cover) => cover.uploadFrontierCoverForUser({ crewNumber, playlistId, userId }))
              .catch((error) =>
                logEvent("warn", "frontier.cover-mint-fire-failed", { error, userId }),
              ),
          );
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

  const listEditions = os.list_private_frontier_editions
    .use(privateUserAuth)
    .handler(async ({ context }) => {
      try {
        // Scope to the session user; zero editions is a clean empty array, never a 404.
        return { editions: await getFrontierEditions(context.user.id), ok: true as const };
      } catch (error) {
        if (error instanceof ORPCError) {
          throw error;
        }

        throw apiFault(error);
      }
    });

  const getEdition = os.get_private_frontier_edition
    .use(privateUserAuth)
    .handler(async ({ context, input }) => {
      try {
        // The path number is raw (the rails keep params as strings). Parse it, and
        // scope the read by the session user — the number is per-user, so the user_id
        // predicate is what makes it THIS user's edition. A bad or missing number 404s.
        const number = Number.parseInt(input.number, 10);

        if (!Number.isInteger(number) || number < 1) {
          throw new ORPCError("NOT_FOUND", {
            data: { apiCode: "frontier_edition_not_found", apiMessage: "Edition not found" },
            message: "Edition not found",
            status: 404,
          });
        }

        const edition = await getFrontierEdition(context.user.id, number);

        if (!edition) {
          throw new ORPCError("NOT_FOUND", {
            data: { apiCode: "frontier_edition_not_found", apiMessage: "Edition not found" },
            message: "Edition not found",
            status: 404,
          });
        }

        return { edition: edition.summary, ok: true as const, tracks: edition.tracks };
      } catch (error) {
        if (error instanceof ORPCError) {
          throw error;
        }

        throw apiFault(error);
      }
    });

  return {
    get_private_frontier_edition: getEdition,
    get_private_frontier_playlist: getFrontier,
    list_private_frontier_editions: listEditions,
    mint_private_frontier_playlist: mintFrontier,
  };
}
