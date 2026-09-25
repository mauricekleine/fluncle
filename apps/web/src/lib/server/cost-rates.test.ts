import { describe, expect, it } from "vitest";
import { priceFromRates, priceOpenRouterTokens } from "./cost-rates";

describe("priceFromRates (single-count vendors)", () => {
  it("prices a known Cartesia character payload (rate × quantity)", () => {
    expect(priceFromRates("cartesia", "characters", 1000)).toBeCloseTo(0.065, 10);
  });

  it("prices a known Firecrawl search (per request)", () => {
    expect(priceFromRates("firecrawl", "requests", 1)).toBeCloseTo(0.0016, 10);

    expect(priceFromRates("firecrawl", "requests", 10)).toBeCloseTo(0.016, 10);
  });

  it("prices a known Resend email payload (per email)", () => {
    expect(priceFromRates("resend", "emails", 100)).toBeCloseTo(0.09, 10);
  });

  it("returns NULL (unpriced, never 0) for an unknown vendor", () => {
    expect(priceFromRates("anthropic", "tokens", 100)).toBeNull();

    expect(priceFromRates("self", "seconds", 3600)).toBeNull();
    expect(priceFromRates("apify", "requests", 5)).toBeNull();
  });

  it("returns NULL for a known vendor but an unpriced unit", () => {
    expect(priceFromRates("cartesia", "tokens", 100)).toBeNull();
  });
});

describe("priceOpenRouterTokens (in/out split)", () => {
  it("prices a known model from its in/out token split", () => {
    expect(priceOpenRouterTokens("anthropic/claude-haiku-4.5", 1_000_000, 1_000_000)).toBeCloseTo(
      6,
      10,
    );

    expect(priceOpenRouterTokens("anthropic/claude-haiku-4.5", 100_000, 20_000)).toBeCloseTo(
      0.2,
      10,
    );
  });

  it("returns NULL (unpriced, never 0) for a model not in the seed map", () => {
    expect(priceOpenRouterTokens("some/unknown-model", 100, 100)).toBeNull();
  });
});
