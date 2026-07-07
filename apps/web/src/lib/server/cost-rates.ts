// The cost-ledger rate map (COST-01, RFC §4). A committed, world-readable TS map
// of per-vendor, per-unit USD rates for the vendors that return NO dollar of their
// own, so the Worker can price a `cost_events` row from a raw count.
//
// EDITABLE CONFIG, NOT AUTHORITATIVE. These are published July-2026 list prices —
// legitimate config, never a secret (AGENTS.md bans secret VALUES + the secret
// MAP; a public list price grants nothing). They drift monthly; edit them here.
// The AUTHORITATIVE spend lives in the DB (`cost_events.estimated_usd`), frozen at
// the price-of-record when each row was written — editing a rate never rewrites
// history.
//
// Two seams live here:
//   - `priceFromRates(vendor, unitType, quantity)` — the single-count vendors
//     (Cartesia characters, Firecrawl searches, Resend emails). A rate MISS
//     returns `null` (UNPRICED — surfaced as "—", never laundered to $0, which is
//     indistinguishable from a genuinely-free row).
//   - `priceOpenRouterTokens(model, promptTokens, completionTokens)` — the
//     OpenRouter context-distil pass-through, which needs the in/out token split a
//     single `quantity` cannot carry, so it prices at the call site and passes the
//     result as the event's `usd`.
//
// Deliberately NOT priced here:
//   - `anthropic` rows store the envelope's OWN `total_cost_usd` (computed by the
//     Claude CLI at the actual model's actual rate — strictly better than a stale
//     local multiply, and API-equivalent under the subscription anyway).
//   - `self` (on-box compute) is UTILIZATION-ONLY (Decision B): the box bill is
//     fixed whether it processes 10 findings or 1000, so there is no honest
//     marginal `$/second`. `self` rows carry `estimatedUsd = null` and render as
//     seconds / box-minutes, never as cash. The seam is defined (below) but prices
//     no dollar on purpose.

// Mirrors the `cost_events` typed-enum columns (schema.ts) — the same narrowing,
// kept local so this config file has no schema import cycle.
type CostVendor =
  | "anthropic"
  | "apify"
  | "cartesia"
  | "firecrawl"
  | "openrouter"
  | "resend"
  | "self";
type CostUnitType = "characters" | "emails" | "requests" | "seconds" | "tokens";

// The single-count rate map: vendor → unit → USD per ONE unit. Only the
// no-dollar-of-their-own vendors appear; everything absent (anthropic, openrouter,
// self, apify) is priced elsewhere or utilization-only, so a lookup returns null.
const SINGLE_UNIT_RATES: Partial<Record<CostVendor, Partial<Record<CostUnitType, number>>>> = {
  // Cartesia Sonic TTS, per character of the sanitized transcript. Cartesia bills
  // credits (~$0.03/min of audio); at a ~0.78-speed read this maps to roughly this
  // per-character figure. Seed — retune against cartesia.ai/pricing.
  cartesia: { characters: 0.000065 },
  // Firecrawl search, per call (~2 credits / 10 results ≈ $0.0016). One search per
  // finding when the context queue fires. Seed — retune against firecrawl.dev/pricing.
  firecrawl: { requests: 0.0016 },
  // Resend, per recipient email (~$0.0009 Pro overage). Seed — resend.com/pricing.
  resend: { emails: 0.0009 },
};

/**
 * Price a single-count cost row (Cartesia characters, Firecrawl searches, Resend
 * emails) from the editable rate map. Returns `rate × quantity`, or `null` on a
 * rate MISS (an unknown vendor or unit) — the caller stores that as UNPRICED, never
 * as $0. `anthropic`/`openrouter` tokens and `self` seconds intentionally miss here
 * (they are priced by their own paths, or utilization-only).
 */
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

// The OpenRouter context-distil model rates, USD per 1,000,000 tokens, split
// in/out. Keyed by the model string OpenRouter returns; the box default is
// `anthropic/claude-haiku-4.5` (observation.ts `DEFAULT_CONTEXT_DISTIL_MODEL`).
// Seed prices — retune against openrouter.ai/models.
const OPENROUTER_TOKEN_RATES_PER_MTOK: Record<string, { input: number; output: number }> = {
  "anthropic/claude-haiku-4.5": { input: 1, output: 5 },
};

/**
 * Price an OpenRouter chat completion from its `usage` in/out token split. Returns
 * the USD (prompt × input-rate + completion × output-rate, per-1M normalized), or
 * `null` for a model not in the seed map (UNPRICED — never $0). This is the one
 * `cash` LLM call; the token split is why it prices here (at the call site) and
 * passes the result as the row's `usd`, rather than through the single-count
 * `priceFromRates`.
 */
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
