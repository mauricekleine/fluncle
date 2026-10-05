import { oc } from "@orpc/contract";
import * as z from "zod";

const IndexNowKindSchema = z.enum(["log", "artist", "label", "album", "track"]);
const IndexNowCursorSchema = z.object({
  after: z.string().min(1).max(512).optional(),
  kind: IndexNowKindSchema,
});

export const submitIndexNow = oc
  .route({
    method: "POST",
    operationId: "submitIndexnow",
    path: "/admin/indexnow/submit",
    summary: "Observe one catalogue window or submit due page versions to IndexNow",
    tags: ["Admin"],
  })
  .input(
    z.discriminatedUnion("phase", [
      z.object({ cursor: IndexNowCursorSchema.optional(), phase: z.literal("walk") }),
      z.object({ dryRun: z.boolean().optional(), phase: z.literal("submit") }),
    ]),
  )
  .output(
    z.union([
      z.object({
        changed: z.number().int().nonnegative(),
        checked: z.number().int().nonnegative(),
        inserted: z.number().int().nonnegative(),
        kind: IndexNowKindSchema,
        next: IndexNowCursorSchema.nullable(),
        ok: z.literal(true),
        phase: z.literal("walk"),
        removed: z.number().int().nonnegative(),
      }),
      z.object({
        dryRun: z.boolean().optional(),
        due: z.number().int().nonnegative().nullable(),
        error: z.string().optional(),
        ok: z.boolean(),
        phase: z.literal("submit"),
        sample: z.array(z.string()).max(10).optional(),
        status: z.number().int().nullable(),
        submitted: z.number().int().nonnegative(),
      }),
    ]),
  );

export const adminIndexNowContract = { submit_indexnow: submitIndexNow };
