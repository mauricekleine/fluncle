import { describe, expect, it } from "vitest";

import {
  catalogueCaptureVerdict,
  type CatalogueCaptureBudget,
  DEFAULT_DAILY_BYTES,
  DEFAULT_DAILY_TRACKS,
  parseBudgetNumber,
} from "./capture-budget";

const budget: CatalogueCaptureBudget = { dailyBytes: 1000, dailyTracks: 10 };

describe("parseBudgetNumber — the failure mode of a budget is a SMALLER budget", () => {
  it("takes a well-formed non-negative integer at its word", () => {
    expect(parseBudgetNumber("250", DEFAULT_DAILY_TRACKS)).toBe(250);
    expect(parseBudgetNumber("  250  ", DEFAULT_DAILY_TRACKS)).toBe(250);
  });

  it("honours 0 — 'capture nothing' is a real setting, not a missing one", () => {
    expect(parseBudgetNumber("0", DEFAULT_DAILY_TRACKS)).toBe(0);
  });

  it("falls back to the conservative DEFAULT on anything malformed — never to unlimited", () => {
    for (const raw of [undefined, "", "   ", "-1", "12.5", "1e9", "lots", "Infinity", "NaN"]) {
      expect(parseBudgetNumber(raw, DEFAULT_DAILY_TRACKS)).toBe(DEFAULT_DAILY_TRACKS);
    }

    expect(parseBudgetNumber(undefined, DEFAULT_DAILY_BYTES)).toBe(DEFAULT_DAILY_BYTES);
  });
});

describe("catalogueCaptureVerdict — the kill switch, then the caps", () => {
  it("is OPEN when nothing is paused and neither cap is reached", () => {
    const verdict = catalogueCaptureVerdict({
      budget,
      paused: false,
      spend: { bytes: 400, tracks: 4 },
    });

    expect(verdict).toEqual({
      closedReason: null,
      open: true,
      remainingBytes: 600,
      remainingTracks: 6,
    });
  });

  it("is SHUT while paused — whatever the budget says", () => {
    const verdict = catalogueCaptureVerdict({
      budget,
      paused: true,
      spend: { bytes: 0, tracks: 0 },
    });

    expect(verdict.open).toBe(false);
    expect(verdict.closedReason).toBe("paused");

    expect(verdict.remainingTracks).toBe(10);
    expect(verdict.remainingBytes).toBe(1000);
  });

  it("SHUTS at exactly the count cap — `>=`, never `>`", () => {
    expect(
      catalogueCaptureVerdict({ budget, paused: false, spend: { bytes: 0, tracks: 9 } }).open,
    ).toBe(true);

    const spent = catalogueCaptureVerdict({
      budget,
      paused: false,
      spend: { bytes: 0, tracks: 10 },
    });

    expect(spent.open).toBe(false);
    expect(spent.closedReason).toBe("tracks_spent");
    expect(spent.remainingTracks).toBe(0);
  });

  it("SHUTS on the BYTE cap even with count left — the backstop the count cannot see", () => {
    const verdict = catalogueCaptureVerdict({
      budget,
      paused: false,
      spend: { bytes: 1000, tracks: 2 },
    });

    expect(verdict.open).toBe(false);
    expect(verdict.closedReason).toBe("bytes_spent");
    expect(verdict.remainingTracks).toBe(8);
    expect(verdict.remainingBytes).toBe(0);
  });

  it("reports the COUNT cap first when both are spent — the enforceable one is the story", () => {
    const verdict = catalogueCaptureVerdict({
      budget,
      paused: false,
      spend: { bytes: 5000, tracks: 50 },
    });

    expect(verdict.closedReason).toBe("tracks_spent");
  });

  it("clamps `remaining` at 0 — an overshoot never reads as budget to spend", () => {
    const verdict = catalogueCaptureVerdict({
      budget,
      paused: false,
      spend: { bytes: 1400, tracks: 12 },
    });

    expect(verdict.remainingBytes).toBe(0);
    expect(verdict.remainingTracks).toBe(0);
    expect(verdict.open).toBe(false);
  });

  it("honours a cap of 0 — capture nothing, and say so as a spent cap", () => {
    const verdict = catalogueCaptureVerdict({
      budget: { dailyBytes: 0, dailyTracks: 0 },
      paused: false,
      spend: { bytes: 0, tracks: 0 },
    });

    expect(verdict.open).toBe(false);
    expect(verdict.closedReason).toBe("tracks_spent");
  });
});
