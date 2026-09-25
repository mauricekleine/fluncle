import { oc } from "@orpc/contract";
import * as z from "zod";

export const GraphEntityKindSchema = z
  .enum(["album", "artist", "galaxy", "label"])
  .meta({ id: "GraphEntityKind" });

export const GraphPreviewSchema = z
  .object({
    bio: z.string().optional(),
    covers: z.array(z.string()),
    findingCount: z.number(),
    kind: GraphEntityKindSchema,

    line: z.string().optional(),
    name: z.string(),
    slug: z.string(),
  })
  .meta({ id: "GraphPreview" });

export const getGraphPreview = oc
  .route({
    method: "GET",
    operationId: "getGraphPreview",
    path: "/graph/{kind}/{slug}",
    summary: "Preview one graph entity (artist, label, album, or galaxy) by slug",
    tags: ["Graph"],
  })
  .input(z.object({ kind: GraphEntityKindSchema, slug: z.string() }))
  .output(z.object({ ok: z.literal(true), preview: GraphPreviewSchema }));

export const graphContract = {
  get_graph_preview: getGraphPreview,
};
