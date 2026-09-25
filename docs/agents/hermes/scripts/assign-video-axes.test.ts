import { describe, expect, test } from "bun:test";

import {
  ASSIGNED_REGISTER,
  assignGrain,
  assignPaletteAvoid,
  BAKED_GRAIN_FAMILIES,
  computeAssignment,
  type LedgerEntry,
  parseLedger,
  toEnvLines,
} from "./assign-video-axes";

const entry = (grain: string, register?: string, palette?: string): LedgerEntry => ({
  grain,
  ...(register ? { register } : {}),
  ...(palette ? { palette } : {}),
});

describe("assignGrain — LRU excluding the last 3", () => {
  test("never picks a grain used in the last 3 renders", () => {
    const entries = [entry("grainHalftone"), entry("grainDither"), entry("grainCoarseSilver")];
    const grain = assignGrain(entries);
    expect(["grainHalftone", "grainDither", "grainCoarseSilver"]).not.toContain(grain);
    expect(BAKED_GRAIN_FAMILIES as readonly string[]).toContain(grain);
  });

  test("prefers a never-used family over one used long ago", () => {
    const entries = [
      entry("grainHalftone"),
      entry("grainDither"),
      entry("grainCoarseSilver"),
      entry("grainFineEmulsion"),
    ];
    const grain = assignGrain(entries);

    expect(grain).toBe("grainChemicalDye");
  });

  test("among used families, picks the least-recently-used", () => {
    const entries = [
      entry("grainFineEmulsion"),
      entry("grainCoarseSilver"),
      entry("grainHalftone"),
      entry("grainChemicalDye"),
      entry("grainDither"),
      entry("grainVhsScanline"),
    ];
    expect(assignGrain(entries)).toBe("grainVhsScanline");
  });

  test("empty ledger falls back to the first baked family, deterministically", () => {
    expect(assignGrain([])).toBe(BAKED_GRAIN_FAMILIES[0]);
  });

  test("unions ledger-only grain values into the universe", () => {
    const entries = [
      entry("grainHalftone"),
      entry("grainDither"),
      entry("grainCoarseSilver"),
      entry("grainFineEmulsion"),
      entry("grainChemicalDye"),
      entry("grainVhsScanline"),
      entry("grainNovelExperimental"),
    ];

    expect(assignGrain(entries)).toBe("grainNovelExperimental");
  });
});

describe("register — representational is a prerequisite (operator ruling 2026-07-20)", () => {
  test("every assignment is representational regardless of the recent window", () => {
    const abstractHeavy = Array.from({ length: 12 }, () => entry("grainDither", "abstract"));
    const repHeavy = Array.from({ length: 12 }, () =>
      entry("grainFineEmulsion", "representational"),
    );
    expect(computeAssignment(abstractHeavy).register).toBe("representational");
    expect(computeAssignment(repHeavy).register).toBe("representational");
    expect(computeAssignment([]).register).toBe("representational");
    expect(ASSIGNED_REGISTER).toBe("representational");
  });
});

describe("assignPaletteAvoid", () => {
  test("data-driven: names a dominant palette bucket as worn", () => {
    const entries = [
      entry("grainFineEmulsion", "abstract", "amber-warm"),
      entry("grainCoarseSilver", "representational", "amber-warm"),
      entry("grainDither", "framed", "teal-cool"),
    ];
    const avoid = assignPaletteAvoid(entries);
    expect(avoid).toContain("amber-warm");
  });

  test("fallback: names the amber/halftone basin when a halftone grain is recent", () => {
    const entries = [
      entry("grainHalftone", "representational"),
      entry("grainCoarseSilver", "representational"),
      entry("grainFineEmulsion", "abstract"),
    ];
    const avoid = assignPaletteAvoid(entries);
    expect(avoid).toContain("amber");
  });

  test("fallback: ≥2 of the last 3 sharing a grain family is worn", () => {
    const entries = [
      entry("grainCoarseSilver", "representational"),
      entry("grainCoarseSilver", "abstract"),
      entry("grainFineEmulsion", "framed"),
    ];
    expect(assignPaletteAvoid(entries)).not.toBeNull();
  });

  test("returns null when the recent window is already varied", () => {
    const entries = [
      entry("grainFineEmulsion", "abstract"),
      entry("grainCoarseSilver", "representational"),
      entry("grainVhsScanline", "framed"),
    ];
    expect(assignPaletteAvoid(entries)).toBeNull();
  });
});

describe("parseLedger — fail-open on malformed input", () => {
  test("accepts the { ok, vehicles: [...] } wrapper", () => {
    const raw = JSON.stringify({ ok: true, vehicles: [entry("grainDither", "abstract")] });
    const parsed = parseLedger(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.length).toBe(1);
  });

  test("accepts a bare array", () => {
    const raw = JSON.stringify([entry("grainDither")]);
    expect(parseLedger(raw)?.length).toBe(1);
  });

  test("returns null on invalid JSON", () => {
    expect(parseLedger("not json {")).toBeNull();
  });

  test("returns null when neither an array nor a vehicles wrapper", () => {
    expect(parseLedger(JSON.stringify({ ok: true }))).toBeNull();
  });

  test("drops null/non-object entries", () => {
    const raw = JSON.stringify({ vehicles: [null, 3, entry("grainDither")] });
    expect(parseLedger(raw)?.length).toBe(1);
  });
});

describe("computeAssignment + toEnvLines", () => {
  test("emits grain and register lines always, palette-avoid only when worn", () => {
    const entries = [
      entry("grainHalftone", "representational", "amber-warm"),
      entry("grainHalftone", "representational", "amber-warm"),
      entry("grainCoarseSilver", "representational"),
    ];
    const lines = toEnvLines(computeAssignment(entries));
    expect(lines).toContain("FLUNCLE_VIDEO_GRAIN='");
    expect(lines).toContain("FLUNCLE_VIDEO_REGISTER='");
    expect(lines).toContain("FLUNCLE_VIDEO_PALETTE_AVOID='");

    for (const line of lines.split("\n")) {
      expect(line).toMatch(/^FLUNCLE_VIDEO_[A-Z_]+='[^']*'$/);
    }
  });

  test("omits the palette-avoid line when the window is varied", () => {
    const entries = [
      entry("grainFineEmulsion", "abstract"),
      entry("grainCoarseSilver", "representational"),
      entry("grainVhsScanline", "framed"),
    ];
    const lines = toEnvLines(computeAssignment(entries));
    expect(lines).not.toContain("FLUNCLE_VIDEO_PALETTE_AVOID");
  });
});
