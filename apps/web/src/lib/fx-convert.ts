export type CurrencyTotals = Array<[currency: string, cents: number]>;

export type EurConversion = {
  eurCents: number;

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
