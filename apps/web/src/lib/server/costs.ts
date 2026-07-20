// The cost ledger's server-side write + read (COST-01). Three seams live here:
//
//   - `insertCostEvents(events)` — the idempotent APPEND: one multi-row
//     `insert … on conflict(id) do nothing`, returning the count actually written
//     (a retried id lands zero). Used by BOTH write paths — the Worker-local
//     capture sites in-process, and the agent-tier `record_cost` handler.
//   - `captureCostEvents(events)` — the BEST-EFFORT wrapper the Worker-local
//     capture sites use: it can NEVER throw and never rejects, so a cost-ledger
//     failure can't break the real vendor operation it rides alongside (the
//     note/observation/context/email still lands). A failure is logged, swallowed.
//   - `getCostInsights({ windowDays, topFindings })` — the two GROUP BY reads
//     behind `/admin/usage` (the `listHubPage` raw-SQL-aggregate
//     precedent): a per-STEP rollup (cash | subsidized in SEPARATE columns) and a
//     per-FINDING top-N (cash DESC), windowed by `occurred_at`. Unpriced
//     (`estimated_usd IS NULL`) rows are COUNTED separately, NEVER summed as 0, and
//     cash + subsidized are NEVER added together (the whole correctness story —
//     RFC §0).

import { type CostEventInput } from "@fluncle/contracts/orpc";
import { parseArtistsJson } from "./artists";
import { priceFromRates } from "./cost-rates";
import { getDb } from "./db";
import { logEvent } from "./log";

/**
 * The finding attribution a Worker-local capture site threads to its vendor call
 * so the emitted row can be grouped per-finding. Both optional/nullable — a
 * non-finding step (a newsletter send) leaves them unset.
 */
export type CostCaptureContext = { logId?: string | null; trackId?: string | null };

/**
 * Build a deterministic idempotency `id` for a cost row (schema.ts `id` note):
 * `${step}:${logId ?? trackId ?? "global"}:${vendor}:${unitType}:${occurredAt}`.
 * Two identical captures of the same unit of work collapse to one row.
 */
export function costEventId(parts: {
  logId?: string | null;
  occurredAt: string;
  step: string;
  trackId?: string | null;
  unitType: string;
  vendor: string;
}): string {
  const scope = parts.logId ?? parts.trackId ?? "global";

  return `${parts.step}:${scope}:${parts.vendor}:${parts.unitType}:${parts.occurredAt}`;
}

// The insert column order (matches the `cost_events` schema). One place so the
// placeholder tuple and the arg push below cannot drift.
const INSERT_COLUMNS = [
  "id",
  "cost_basis",
  "created_at",
  "estimated_usd",
  "log_id",
  "model",
  "occurred_at",
  "quantity",
  "source",
  "step",
  "track_id",
  "unit_type",
  "vendor",
] as const;

/**
 * The row's stored USD. The emitter's own `usd` wins (anthropic's envelope
 * `total_cost_usd`; the OpenRouter distil's token-priced figure) — it is the most
 * accurate number available; otherwise the single-count `priceFromRates`. A rate
 * MISS is `null` (UNPRICED — surfaced as "—", never laundered to $0). A row is
 * stored unpriced rather than as free.
 */
export function resolveEstimatedUsd(event: CostEventInput): number | null {
  if (typeof event.usd === "number") {
    return event.usd;
  }

  return priceFromRates(event.vendor, event.unitType, event.quantity);
}

/**
 * Append cost events to the ledger, IDEMPOTENTLY. One multi-row insert with
 * `on conflict(id) do nothing`, so a retried best-effort POST (same ids) is a
 * no-op — an append-only ledger double-counts a retry otherwise. Returns the
 * number of rows ACTUALLY inserted (`rowsAffected`); a fully-duplicate batch
 * returns 0. The Worker sets `created_at` and prices `estimated_usd` here, so the
 * emitter never has to.
 */
export async function insertCostEvents(events: CostEventInput[]): Promise<number> {
  if (events.length === 0) {
    return 0;
  }

  const db = await getDb();
  const createdAt = new Date().toISOString();
  const tuple = `(${INSERT_COLUMNS.map(() => "?").join(", ")})`;
  const placeholders = events.map(() => tuple).join(", ");
  const args: (string | number | null)[] = [];

  for (const event of events) {
    args.push(
      event.id,
      event.costBasis,
      createdAt,
      resolveEstimatedUsd(event),
      event.logId ?? null,
      event.model ?? null,
      event.occurredAt,
      event.quantity,
      event.source,
      event.step,
      event.trackId ?? null,
      event.unitType,
      event.vendor,
    );
  }

  const result = await db.execute({
    args,
    sql: `insert into cost_events (${INSERT_COLUMNS.join(", ")})
            values ${placeholders}
            on conflict(id) do nothing`,
  });

  return result.rowsAffected;
}

/**
 * BEST-EFFORT capture — the guarantee the Worker-local sites depend on: it can
 * NEVER throw and never rejects past its own boundary, so a cost-ledger failure is
 * invisible to the vendor operation it rides alongside (the real note / observation
 * / email always proceeds). A failure is logged and swallowed. Returns nothing.
 */
export async function captureCostEvents(events: CostEventInput[]): Promise<void> {
  try {
    await insertCostEvents(events);
  } catch (error) {
    // A missing table during a deploy window, a Turso blip — the ledger is an
    // enhancement, so a write failure here must never surface to the caller.
    logEvent("error", "costs.ledger-write-failed", { error });
  }
}

// ── The read surface (`/admin/usage`) ────────────────────────────────────────

/** One step's rollup — cash + subsidized in SEPARATE fields (never summed). */
export type CostStepRollup = {
  cashUsd: number; // Σ estimated_usd WHERE cost_basis='cash' AND priced
  eventCount: number;
  step: string;
  subsidizedUsd: number; // Σ estimated_usd WHERE cost_basis='subsidized' AND priced
  unpricedCount: number; // COUNT WHERE estimated_usd IS NULL (never summed as 0)
};

/** One finding's cash rollup — the per-finding top-N (cash DESC) list row. */
export type CostFindingRollup = {
  albumImageUrl: string | null;
  artists: string[];
  cashUsd: number;
  eventCount: number;
  logId: string | null;
  title: string | null;
  trackId: string;
};

export type CostInsights = {
  since: string; // ISO window start
  steps: CostStepRollup[];
  topFindings: CostFindingRollup[];
  totals: {
    cashUsd: number; // Σ cash across steps — the headline "cost per finding" base
    subsidizedUsd: number; // Σ subsidized — shown SEPARATELY, never added to cash
    unpricedCount: number; // rows that couldn't be priced (surfaced, never $0)
  };
  windowDays: number;
};

const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_TOP_FINDINGS = 20;

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The two aggregations behind `/admin/usage`, windowed by `occurred_at`:
 *   1. per-STEP rollup — cash and subsidized in separate columns + an unpriced
 *      count, so the split renders AS the split.
 *   2. per-FINDING top-N — the highest CASH-cost findings, joined to `tracks`.
 * Cash and subsidized are NEVER summed together; unpriced rows are counted, never
 * added as $0. Raw SQL (the `listHubPage` precedent).
 */
export async function getCostInsights(
  options: { topFindings?: number; windowDays?: number } = {},
): Promise<CostInsights> {
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const topFindings = options.topFindings ?? DEFAULT_TOP_FINDINGS;
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const db = await getDb();

  // Per-step rollup. FILTER-style conditional SUM/COUNT so one pass yields the cash
  // column, the subsidized column, and the unpriced count without ever blending
  // them. A NULL estimated_usd contributes to `unpriced`, never to a $ sum.
  const stepResult = await db.execute({
    args: [since],
    sql: `select step,
                 coalesce(sum(case when cost_basis = 'cash' and estimated_usd is not null
                                   then estimated_usd else 0 end), 0) as cash_usd,
                 coalesce(sum(case when cost_basis = 'subsidized' and estimated_usd is not null
                                   then estimated_usd else 0 end), 0) as subsidized_usd,
                 sum(case when estimated_usd is null then 1 else 0 end) as unpriced_count,
                 count(*) as event_count
            from cost_events
           where occurred_at >= ?
           group by step
           order by cash_usd desc, subsidized_usd desc`,
  });

  const steps: CostStepRollup[] = [];
  let totalCash = 0;
  let totalSubsidized = 0;
  let totalUnpriced = 0;

  for (const raw of stepResult.rows) {
    const row = raw as Record<string, unknown>;
    const step = optionalText(row["step"]);

    if (!step) {
      continue;
    }

    const cashUsd = toNumber(row["cash_usd"]);
    const subsidizedUsd = toNumber(row["subsidized_usd"]);
    const unpricedCount = toNumber(row["unpriced_count"]);

    steps.push({
      cashUsd,
      eventCount: toNumber(row["event_count"]),
      step,
      subsidizedUsd,
      unpricedCount,
    });

    totalCash += cashUsd;
    totalSubsidized += subsidizedUsd;
    totalUnpriced += unpricedCount;
  }

  // Per-finding top-N by CASH cost. Joined to `tracks` for the identity block; only
  // rows with a `track_id` (finding steps) participate. Cash only — the headline
  // question is "what did this finding cost in real money".
  const findingResult = await db.execute({
    args: [since, topFindings],
    sql: `select ce.track_id as track_id,
                 max(t.log_id) as log_id,
                 max(t.title) as title,
                 max(t.album_image_url) as album_image_url,
                 max(t.artists_json) as artists_json,
                 coalesce(sum(case when ce.cost_basis = 'cash' and ce.estimated_usd is not null
                                   then ce.estimated_usd else 0 end), 0) as cash_usd,
                 count(*) as event_count
            from cost_events ce
            left join (findings join tracks on tracks.track_id = findings.track_id) t on t.track_id = ce.track_id
           where ce.occurred_at >= ?
             and ce.track_id is not null
           group by ce.track_id
           order by cash_usd desc
           limit ?`,
  });

  const findingRollups: CostFindingRollup[] = [];

  for (const raw of findingResult.rows) {
    const row = raw as Record<string, unknown>;
    const trackId = optionalText(row["track_id"]);

    if (!trackId) {
      continue;
    }

    const artistsJson = optionalText(row["artists_json"]);

    findingRollups.push({
      albumImageUrl: optionalText(row["album_image_url"]),
      artists: artistsJson ? parseArtistsJson(artistsJson) : [],
      cashUsd: toNumber(row["cash_usd"]),
      eventCount: toNumber(row["event_count"]),
      logId: optionalText(row["log_id"]),
      title: optionalText(row["title"]),
      trackId,
    });
  }

  return {
    since,
    steps,
    topFindings: findingRollups,
    totals: { cashUsd: totalCash, subsidizedUsd: totalSubsidized, unpricedCount: totalUnpriced },
    windowDays,
  };
}
