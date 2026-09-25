import { oc } from "@orpc/contract";
import * as z from "zod";

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
      budgetPaused: z.boolean(),

      building: z.number(),

      editionOnly: z.number(),

      failed: z.number(),

      minted: z.number(),
      ok: z.literal(true),

      refreshed: z.number(),

      skipped: z.number(),

      switchOff: z.boolean(),

      total: z.number(),

      unchanged: z.number(),
    }),
  );

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
      failed: z.number(),

      missingScope: z.number(),
      ok: z.literal(true),

      rendered: z.number(),

      targets: z.number(),

      uploaded: z.number(),
    }),
  );

export const adminFrontierContract = {
  get_frontier_minting: getFrontierMinting,
  refresh_frontier_playlists: refreshFrontierPlaylists,
  set_frontier_minting: setFrontierMinting,
  upload_frontier_covers: uploadFrontierCovers,
};
