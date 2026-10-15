import { describe, expect, it } from "vitest";

import { listedArtistWhere } from "./artist-visibility";
import { leadCentroidArtistSql, SONIC_SEED_SELECT, sonicSeedFlag } from "./sonic-seed";

describe("sonicSeedFlag", () => {
  it("leaves the flag unset when the row never selected it", () => {
    expect(sonicSeedFlag(null)).toBeUndefined();
    expect(sonicSeedFlag(undefined)).toBeUndefined();
  });

  it("reads SQLite's integer boolean in every shape the driver returns", () => {
    expect(sonicSeedFlag(1)).toBe(true);
    expect(sonicSeedFlag(1n)).toBe(true);
    expect(sonicSeedFlag("1")).toBe(true);
    expect(sonicSeedFlag(0)).toBe(false);
    expect(sonicSeedFlag(0n)).toBe(false);
    expect(sonicSeedFlag("0")).toBe(false);
  });
});

describe("the sonic seed select", () => {
  it("lands in the sonic_seed column the track readers map", () => {
    expect(SONIC_SEED_SELECT.trimEnd().endsWith("as sonic_seed")).toBe(true);
    expect(SONIC_SEED_SELECT).toContain(leadCentroidArtistSql("tracks.track_id"));
  });

  it("seeds only from a listed lead artist", () => {
    const sql = leadCentroidArtistSql("?");

    expect(sql).toContain("seed_ta.track_id = ?");
    expect(sql).toContain("seed_ta.role is null");
    expect(sql).toContain(listedArtistWhere("seed_a"));
  });
});
