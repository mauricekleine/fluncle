import {
  type TursoAttributedDatabase,
  type TursoDatabaseUsage,
  type TursoUsageRateBasis,
  type TursoUsageResource,
  type TursoUsageResourceKey,
  type TursoUsageTotals,
} from "@fluncle/contracts";

export type TursoResourcePrice = {
  included: number;
  kind: "cumulative" | "level";
  unitSize: number;
  usdPerUnit: number;
};

export type TursoPriceTable = {
  baseMonthlyUsdByTimeline: Readonly<Record<string, number>>;
  plan: string;
  resources: Record<TursoUsageResourceKey, TursoResourcePrice>;
  source: string;
  version: string;
};

export const TURSO_RESOURCE_ORDER: readonly TursoUsageResourceKey[] = [
  "rowsWritten",
  "embeddedSyncs",
  "rowsRead",
  "storage",
];

export const TURSO_PRICE_TABLES: Readonly<Record<string, TursoPriceTable>> = {
  "scaler-2026-09": {
    baseMonthlyUsdByTimeline: { monthly: 29, yearly: 24.92 },
    plan: "scaler",
    resources: {
      embeddedSyncs: { included: 24e9, kind: "cumulative", unitSize: 1e9, usdPerUnit: 0.25 },
      rowsRead: { included: 100e9, kind: "cumulative", unitSize: 1e9, usdPerUnit: 0.8 },
      rowsWritten: { included: 100e6, kind: "cumulative", unitSize: 1e6, usdPerUnit: 0.8 },
      storage: { included: 24e9, kind: "level", unitSize: 1e9, usdPerUnit: 0.5 },
    },
    source: "https://turso.tech/pricing",
    version: "scaler-2026-09",
  },
};

export const CURRENT_TURSO_PRICE_TABLE_BY_PLAN: Readonly<Record<string, string>> = {
  scaler: "scaler-2026-09",
};

export const RECENT_RATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export const RECENT_RATE_MIN_SPAN_MS = 12 * 60 * 60 * 1000;

export const CYCLE_TO_DATE_MIN_SPAN_MS = 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

export function priceTableForPlan(plan: string): TursoPriceTable | undefined {
  const version = CURRENT_TURSO_PRICE_TABLE_BY_PLAN[plan.toLowerCase()];

  return version ? TURSO_PRICE_TABLES[version] : undefined;
}

export function resourceUsed(totals: TursoUsageTotals, key: TursoUsageResourceKey): number {
  switch (key) {
    case "embeddedSyncs":
      return totals.bytesSynced;
    case "rowsRead":
      return totals.rowsRead;
    case "rowsWritten":
      return totals.rowsWritten;
    case "storage":
      return totals.storageBytes;
  }
}

export function overageUsd(used: number, price: TursoResourcePrice): number {
  const over = Math.max(0, used - price.included);

  return roundCents((over / price.unitSize) * price.usdPerUnit);
}

export function roundCents(usd: number): number {
  return Math.round(usd * 100) / 100;
}

export type TursoCycle = { cycle: string; endMs: number; startMs: number };

export function billingCycle(atMs: number): TursoCycle {
  const at = new Date(atMs);
  const startMs = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1);
  const endMs = Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1);
  const month = String(at.getUTCMonth() + 1).padStart(2, "0");

  return { cycle: `${at.getUTCFullYear()}-${month}`, endMs, startMs };
}

export type PriorReading = { observedAtMs: number; usage: TursoUsageTotals };

export type RunRate = {
  basis: TursoUsageRateBasis;
  perMs: Record<TursoUsageResourceKey, number>;
  windowHours: number | null;
};

const ZERO_RATE: Record<TursoUsageResourceKey, number> = {
  embeddedSyncs: 0,
  rowsRead: 0,
  rowsWritten: 0,
  storage: 0,
};

export function runRate(
  current: PriorReading,
  priors: readonly PriorReading[],
  cycle: TursoCycle,
): RunRate {
  const baseline = priors
    .filter(
      (prior) =>
        prior.observedAtMs >= cycle.startMs &&
        prior.observedAtMs >= current.observedAtMs - RECENT_RATE_WINDOW_MS &&
        prior.observedAtMs <= current.observedAtMs - RECENT_RATE_MIN_SPAN_MS,
    )
    .sort((a, b) => a.observedAtMs - b.observedAtMs)[0];

  if (baseline) {
    const spanMs = current.observedAtMs - baseline.observedAtMs;

    return {
      basis: "recent",
      perMs: ratesBetween(current.usage, baseline.usage, spanMs),
      windowHours: Math.round((spanMs / (60 * 60 * 1000)) * 10) / 10,
    };
  }

  const cycleSpanMs = current.observedAtMs - cycle.startMs;

  if (cycleSpanMs >= CYCLE_TO_DATE_MIN_SPAN_MS) {
    return {
      basis: "cycle-to-date",
      perMs: ratesBetween(current.usage, ZERO_TOTALS, cycleSpanMs),
      windowHours: Math.round((cycleSpanMs / (60 * 60 * 1000)) * 10) / 10,
    };
  }

  return { basis: "none", perMs: { ...ZERO_RATE }, windowHours: null };
}

const ZERO_TOTALS: TursoUsageTotals = {
  bytesSynced: 0,
  rowsRead: 0,
  rowsWritten: 0,
  storageBytes: 0,
};

function ratesBetween(
  current: TursoUsageTotals,
  baseline: TursoUsageTotals,
  spanMs: number,
): Record<TursoUsageResourceKey, number> {
  const rate = (key: TursoUsageResourceKey) =>
    Math.max(0, resourceUsed(current, key) - resourceUsed(baseline, key)) / spanMs;

  return {
    embeddedSyncs: rate("embeddedSyncs"),
    rowsRead: rate("rowsRead"),
    rowsWritten: rate("rowsWritten"),
    storage: 0,
  };
}

export type PricedReading = {
  baseUsd: number | null;
  databases: TursoAttributedDatabase[];
  overageUsd: number;
  priced: boolean;
  priceSource: string;
  priceTableVersion: string;
  projectedBillUsd: number | null;
  projectedOverageUsd: number;
  rateBasis: TursoUsageRateBasis;
  rateWindowHours: number | null;
  resources: TursoUsageResource[];
};

export function priceReading(input: {
  cycle: TursoCycle;
  databases: readonly TursoDatabaseUsage[];
  observedAtMs: number;
  overagesEnabled: boolean;
  plan: string;
  priors: readonly PriorReading[];
  timeline: string | null;
  usage: TursoUsageTotals;
}): PricedReading {
  const table = priceTableForPlan(input.plan);
  const rate = runRate(
    { observedAtMs: input.observedAtMs, usage: input.usage },
    input.priors,
    input.cycle,
  );
  const remainingMs = Math.max(0, input.cycle.endMs - input.observedAtMs);
  const resources: TursoUsageResource[] = [];

  for (const key of TURSO_RESOURCE_ORDER) {
    const used = resourceUsed(input.usage, key);
    const price = table?.resources[key];
    const projectedUsed = used + rate.perMs[key] * remainingMs;
    const charge = (amount: number) =>
      price && input.overagesEnabled ? overageUsd(amount, price) : 0;

    resources.push({
      dailyRate: rate.perMs[key] * DAY_MS,
      included: price?.included ?? 0,
      key,
      overageUsd: charge(used),
      projectedOverageUsd: charge(projectedUsed),
      projectedUsed,
      unitSize: price?.unitSize ?? 1,
      usdPerUnit: price?.usdPerUnit ?? 0,
      used,
    });
  }

  const overage = roundCents(resources.reduce((sum, resource) => sum + resource.overageUsd, 0));
  const projectedOverage = roundCents(
    resources.reduce((sum, resource) => sum + resource.projectedOverageUsd, 0),
  );
  const baseUsd = basePrice(table, input.timeline);

  return {
    baseUsd,
    databases: attributeDatabases(input.databases, input.usage, resources),
    overageUsd: overage,
    priceSource: table?.source ?? "",
    priceTableVersion: table?.version ?? "unpriced",
    priced: table !== undefined,
    projectedBillUsd: baseUsd === null ? null : roundCents(baseUsd + projectedOverage),
    projectedOverageUsd: projectedOverage,
    rateBasis: rate.basis,
    rateWindowHours: rate.windowHours,
    resources,
  };
}

export function basePrice(
  table: TursoPriceTable | undefined,
  timeline: string | null,
): number | null {
  if (!table || timeline === null) {
    return null;
  }

  return table.baseMonthlyUsdByTimeline[timeline.toLowerCase()] ?? null;
}

export function attributeDatabases(
  databases: readonly TursoDatabaseUsage[],
  usage: TursoUsageTotals,
  resources: readonly TursoUsageResource[],
): TursoAttributedDatabase[] {
  return databases
    .map((database) => {
      const attributed = resources.reduce((sum, resource) => {
        const total = resourceUsed(usage, resource.key);

        if (total <= 0 || resource.overageUsd <= 0) {
          return sum;
        }

        return sum + resource.overageUsd * (resourceUsed(database, resource.key) / total);
      }, 0);

      return { ...database, attributedOverageUsd: roundCents(attributed) };
    })
    .sort(
      (a, b) =>
        b.attributedOverageUsd - a.attributedOverageUsd ||
        b.rowsWritten - a.rowsWritten ||
        a.name.localeCompare(b.name),
    );
}

export function alertLevels(thresholdUsd: number): number[] {
  return [roundCents(thresholdUsd), roundCents(thresholdUsd * 2)];
}

export function crossedAlertLevels(thresholdUsd: number, projectedOverageUsd: number): number[] {
  return alertLevels(thresholdUsd).filter((level) => projectedOverageUsd >= level);
}
