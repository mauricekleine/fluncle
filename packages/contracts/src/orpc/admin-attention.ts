import { oc } from "@orpc/contract";
import * as z from "zod";

export const AttentionSourceSchema = z
  .enum([
    "anchor-review",
    "artist-review",
    "attach-cues",
    "bio-review",
    "capture-suspect",
    "distribute",
    "drip-empty",
    "label-review",
    "newsletter",
    "note-rejected",
    "observation-rejected",
    "post-tiktok",
    "post-youtube",
    "submission",
    "tiktok-draft",
  ])
  .meta({ id: "AttentionSource" });

export const AttentionRowSchema = z
  .object({
    deadlineAt: z.string().optional(),
    logId: z.string().optional(),

    path: z.string(),
    source: AttentionSourceSchema,
    title: z.string(),

    waiting: z.number().optional(),
  })
  .meta({ id: "AttentionRow" });

export const AttentionSourceCountSchema = z
  .object({
    count: z.number(),
    source: AttentionSourceSchema,
  })
  .meta({ id: "AttentionSourceCount" });

export const AttentionQueueSchema = z
  .object({
    brief: z.string(),
    counts: z.array(AttentionSourceCountSchema),

    renderQueueDepth: z.number(),
    rows: z.array(AttentionRowSchema),

    total: z.number(),
  })
  .meta({ id: "AttentionQueue" });

export const getAttention = oc
  .route({
    method: "GET",
    operationId: "getAttention",
    path: "/admin/attention",
    summary: "Read the /admin attention queue digest (counts, rows, and the day's dispatch)",
    tags: ["Admin"],
  })
  .input(z.object({}))
  .output(z.object({ attention: AttentionQueueSchema, ok: z.literal(true) }));

export const adminAttentionContract = {
  get_attention: getAttention,
};
