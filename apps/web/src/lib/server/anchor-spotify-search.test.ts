import { describe, expect, it } from "vitest";

import { isWithinFrontierRefreshWindow } from "./anchor-spotify-search";

// The Friday-Frontier-refresh window is a pure, timezone-correct predicate — the belt-and-suspenders
// guard that keeps the dark Spotify anchor rungs off the shared official app during the week's heaviest
// user-facing Spotify window. It reads the weekday + hour in Amsterdam time (DST handled by `Intl`), so
// it is proven here against fixed UTC instants. July 2026 is CEST (UTC+2), so Amsterdam = UTC + 2h.
// (The dark flag itself is default-OFF and is exercised end-to-end in anchor-spotify-search.integration.test.ts.)

describe("isWithinFrontierRefreshWindow — Friday 06:00–09:00 Amsterdam", () => {
  it("is INSIDE the window at Friday 07:00 Amsterdam (05:00 UTC in CEST)", () => {
    expect(isWithinFrontierRefreshWindow(new Date("2026-07-24T05:00:00Z"))).toBe(true);
  });

  it("is INSIDE at the last minute before the exclusive end (Friday 08:59 Amsterdam)", () => {
    expect(isWithinFrontierRefreshWindow(new Date("2026-07-24T06:59:00Z"))).toBe(true);
  });

  it("is OUTSIDE just before the start (Friday 05:59 Amsterdam)", () => {
    expect(isWithinFrontierRefreshWindow(new Date("2026-07-24T03:59:00Z"))).toBe(false);
  });

  it("is OUTSIDE at the exclusive end hour (Friday 09:00 Amsterdam)", () => {
    expect(isWithinFrontierRefreshWindow(new Date("2026-07-24T07:00:00Z"))).toBe(false);
  });

  it("is OUTSIDE on Thursday at the same wall-clock hour", () => {
    expect(isWithinFrontierRefreshWindow(new Date("2026-07-23T05:00:00Z"))).toBe(false);
  });

  it("is OUTSIDE on Saturday at the same wall-clock hour", () => {
    expect(isWithinFrontierRefreshWindow(new Date("2026-07-25T05:00:00Z"))).toBe(false);
  });
});
