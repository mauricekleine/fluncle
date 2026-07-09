// Pure currency math for the Costs ledger's aggregate — no IO, no server imports, so it
// is safe to run in the browser bundle AND trivially unit-testable. The rate map is
// EUR→currency (Frankfurter/ECB base EUR), so an amount in currency X converts back to
// EUR by DIVIDING by its rate. EUR passes through 1:1.

export type CurrencyTotals = Array<[currency: string, cents: number]>;

export type EurConversion = {
  // The summed total in EUR cents. Partial when `complete` is false (a currency with no
  // known rate is dropped from the sum rather than guessed).
  eurCents: number;
  // Every non-EUR currency had a usable rate → the figure is a faithful total.
  complete: boolean;
};

export function convertToEurCents(
  perCurrency: CurrencyTotals,
  rates: Record<string, number>,
): EurConversion {
  let eurCents = 0;
  let complete = true;

  for (const [currency, cents] of perCurrency) {
    if (currency === "EUR") {
      eurCents += cents;
      continue;
    }

    const rate = rates[currency];

    if (typeof rate === "number" && rate > 0) {
      eurCents += Math.round(cents / rate);
    } else {
      complete = false;
    }
  }

  return { complete, eurCents };
}
