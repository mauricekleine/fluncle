import { describe, expect, it } from "vitest";
import { sectorDateISO, sectorDay, sectorRange } from "./log-id-shared";

// The coordinate day-math mints PERMANENT public coordinates: a finding's sector is
// `sectorDay(foundAt)` and the logbook's gap query inverts it with `sectorRange`. The
// whole thing hinges on the epoch and on UTC arithmetic — a refactor to local-time Date
// methods (getFullYear/getDate instead of the UTC epoch subtraction) would silently
// shift a coordinate by a day for anyone west of UTC, corrupting minted identities with
// no error. These checks pin the epoch, the UTC-boundary behavior, the NaN fallback, and
// the sectorDay∘sectorRange inverse so that refactor can't land unnoticed.

describe("sectorDay — the epoch and UTC boundaries", () => {
  it("puts day 0 at 2026-05-30 UTC (the Fluncle epoch)", () => {
    expect(sectorDay("2026-05-30T00:00:00.000Z")).toBe(0);
    expect(sectorDay("2026-05-30T23:59:59.999Z")).toBe(0);
  });

  it("rolls to the next sector exactly at the UTC midnight boundary, not a local one", () => {
    // A T23:59:59Z instant and the T00:00:00Z instant one second later straddle UTC
    // midnight and MUST land on adjacent sector-days. A local-time refactor would move
    // this boundary off UTC for a non-UTC runner, so this is the guard that pins UTC.
    expect(sectorDay("2026-05-31T23:59:59.999Z")).toBe(1);
    expect(sectorDay("2026-06-01T00:00:00.000Z")).toBe(2);
  });

  it("clamps a pre-epoch date to sector 0 (coordinates never go negative)", () => {
    expect(sectorDay("2020-01-01T00:00:00.000Z")).toBe(0);
  });

  it("falls back to 0 on an unparseable date (NaN → 0)", () => {
    expect(sectorDay("not a date")).toBe(0);
    expect(sectorDay("")).toBe(0);
  });
});

describe("sectorRange / sectorDateISO — the inverse of sectorDay", () => {
  it("sectorDay(sectorDateISO(n)) === n (round-trip inverse)", () => {
    for (const sector of [0, 1, 2, 37, 365, 1024]) {
      expect(sectorDay(sectorDateISO(sector))).toBe(sector);
    }
  });

  it("every instant in a sector's half-open range maps back to that sector", () => {
    const sector = 42;
    const { endMs, startMs } = sectorRange(sector);

    // The start instant, one just before the end, and NOT the end itself (half-open).
    expect(sectorDay(new Date(startMs).toISOString())).toBe(sector);
    expect(sectorDay(new Date(endMs - 1).toISOString())).toBe(sector);
    expect(sectorDay(new Date(endMs).toISOString())).toBe(sector + 1);
  });

  it("sectorDateISO(0) is the epoch's UTC midnight", () => {
    expect(sectorDateISO(0)).toBe("2026-05-30T00:00:00.000Z");
  });
});
