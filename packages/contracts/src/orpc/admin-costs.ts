import { oc } from "@orpc/contract";
import * as z from "zod";

const CostStep = z.enum([
  "enrich",
  "embed",
  "context",
  "observe",
  "note",
  "bio",
  "video",
  "publish",
  "discogs",
  "lastfm",
  "newsletter",
  "studio-clip",
  "cluster",
  "search",
]);
const CostVendor = z.enum([
  "anthropic",
  "openrouter",
  "cartesia",
  "firecrawl",
  "apify",
  "resend",
  "self",
]);
const CostUnitType = z.enum(["tokens", "characters", "seconds", "requests", "emails"]);
const CostBasis = z.enum(["cash", "subsidized"]);
const CostSource = z.enum(["measured", "estimated"]);

export const COST_EVENT_LOG_ID_MAX = 64;
export const COST_EVENT_TRACK_ID_MAX = 256;
export const COST_EVENT_MODEL_MAX = 256;
export const COST_EVENT_TIMESTAMP_MAX = 64;
export const COST_EVENT_ID_MAX = 1024;

export const CostEventInputSchema = z
  .object({
    costBasis: CostBasis,

    id: z.string().min(1).max(COST_EVENT_ID_MAX),
    logId: z.string().max(COST_EVENT_LOG_ID_MAX).nullish(),

    model: z.string().max(COST_EVENT_MODEL_MAX).nullish(),
    occurredAt: z.string().min(1).max(COST_EVENT_TIMESTAMP_MAX),
    quantity: z.number(),

    source: CostSource,
    step: CostStep,
    trackId: z.string().max(COST_EVENT_TRACK_ID_MAX).nullish(),
    unitType: CostUnitType,

    usd: z.number().nullish(),
    vendor: CostVendor,
  })
  .meta({ id: "CostEventInput" });

export type CostEventInput = z.infer<typeof CostEventInputSchema>;

const MAX_COST_EVENTS_PER_BATCH = 500;

export const recordCost = oc
  .route({
    method: "POST",
    operationId: "recordCost",
    path: "/admin/costs/events",
    summary: "Record a batch of cost-ledger events (idempotent by event id)",
    tags: ["Admin"],
  })
  .input(z.array(CostEventInputSchema).max(MAX_COST_EVENTS_PER_BATCH))
  .output(z.object({ inserted: z.number(), ok: z.literal(true) }));

export const adminCostsContract = {
  record_cost: recordCost,
};
