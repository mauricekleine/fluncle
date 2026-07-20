// Unit tests for the pure helpers in assign-video-axes.ts — the deterministic diversity
// assigner (docs/planning/homogenisation-evidence.md). Box scripts are self-contained (they
// cannot import the workspace) and live outside any package's test runner, so this uses
// `bun:test` and runs directly:
//
//   bun test docs/agents/hermes/scripts/assign-video-axes.test.ts

import { describe, expect, test } from "bun:test";

import {
  assignGrain,
  assignPaletteAvoid,
  assignRegister,
  BAKED_GRAIN_FAMILIES,
  computeAssignment,
  type LedgerEntry,
  parseLedger,
  toEnvLines,
} from "./assign-video-axes";

// Newest-first (feed order), the same order the vehicles ledger returns.
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
    // grainFineEmulsion appears (old); grainVhsScanline & grainChemicalDye never do.
    const entries = [
      entry("grainHalftone"),
      entry("grainDither"),
      entry("grainCoarseSilver"),
      entry("grainFineEmulsion"),
    ];
    const grain = assignGrain(entries);
    // A never-used family is maximally stale; baked order breaks the tie → grainChemicalDye.
    expect(grain).toBe("grainChemicalDye");
  });

  test("among used families, picks the least-recently-used", () => {
    // Every baked family used; the last 3 are excluded, so eligible = the older ones, and
    // the STALEST (largest index) wins. grainVhsScanline is oldest here.
    const entries = [
      entry("grainFineEmulsion"), // 0
      entry("grainCoarseSilver"), // 1
      entry("grainHalftone"), // 2 (last 3 = indices 0..2, excluded)
      entry("grainChemicalDye"), // 3
      entry("grainDither"), // 4
      entry("grainVhsScanline"), // 5 — oldest, the LRU
    ];
    expect(assignGrain(entries)).toBe("grainVhsScanline");
  });

  test("empty ledger falls back to the first baked family, deterministically", () => {
    expect(assignGrain([])).toBe(BAKED_GRAIN_FAMILIES[0]);
  });

  test("unions ledger-only grain values into the universe", () => {
    // A novel family the skill added later, used long ago, should be reachable.
    const entries = [
      entry("grainHalftone"),
      entry("grainDither"),
      entry("grainCoarseSilver"),
      entry("grainFineEmulsion"),
      entry("grainChemicalDye"),
      entry("grainVhsScanline"),
      entry("grainNovelExperimental"),
    ];
    // Everything baked is used more recently than the novel one at index 6, and the last 3
    // are excluded; the novel family is the stalest eligible → picked.
    expect(assignGrain(entries)).toBe("grainNovelExperimental");
  });
});

describe("assignRegister — largest deficit vs target", () => {
  test("the collapse case (all representational) assigns abstract or framed", () => {
    // 24/26 representational → the recent window is all representational.
    const entries = Array.from({ length: 12 }, () =>
      entry("grainFineEmulsion", "representational"),
    );
    const register = assignRegister(entries);
    expect(["abstract", "framed"]).toContain(register);
    // Framed has the larger non-representational target (0.20 > 0.15 after the
    // 2026-07-20 TikTok retune), so the larger deficit → framed.
    expect(register).toBe("framed");
  });

  test("fills the most-starved register", () => {
    // A window heavy on abstract + representational, none framed → framed is most starved.
    const entries = [
      entry("g", "abstract"),
      entry("g", "representational"),
      entry("g", "abstract"),
      entry("g", "representational"),
      entry("g", "abstract"),
      entry("g", "representational"),
    ];
    expect(assignRegister(entries)).toBe("framed");
  });

  test("empty ledger picks the highest-target register (representational)", () => {
    // Zero window: deficit = target * 0 - 0 = 0 for all; ties break by REGISTERS order
    // (abstract first). With no neighbour, the order tiebreak stands.
    expect(assignRegister([])).toBe("abstract");
  });

  test("tie breaks toward what the immediate neighbour is NOT", () => {
    // Construct a genuine deficit tie between two registers and check the neighbour tiebreak.
    // Targets are pinned explicitly — this test exercises the tiebreak MECHANICS, not the
    // tunable default weights. With rep .45 abstract .35 framed .20 → target counts
    // 4.5/3.5/2.0; actual rep 4, abstract 3, framed 2 (9 entries) leaves deficits rep .5,
    // abstract .5, framed 0 — rep & abstract tie. Immediate neighbour = representational,
    // so pick abstract.
    const entries = [
      entry("g", "representational"), // immediate neighbour
      entry("g", "representational"),
      entry("g", "representational"),
      entry("g", "representational"),
      entry("g", "abstract"),
      entry("g", "abstract"),
      entry("g", "abstract"),
      entry("g", "framed"),
      entry("g", "framed"),
    ];
    expect(assignRegister(entries, { abstract: 0.35, framed: 0.2, representational: 0.45 })).toBe(
      "abstract",
    );
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
  test("accepts the { ok, vehicles: [...] } envelope", () => {
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

  test("returns null when neither an array nor a vehicles envelope", () => {
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
    // Single-quoted, sources cleanly under `set -a`.
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
