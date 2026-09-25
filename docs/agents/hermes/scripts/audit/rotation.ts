#!/usr/bin/env bun

export const DOMAINS = [
  "design",
  "voice",
  "architecture",
  "security",
  "surfaces-seo",
  "docs",
  "tests",
  "db-query-shape",
] as const;

export type AuditDomain = (typeof DOMAINS)[number];

export const DOMAIN_META: Record<AuditDomain, { label: string; blurb: string }> = {
  architecture: {
    blurb: "dead code, duplication, the oRPC + coverage invariants, module boundaries",
    label: "Architecture & code quality",
  },
  "db-query-shape": {
    blurb: "recompute-by-scan on the growing tables — anti-joins, hub group-bys, per-row loops",
    label: "DB query shape at scale",
  },
  design: {
    blurb: "DESIGN.md adherence — Shadcn, iconography, dark/cover-led, WCAG AA",
    label: "Design canon",
  },
  docs: {
    blurb: "AGENTS.md principle-level, doctrine-vs-code drift, dead links, stale briefs",
    label: "Docs freshness",
  },
  security: {
    blurb: "secret/topology leakage, auth tiers, input validation, dependency CVEs",
    label: "Security",
  },
  "surfaces-seo": {
    blurb: "registry↔consumer fan-out, JSON-LD, sitemap/llms, GSC + Bing signal",
    label: "Surfaces & SEO/AEO",
  },
  tests: {
    blurb: "untested new surfaces, missing focused tests, flaky patterns",
    label: "Test coverage",
  },
  voice: {
    blurb: "VOICE.md — banned words, said-not-written, no fabricated facts, sentence case",
    label: "Voice & copy",
  },
};

const MS_PER_DAY = 86_400_000;

export function daysSinceEpoch(date: Date): number {
  return Math.floor(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / MS_PER_DAY,
  );
}

export function domainForDate(date: Date): AuditDomain {
  const idx = ((daysSinceEpoch(date) % DOMAINS.length) + DOMAINS.length) % DOMAINS.length;
  return DOMAINS[idx];
}

if (import.meta.main) {
  const arg = process.argv[2];
  const date = arg ? new Date(`${arg}T00:00:00Z`) : new Date();
  if (Number.isNaN(date.getTime())) {
    console.error(`rotation.ts: invalid date "${arg}" (use YYYY-MM-DD)`);
    process.exit(1);
  }
  process.stdout.write(domainForDate(date));
}
