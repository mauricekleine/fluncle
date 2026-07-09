// Foreign-exchange reference rates for the Costs ledger's single aggregate figure.
//
// Source: Frankfurter (https://frankfurter.dev) — a free, KEYLESS API over the ECB's
// daily reference rates. We only ever need it to render ONE "what you pay today" total
// in EUR; the individual lines keep their own fixed-price currency.
//
// READ-THROUGH DAILY CACHE: the rate is stored in the `exchange_rates` singleton row
// (base EUR) and reused until it is >12h old, at which point the next read refreshes it.
// The Costs page is admin-only + low-traffic, so this naturally hits the API at most a
// couple of times a day. BEST-EFFORT: a fetch failure falls back to the last cached rate
// (even if stale); with no cache at all it returns null and the page shows the native
// per-currency breakdown instead of a converted total. Never throws.

import { getDb } from "./db";

// The ECB publishes once per working day; refresh a cache older than this. Keeps the
// external call to ~once/day while self-healing if a fetch was missed.
const STALE_MS = 12 * 60 * 60 * 1000;
const FRANKFURTER_URL = "https://api.frankfurter.dev/v2/rates?base=EUR";
const FETCH_TIMEOUT_MS = 4000;

// EUR→currency rates (e.g. { USD: 1.18 }) plus the ECB date they are for.
export type FxRatesDTO = {
  rates: Record<string, number>;
  ratesDate: string;
};

type StoredRates = FxRatesDTO & { fetchedAt: string };

function parseRow(row: Record<string, unknown>): StoredRates | null {
  const ratesJson = row["rates_json"];
  const ratesDate = row["rates_date"];
  const fetchedAt = row["fetched_at"];

  if (
    typeof ratesJson !== "string" ||
    typeof ratesDate !== "string" ||
    typeof fetchedAt !== "string"
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(ratesJson) as unknown;

    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const rates: Record<string, number> = {};

    for (const [currency, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        rates[currency] = value;
      }
    }

    return { fetchedAt, rates, ratesDate };
  } catch {
    return null;
  }
}

// Hit Frankfurter once. Returns null on any failure (network, timeout, non-OK, malformed
// body) — the caller decides whether to fall back to a stale cache.
async function fetchEurRates(): Promise<FxRatesDTO | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(FRANKFURTER_URL, { signal: controller.signal });

    if (!response.ok) {
      return null;
    }

    // v2/rates returns an array of { date, base, quote, rate } rows.
    const body = (await response.json()) as unknown;

    if (!Array.isArray(body) || body.length === 0) {
      return null;
    }

    const rates: Record<string, number> = {};
    let ratesDate = "";

    for (const entry of body) {
      const quote = (entry as { quote?: unknown }).quote;
      const rate = (entry as { rate?: unknown }).rate;
      const date = (entry as { date?: unknown }).date;

      if (typeof quote === "string" && typeof rate === "number" && Number.isFinite(rate)) {
        rates[quote] = rate;
      }

      if (typeof date === "string") {
        ratesDate = date;
      }
    }

    if (Object.keys(rates).length === 0 || !ratesDate) {
      return null;
    }

    return { rates, ratesDate };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// The public read: cached EUR rates, refreshed at most ~once/day, best-effort. Returns
// null only when there is no cache AND the live fetch fails — the page then shows the
// per-currency breakdown with no converted total.
export async function getEurRates(): Promise<FxRatesDTO | null> {
  const db = await getDb();

  const existing = await db.execute({
    args: [],
    sql: "select rates_json, rates_date, fetched_at from exchange_rates where base = 'EUR'",
  });

  const cached = existing.rows[0] ? parseRow(existing.rows[0] as Record<string, unknown>) : null;
  const fresh = cached !== null && Date.now() - Date.parse(cached.fetchedAt) < STALE_MS;

  if (cached && fresh) {
    return { rates: cached.rates, ratesDate: cached.ratesDate };
  }

  const fetched = await fetchEurRates();

  if (!fetched) {
    // Fall back to the stale cache if we have one; otherwise no total.
    return cached ? { rates: cached.rates, ratesDate: cached.ratesDate } : null;
  }

  const fetchedAt = new Date().toISOString();

  await db.execute({
    args: [JSON.stringify(fetched.rates), fetched.ratesDate, fetchedAt],
    sql: `insert into exchange_rates (base, rates_json, rates_date, fetched_at)
            values ('EUR', ?, ?, ?)
            on conflict(base) do update set
              rates_json = excluded.rates_json,
              rates_date = excluded.rates_date,
              fetched_at = excluded.fetched_at`,
  });

  return fetched;
}
