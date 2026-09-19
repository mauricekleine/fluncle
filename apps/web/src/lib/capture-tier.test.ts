import { describe, expect, it } from "vitest";

import { CAPTURE_TIER, CAPTURE_TIER_LABELS, captureTierLabelFor } from "@/lib/capture-tier";

// ONE VOCABULARY, TWO STATIONS. `/admin/catalogue` names a row's rung from its reason kind and
// `/admin/funnel` names the same rungs from the stored integer alone, so the two lookups must agree
// rung for rung — the drift this module exists to prevent is silent and only visible by reading
// both pages side by side.

describe("the capture ladder's vocabulary", () => {
  it("gives every rung a distinct tier and a distinct label", () => {
    const tiers = Object.values(CAPTURE_TIER);
    const labels = Object.values(CAPTURE_TIER_LABELS);

    expect(new Set(tiers).size).toBe(tiers.length);
    expect(new Set(labels).size).toBe(labels.length);
    expect(Object.keys(CAPTURE_TIER).sort()).toEqual(Object.keys(CAPTURE_TIER_LABELS).sort());
  });

  it("names the same rung from the integer as from the kind", () => {
    for (const [kind, tier] of Object.entries(CAPTURE_TIER)) {
      expect(captureTierLabelFor(tier)).toBe(
        CAPTURE_TIER_LABELS[kind as keyof typeof CAPTURE_TIER_LABELS],
      );
    }
  });

  it("keeps the authorized band 0-3 and every withholding negative", () => {
    // The capture worklist's one veto is `capture_priority >= 0` (track-work.ts), so the sign IS
    // the authorization decision and the funnel's backlog buckets can only ever be these four.
    expect([
      CAPTURE_TIER.none,
      CAPTURE_TIER["seed-label"],
      CAPTURE_TIER.label,
      CAPTURE_TIER.artist,
    ]).toEqual([0, 1, 2, 3]);
    expect(CAPTURE_TIER["skipped-label"]).toBeLessThan(0);
    expect(CAPTURE_TIER.unauthorized).toBeLessThan(0);
  });

  it("names the duplicate sentinel rather than printing a bare integer", () => {
    // −2 is set in the sweep, not by the ladder, so it has no rung — but a board that ever shows it
    // must still say something a reader has a meaning for.
    expect(captureTierLabelFor(-2)).toBe("Already in the archive");
  });
});
