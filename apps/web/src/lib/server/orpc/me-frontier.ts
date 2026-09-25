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
