import { oc } from "@orpc/contract";
import * as z from "zod";

const IndexNowKindSchema = z.enum(["log", "artist", "label", "album", "track"]);
const IndexNowCursorSchema = z.object({
  after: z.string().min(1).max(512).optional(),
  kind: IndexNowKindSchema,
});

const IndexNowVersionSchema = z.object({
  changedAt: z
    .string()
    .min(10)
    .max(64)
    .regex(/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})?)?$/)
    .refine((value) => Number.isFinite(Date.parse(value)), "Invalid change date"),
  fingerprint: z.string().min(1).max(128),
  kind: IndexNowKindSchema,
  subjectId: z.string().min(1).max(512),
});

export const submitIndexNow = oc
  .route({
    method: "POST",
    operationId: "submitIndexnow",
    path: "/admin/indexnow/submit",
    summary:
      "Observe, claim, or acknowledge catalogue page versions for box-side IndexNow submission",
    tags: ["Admin"],
  })
  .input(
    z.discriminatedUnion("phase", [
      z.object({ cursor: IndexNowCursorSchema.optional(), phase: z.literal("walk") }),
      z.object({
        limit: z.number().int().min(1).max(10000).default(10000),
        phase: z.literal("claim"),
      }),
      z.object({
        phase: z.literal("ack"),
        versions: z.array(IndexNowVersionSchema).min(1).max(10000),
      }),
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
        due: z.number().int().nonnegative(),
        indexNow: z.object({ host: z.string(), key: z.string(), keyLocation: z.string() }),
        items: z.array(IndexNowVersionSchema.extend({ url: z.string() })).max(10000),
        ok: z.literal(true),
        phase: z.literal("claim"),
      }),
      z.object({
        due: z.number().int().nonnegative(),
        ok: z.literal(true),
        phase: z.literal("ack"),
        stamped: z.number().int().nonnegative(),
      }),
    ]),
  );

export const adminIndexNowContract = { submit_indexnow: submitIndexNow };
