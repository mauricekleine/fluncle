import { oc } from "@orpc/contract";
import * as z from "zod";
import { TrackListItemSchema } from "./_shared";

export const listStories = oc
  .route({
    method: "GET",
    operationId: "listStories",
    path: "/stories",
    summary: "List the Stories feed (findings with a rendered video)",
    tags: ["Stories"],
  })
  .input(
    z.object({
      cursor: z.string().optional(),
      limit: z.string().optional(),
    }),
  )
  .output(
    z.object({
      nextCursor: z.string().optional(),
      totalCount: z.number(),
      tracks: z.array(TrackListItemSchema),
    }),
  );

export const storiesContract = {
  list_stories: listStories,
};
