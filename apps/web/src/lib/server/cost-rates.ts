type CostVendor =
  | "anthropic"
  | "apify"
  | "cartesia"
  | "firecrawl"
  | "openrouter"
  | "resend"
  | "self";
type CostUnitType = "characters" | "emails" | "requests" | "seconds" | "tokens";

const SINGLE_UNIT_RATES: Partial<Record<CostVendor, Partial<Record<CostUnitType, number>>>> = {
  cartesia: { characters: 0.000065 },

  firecrawl: { requests: 0.0016 },

  resend: { emails: 0.0009 },
};

export function priceFromRates(
  vendor: CostVendor,
  unitType: CostUnitType,
  quantity: number,
): number | null {
  const perVendor = SINGLE_UNIT_RATES[vendor];

  if (!perVendor) {
    return null;
  }

  const rate = perVendor[unitType];

  if (rate === undefined) {
    return null;
  }

  return rate * quantity;
}

const OPENROUTER_TOKEN_RATES_PER_MTOK: Record<string, { input: number; output: number }> = {
  "anthropic/claude-haiku-4.5": { input: 1, output: 5 },
};

export function priceOpenRouterTokens(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number | null {
  const rate = OPENROUTER_TOKEN_RATES_PER_MTOK[model];

  if (!rate) {
    return null;
  }

  return (promptTokens * rate.input + completionTokens * rate.output) / 1_000_000;
}
