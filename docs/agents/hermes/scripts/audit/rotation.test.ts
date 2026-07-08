#!/usr/bin/env bun
// Tests for the audit domain rotation — the pure selector the 1am driver leans on.
// Run: bun test docs/agents/hermes/scripts/audit/rotation.test.ts
import { describe, expect, it } from "bun:test";
import { DOMAIN_META, DOMAINS, daysSinceEpoch, domainForDate } from "./rotation";

describe("domainForDate", () => {
  it("returns a valid domain for any date", () => {
    for (let i = 0; i < 40; i++) {
      const d = new Date(Date.UTC(2026, 0, 1 + i));
      expect(DOMAINS).toContain(domainForDate(d));
    }
  });

  it("advances by one domain each calendar day (continuous cycle)", () => {
    const seq: string[] = [];
    for (let i = 0; i < DOMAINS.length; i++) {
      seq.push(domainForDate(new Date(Date.UTC(2026, 5, 1 + i))));
    }
    // Seven consecutive days hit seven distinct domains — the full cycle, no repeat.
    expect(new Set(seq).size).toBe(DOMAINS.length);
  });

  it("is periodic with the domain count", () => {
    const a = domainForDate(new Date(Date.UTC(2026, 6, 8)));
    const b = domainForDate(new Date(Date.UTC(2026, 6, 8 + DOMAINS.length)));
    expect(b).toBe(a);
  });

  it("stays continuous across the year boundary (no day-of-year reset jump)", () => {
    const dec31 = domainForDate(new Date(Date.UTC(2026, 11, 31)));
    const jan1 = domainForDate(new Date(Date.UTC(2027, 0, 1)));
    // Consecutive days must be adjacent in the cycle — never the same, never a jump.
    const i1 = DOMAINS.indexOf(dec31);
    const i2 = DOMAINS.indexOf(jan1);
    expect(i2).toBe((i1 + 1) % DOMAINS.length);
  });

  it("is timezone-independent (same domain regardless of intra-day time)", () => {
    const morning = domainForDate(new Date("2026-07-08T01:00:00Z"));
    const night = domainForDate(new Date("2026-07-08T23:59:00Z"));
    expect(morning).toBe(night);
  });
});

describe("daysSinceEpoch", () => {
  it("counts whole UTC days from the epoch", () => {
    expect(daysSinceEpoch(new Date("1970-01-01T00:00:00Z"))).toBe(0);
    expect(daysSinceEpoch(new Date("1970-01-02T00:00:00Z"))).toBe(1);
  });
});

describe("catalog integrity", () => {
  it("has a label + blurb for every domain and no orphans", () => {
    expect(Object.keys(DOMAIN_META).sort()).toEqual([...DOMAINS].sort());
    for (const key of DOMAINS) {
      expect(DOMAIN_META[key].label.length).toBeGreaterThan(0);
      expect(DOMAIN_META[key].blurb.length).toBeGreaterThan(0);
    }
  });
});
