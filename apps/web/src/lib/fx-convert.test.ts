import { describe, expect, it } from "vitest";
import { convertToEurCents } from "./fx-convert";

// EUR→currency rates (Frankfurter/ECB base EUR): 1 EUR = 1.20 USD, 1 EUR = 0.86 GBP.
const RATES = { GBP: 0.86, USD: 1.2 };

describe("convertToEurCents", () => {
  it("passes EUR through 1:1", () => {
    expect(convertToEurCents([["EUR", 14547]], {})).toEqual({ complete: true, eurCents: 14547 });
  });

  it("converts a foreign currency back to EUR by dividing by its rate", () => {
    // $108.00 at 1.20 → €90.00
    expect(convertToEurCents([["USD", 10800]], RATES)).toEqual({ complete: true, eurCents: 9000 });
  });

  it("sums a mixed-currency ledger into one EUR figure", () => {
    // €145.47 + ($108.00 → €90.00) = €235.47
    const result = convertToEurCents(
      [
        ["EUR", 14547],
        ["USD", 10800],
      ],
      RATES,
    );
    expect(result).toEqual({ complete: true, eurCents: 23547 });
  });

  it("rounds to whole cents", () => {
    // $100.00 at 1.1778 → €84.90 (8490.40… rounds to 8490)
    expect(convertToEurCents([["USD", 10000]], { USD: 1.1778 })).toEqual({
      complete: true,
      eurCents: 8490,
    });
  });

  it("marks the total incomplete (and drops the line) when a rate is missing", () => {
    // GBP has no rate → not guessed; the EUR part still sums, complete flips false.
    expect(
      convertToEurCents(
        [
          ["EUR", 5000],
          ["GBP", 1000],
        ],
        { USD: 1.2 },
      ),
    ).toEqual({ complete: false, eurCents: 5000 });
  });

  it("ignores a non-positive rate rather than dividing by zero", () => {
    expect(convertToEurCents([["USD", 10800]], { USD: 0 })).toEqual({
      complete: false,
      eurCents: 0,
    });
  });
});
