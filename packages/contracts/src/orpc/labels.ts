import { oc } from "@orpc/contract";
import * as z from "zod";

export const LabelEdgeSchema = z
  .object({ name: z.string(), slug: z.string() })
  .meta({ id: "LabelEdge" });

export const LabelListItemSchema = z
  .object({
    certified: z.boolean(),
    coverImageUrl: z.string().optional(),
    findingCount: z.number(),
    logoImageUrl: z.string().optional(),
    name: z.string(),
    slug: z.string(),
    trackCount: z.number(),
  })
  .meta({ id: "LabelListItem" });

export const LabelDetailSchema = z
  .object({
    bio: z.string().optional(),
    certified: z.boolean(),
    coverImageUrl: z.string().optional(),
    discogsLabelId: z.number().optional(),
    findingCount: z.number(),
    foundedLocation: z.string().optional(),
    foundingDate: z.string().optional(),
    logoImageUrl: z.string().optional(),
    mbLabelId: z.string().optional(),
    name: z.string(),
    parentLabel: LabelEdgeSchema.optional(),
    slug: z.string(),
    subLabels: z.array(LabelEdgeSchema).optional(),
    trackCount: z.number(),
  })
  .meta({ id: "LabelDetail" });

export const listLabels = oc
  .route({
    method: "GET",
    operationId: "listLabels",
    path: "/labels",
    summary: "List every label Fluncle holds, A to Z, one page at a time",
    tags: ["Labels"],
  })
  .input(z.object({ page: z.string().optional() }))
  .output(
    z.object({
      labels: z.array(LabelListItemSchema),
      ok: z.literal(true),
      page: z.number(),
      pageCount: z.number(),
      total: z.number(),
    }),
  );

export const getLabel = oc
  .route({
    method: "GET",
    operationId: "getLabel",
    path: "/labels/{slug}",
    summary: "Get a label by slug",
    tags: ["Labels"],
  })
  .input(z.object({ slug: z.string() }))
  .output(z.object({ label: LabelDetailSchema, ok: z.literal(true) }));

export const labelsContract = {
  get_label: getLabel,
  list_labels: listLabels,
};
