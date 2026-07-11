import { describe, expect, it } from "vitest";

import {
  catalogueCaptureVerdict,
  type CatalogueCaptureBudget,
  DEFAULT_DAILY_BYTES,
  DEFAULT_DAILY_TRACKS,
  parseBudgetNumber,
} from "./capture-budget";

// THE BUDGET'S DECISION CORE, at the table. Both functions under test are PURE, so the whole
// judgment the brake makes — is the catalogue half of the capture queue open, and if not, why
// — is provable without a database, a network, and (the point) without downloading a byte.
//
// The integration half (the ledger's SQL, the rolling window, the catalogue scoping) is
// capture-budget.integration.test.ts; the brake's effect on the queue is
// track-work.integration.test.ts.

const budget: CatalogueCaptureBudget = { dailyBytes: 1000, dailyTracks: 10 };

describe("parseBudgetNumber — the failure mode of a budget is a SMALLER budget", () => {
  it("takes a well-formed non-negative integer at its word", () => {
    expect(parseBudgetNumber("250", DEFAULT_DAILY_TRACKS)).toBe(250);
    expect(parseBudgetNumber("  250  ", DEFAULT_DAILY_TRACKS)).toBe(250);
  });

  it("honours 0 — 'capture nothing' is a real setting, not a missing one", () => {
    // This is the case a truthiness check gets wrong (`Number(raw) || fallback` silently
    // turns a deliberate 0 into the default, i.e. into SPENDING). It is a distinct statement
    // from paused: the cap can be raised back without touching the kill switch.
    expect(parseBudgetNumber("0", DEFAULT_DAILY_TRACKS)).toBe(0);
  });

  it("falls back to the conservative DEFAULT on anything malformed — never to unlimited", () => {
    // An unset key (a fresh deploy, an empty preview DB, a lost row), a fat-fingered CLI
    // value, a negative, a float, a word. Every one of them is a budget we cannot trust, and
    // an untrusted budget must read SMALL. There is deliberately no value that means "no cap".
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
    // The kill switch is not "a cap of zero". It is read FIRST and wins over everything, so a
    // paused sweep reports `paused` rather than a cap that also happens to be intact — the
    // operator must never be told the money ran out when in fact HE stopped it.
    const verdict = catalogueCaptureVerdict({
      budget,
      paused: true,
      spend: { bytes: 0, tracks: 0 },
    });

    expect(verdict.open).toBe(false);
    expect(verdict.closedReason).toBe("paused");
    // …and the budget is still fully intact underneath, so resuming needs no other move.
    expect(verdict.remainingTracks).toBe(10);
    expect(verdict.remainingBytes).toBe(1000);
  });

  it("SHUTS at exactly the count cap — `>=`, never `>`", () => {
    // The off-by-one that costs money: at 10 of 10 the budget is SPENT, not "one more allowed".
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
    // A day of unusually fat files (a 12-minute roller, a lossless upload) blows through the
    // GB the count cap was chosen against. The count is untouched and the money is gone, so
    // the byte cap is what stops it.
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
    // The byte cap can overshoot by up to one batch (the size is knowable only AFTER the
    // download). The overshoot must present as "0 left", never as a negative that some later
    // arithmetic could read back as headroom.
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
