import { type CostEventInput } from "@fluncle/contracts/orpc";
import { parseArtistsJson } from "./artist-names";
import { priceFromRates } from "./cost-rates";
import { getDb } from "./db";
import { logEvent } from "./log";

export type CostCaptureContext = { logId?: string | null; trackId?: string | null };

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

export function resolveEstimatedUsd(event: CostEventInput): number | null {
  if (typeof event.usd === "number") {
    return event.usd;
  }

  return priceFromRates(event.vendor, event.unitType, event.quantity);
}

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

export async function captureCostEvents(events: CostEventInput[]): Promise<void> {
  try {
    await insertCostEvents(events);
  } catch (error) {
    logEvent("error", "costs.ledger-write-failed", { error });
  }
}

export type CostStepRollup = {
  cashUsd: number;
  eventCount: number;
  step: string;
  subsidizedUsd: number;
  unpricedCount: number;
};

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
  since: string;
  steps: CostStepRollup[];
  topFindings: CostFindingRollup[];
  totals: {
    cashUsd: number;
    subsidizedUsd: number;
    unpricedCount: number;
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

export async function getCostInsights(
  options: { topFindings?: number; windowDays?: number } = {},
): Promise<CostInsights> {
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const topFindings = options.topFindings ?? DEFAULT_TOP_FINDINGS;
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const db = await getDb();

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
