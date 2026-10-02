import { Data, Effect } from "effect";
import { runServerEffect } from "./effect/runtime";
import { getDb } from "./db";

const STALE_MS = 12 * 60 * 60 * 1000;
const FRANKFURTER_URL = "https://api.frankfurter.dev/v2/rates?base=EUR";
const FETCH_TIMEOUT_MS = 4000;

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

class FxTimeout extends Data.TaggedError("FxTimeout") {}

class FxHttpFailed extends Data.TaggedError("FxHttpFailed")<{ status: number }> {}

class FxParseFailed extends Data.TaggedError("FxParseFailed")<{ cause: unknown }> {}

class FxUnreachable extends Data.TaggedError("FxUnreachable")<{ cause: unknown }> {}

function fetchEurRates(): Promise<FxRatesDTO | null> {
  let readingBody = false;

  return runServerEffect(
    Effect.tryPromise({
      catch: (cause) =>
        cause instanceof FxHttpFailed || cause instanceof FxParseFailed
          ? cause
          : readingBody
            ? new FxParseFailed({ cause })
            : new FxUnreachable({ cause }),
      try: async (signal) => {
        const response = await fetch(FRANKFURTER_URL, { signal });

        if (!response.ok) {
          throw new FxHttpFailed({ status: response.status });
        }

        readingBody = true;
        const body = (await response.json()) as unknown;

        if (!Array.isArray(body) || body.length === 0) {
          throw new FxParseFailed({ cause: "Expected exchange rates" });
        }

        const rates: Record<string, number> = {};
        let ratesDate = "";

        for (const entry of body) {
          if (typeof entry !== "object" || entry === null) {
            throw new FxParseFailed({ cause: "Invalid exchange rate" });
          }

          const { date, quote, rate } = entry as {
            date?: unknown;
            quote?: unknown;
            rate?: unknown;
          };

          if (typeof quote === "string" && typeof rate === "number" && Number.isFinite(rate)) {
            rates[quote] = rate;
          }

          if (typeof date === "string") {
            ratesDate = date;
          }
        }

        if (Object.keys(rates).length === 0 || !ratesDate) {
          throw new FxParseFailed({ cause: "Missing exchange rates or date" });
        }

        return { rates, ratesDate };
      },
    }).pipe(
      Effect.timeoutOrElse({
        duration: FETCH_TIMEOUT_MS,
        orElse: () => Effect.fail(new FxTimeout()),
      }),
      Effect.catch((error) =>
        Effect.logWarning("fx.request-failed").pipe(
          Effect.annotateLogs({
            error,
            failure: error._tag,
            ...(error instanceof FxHttpFailed ? { status: error.status } : {}),
          }),
          Effect.as(null),
        ),
      ),
    ),
  );
}

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
