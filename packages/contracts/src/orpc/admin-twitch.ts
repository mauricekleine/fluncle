import { oc } from "@orpc/contract";
import * as z from "zod";

export const recordLiveState = oc
  .route({
    method: "POST",
    operationId: "recordLiveState",
    path: "/admin/twitch/live",
    summary: "Record the current Twitch live state for the cross-surface live callout",
    tags: ["Admin"],
  })
  .input(
    z.object({
      at: z.string().min(1),
      live: z.boolean(),
      startedAt: z.string().nullable(),
      title: z.string().nullable(),
    }),
  )
  .output(z.object({ ok: z.literal(true) }));

export const adminTwitchContract = {
  record_live_state: recordLiveState,
};
