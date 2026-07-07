import { describe, expect, it } from "vitest";
import { priceFromRates, priceOpenRouterTokens } from "./cost-rates";

// COST-01 pricing seam. The rates are editable config, so these pin the DOCUMENTED
// seeds (a rate change is a deliberate test update) AND the load-bearing invariant:
// a rate MISS returns `null` (UNPRICED), never 0 — a null keeps a missing rate
// visible instead of laundering it to a fake-free $0.

describe("priceFromRates (single-count vendors)", () => {
  it("prices a known Cartesia character payload (rate × quantity)", () => {
    // 0.000065/char × 1000 = 0.065.
    expect(priceFromRates("cartesia", "characters", 1000)).toBeCloseTo(0.065, 10);
  });

  it("prices a known Firecrawl search (per request)", () => {
    expect(priceFromRates("firecrawl", "requests", 1)).toBeCloseTo(0.0016, 10);
    // Linear in quantity.
    expect(priceFromRates("firecrawl", "requests", 10)).toBeCloseTo(0.016, 10);
  });

  it("prices a known Resend email payload (per email)", () => {
    expect(priceFromRates("resend", "emails", 100)).toBeCloseTo(0.09, 10);
  });

  it("returns NULL (unpriced, never 0) for an unknown vendor", () => {
    // anthropic prices from its own envelope, not this map.
    expect(priceFromRates("anthropic", "tokens", 100)).toBeNull();
    // self is utilization-only (Decision B) — no marginal $.
    expect(priceFromRates("self", "seconds", 3600)).toBeNull();
    expect(priceFromRates("apify", "requests", 5)).toBeNull();
  });

  it("returns NULL for a known vendor but an unpriced unit", () => {
    // Cartesia has a character rate, not a token rate.
    expect(priceFromRates("cartesia", "tokens", 100)).toBeNull();
  });
});

describe("priceOpenRouterTokens (in/out split)", () => {
  it("prices a known model from its in/out token split", () => {
    // Haiku 4.5 seed: $1/M in, $5/M out. 1M in + 1M out = $6.
    expect(priceOpenRouterTokens("anthropic/claude-haiku-4.5", 1_000_000, 1_000_000)).toBeCloseTo(
      6,
      10,
    );
    // 100k in ($0.10) + 20k out ($0.10) = $0.20.
    expect(priceOpenRouterTokens("anthropic/claude-haiku-4.5", 100_000, 20_000)).toBeCloseTo(
      0.2,
      10,
    );
  });

  it("returns NULL (unpriced, never 0) for a model not in the seed map", () => {
    expect(priceOpenRouterTokens("some/unknown-model", 100, 100)).toBeNull();
  });
});
