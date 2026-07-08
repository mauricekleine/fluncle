#!/usr/bin/env bun
// rotation.ts — pick the day's audit domain for the nightly `fluncle-audit` sweep.
//
// The nightly auditor cycles through one domain per night rather than a thin
// everything-pass: a focused single-domain prompt goes deep, and each night's PR
// stays small enough to review over coffee. This module is the pure, tested selector
// the 1am driver (audit-sweep.sh) calls to decide WHICH domain runs tonight.
//
// The cycle is keyed on the DAY, not a stored counter, so it is stateless and survives
// a box reboot / re-provision with zero drift: `daysSinceEpoch % DOMAINS.length`. We use
// days-since-Unix-epoch (not day-of-year) so the rotation is CONTINUOUS across a year
// boundary — day-of-year resets to 1 on Jan 1 and would jump the cycle; epoch-day never
// resets, so the sequence marches unbroken forever.
//
// Run directly, it prints tonight's domain key (what the driver consumes):
//     bun rotation.ts            -> e.g. "security"
//     bun rotation.ts 2026-07-12 -> the domain for a specific UTC date (for tests/dry-runs)

// The seven audit domains, in cycle order. Each key maps 1:1 to a prompt file at
// ./prompts/<key>.md (the auditor loads that file as its brief) and to a human label +
// blurb (below) used in the PR title and the run log. Adding an eighth domain is: append
// a key here, add its prompts/<key>.md, add a DOMAIN_META entry — nothing else.
export const DOMAINS = [
  "design",
  "voice",
  "architecture",
  "security",
  "surfaces-seo",
  "docs",
  "tests",
] as const;

export type AuditDomain = (typeof DOMAINS)[number];

// Human label + one-line blurb per domain — the PR title reads "nightly audit — <label>"
// and the run summary carries the blurb. Kept beside the keys so the set stays in step.
export const DOMAIN_META: Record<AuditDomain, { label: string; blurb: string }> = {
  architecture: {
    blurb: "dead code, duplication, the oRPC + coverage invariants, module boundaries",
    label: "Architecture & code quality",
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

// Whole days from the Unix epoch to the given date's UTC midnight. Pure integer math on a
// UTC instant, so it never depends on the box's local timezone (the box runs TZ=Amsterdam,
// but the rotation must be tz-independent to stay deterministic across the CET/CEST flip).
export function daysSinceEpoch(date: Date): number {
  return Math.floor(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / MS_PER_DAY,
  );
}

// Tonight's domain (or the domain for an explicit date). The modulo is the whole selector —
// stateless, continuous, and uniform across the seven-day cycle.
export function domainForDate(date: Date): AuditDomain {
  const idx = ((daysSinceEpoch(date) % DOMAINS.length) + DOMAINS.length) % DOMAINS.length;
  return DOMAINS[idx];
}

// CLI entry: `bun rotation.ts [YYYY-MM-DD]` prints the domain key and nothing else, so the
// driver can capture it with `DOMAIN="$(bun .../rotation.ts)"`.
if (import.meta.main) {
  const arg = process.argv[2];
  const date = arg ? new Date(`${arg}T00:00:00Z`) : new Date();
  if (Number.isNaN(date.getTime())) {
    console.error(`rotation.ts: invalid date "${arg}" (use YYYY-MM-DD)`);
    process.exit(1);
  }
  process.stdout.write(domainForDate(date));
}
