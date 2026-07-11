// The `admin-costs` domain contract module — the agent-tier WRITE into the
// append-only `cost_events` ledger (COST-01). The box holds the AGENT token and
// POSTs the box-side numbers (the `claude -p` authoring tokens, enrich/embed
// seconds, render box-minutes); the Worker-local capture paths reuse the SAME
// `CostEventInput` shape in-process. Modeled on `record_health` — AGENT tier
// (`adminAuth`, NOT `operatorGuard`), because the box's agent token drives it and
// it writes only the internal ledger (no publish, fully reversible).
//
//   - `record_cost` — POST /admin/costs/events. Body: an ARRAY of CostEventInput
//     (a sweep batches a tick's rows). MADE IDEMPOTENT: each event carries a
//     client-generated STABLE `id`, and the handler inserts ON CONFLICT(id) DO
//     NOTHING, so a retried best-effort POST re-inserts the same ids and is
//     ignored (an append-only ledger double-counts a retry otherwise). Output is
//     `{ ok: true, inserted }` — the count actually written, so a caller can see a
//     retry land zero.
//
// This is a PRIVATE admin op: the ledger is internal cost data, kept off the
// public OpenAPI doc by the `/admin/*` path filter (orpc.ts).

import { oc } from "@orpc/contract";
import * as z from "zod";

// The closed sets, mirrored from the `cost_events` typed-enum columns (schema.ts).
// The box supplies the semantic facts it alone knows; the Worker prices + stamps
// `created_at`.
const CostStep = z.enum([
  "enrich",
  "embed",
  "context",
  "observe",
  "note",
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

/**
 * One ledger row's worth of facts the emitter supplies. Pinned (RFC §3): the box
 * knows the SEMANTIC facts (which step/vendor/basis/source, how much, when, for
 * which finding); the Worker sets `createdAt` and prices
 * `estimatedUsd = usd ?? priceFromRates(...)` (NULL on a rate miss — unpriced,
 * never $0). `usd` is sent only by `anthropic` (the envelope's `total_cost_usd`)
 * and the OpenRouter distil (priced from its in/out token split); every other
 * vendor omits it and the Worker prices from `cost-rates.ts`.
 */
export const CostEventInputSchema = z
  .object({
    // Known at the call site, NOT inferable from vendor alone.
    costBasis: CostBasis,
    // The deterministic idempotency key (see the schema's `id` note).
    id: z.string().min(1),
    logId: z.string().nullish(),
    // LLM rows carry the model (e.g. claude-sonnet-4-6); others omit.
    model: z.string().nullish(),
    occurredAt: z.string().min(1), // ISO when the work was spent
    quantity: z.number(),
    // Cartesia=measured vs Firecrawl=estimated can share a vendor, so it's explicit.
    source: CostSource,
    step: CostStep,
    trackId: z.string().nullish(),
    unitType: CostUnitType,
    // anthropic sends the envelope's total_cost_usd; the OpenRouter distil sends
    // its token-priced figure; every other vendor omits it → the Worker prices.
    usd: z.number().nullish(),
    vendor: CostVendor,
  })
  .meta({ id: "CostEventInput" });

/** The pinned per-row input the box (and the Worker-local paths) supply. */
export type CostEventInput = z.infer<typeof CostEventInputSchema>;

/**
 * `record_cost` → `POST /admin/costs/events` (operationId `recordCost`).
 *
 * AGENT tier (`adminAuth`, no `operatorGuard`): the box's agent-token sweeps POST
 * their tick's rows, the `record_health`/`context_track` precedent. Idempotent
 * insert (ON CONFLICT(id) DO NOTHING). Returns `{ ok, inserted }`.
 */
export const recordCost = oc
  .route({
    method: "POST",
    operationId: "recordCost",
    path: "/admin/costs/events",
    summary: "Record a batch of cost-ledger events (idempotent by event id)",
    tags: ["Admin"],
  })
  .input(z.array(CostEventInputSchema))
  .output(z.object({ inserted: z.number(), ok: z.literal(true) }));

/** The `admin-costs` domain's ops, merged into the root contract by `./index.ts`. */
export const adminCostsContract = {
  record_cost: recordCost,
};
