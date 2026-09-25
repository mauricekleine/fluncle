#!/usr/bin/env bun

import { spawnSync } from "node:child_process";

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";

const DEFAULT_THRESHOLD = 40;

const DEFAULT_STALE_DAYS = 30;

export type TriageLabel = {
  name: string;
  seedState: string;
  slug: string;
  triageCheckedAt?: string | null;
  triageReason?: string | null;
  triageVerdict?: string | null;
};

export type GateVerdict = {
  candidates: TriageLabel[];

  fire: boolean;
  neverLooked: number;
  reason: string;
  stale: number;

  undecided: number;
};

export function readUndecided(bin = FLUNCLE_BIN): TriageLabel[] {
  const result = spawnSync(
    bin,
    ["admin", "labels", "list", "--seed-state", "undecided", "--json"],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );

  const stdout = result.stdout ?? "";
  if (!stdout.trim()) {
    throw new Error(
      `admin labels list produced no output (status ${result.status}): ${(result.stderr ?? "").slice(0, 400)}`,
    );
  }

  const parsed = JSON.parse(stdout) as { labels?: TriageLabel[] };

  return parsed.labels ?? [];
}

function ageMs(label: TriageLabel, now: number): number {
  if (!label.triageCheckedAt) {
    return Number.POSITIVE_INFINITY;
  }
  const looked = Date.parse(label.triageCheckedAt);

  return Number.isNaN(looked) ? Number.POSITIVE_INFINITY : now - looked;
}

export function decide(
  labels: TriageLabel[],
  options: { now?: number; staleDays?: number; threshold?: number } = {},
): GateVerdict {
  const now = options.now ?? Date.now();
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const staleMs = (options.staleDays ?? DEFAULT_STALE_DAYS) * 24 * 60 * 60 * 1000;

  const neverLooked = labels.filter((label) => !label.triageCheckedAt);
  const stale = labels.filter(
    (label) => Boolean(label.triageCheckedAt) && ageMs(label, now) >= staleMs,
  );

  const candidates = [...neverLooked, ...stale].sort((a, b) => ageMs(b, now) - ageMs(a, now));
  const fire = neverLooked.length >= threshold;

  return {
    candidates,
    fire,
    neverLooked: neverLooked.length,
    reason: fire
      ? `${neverLooked.length} never-looked labels reached the threshold of ${threshold}`
      : `${neverLooked.length} never-looked labels, below the threshold of ${threshold}`,
    stale: stale.length,
    undecided: labels.length,
  };
}

export function summarize(verdict: GateVerdict): string {
  return [
    `LABEL TRIAGE GATE: ${verdict.fire ? "FIRE" : "HOLD"}`,
    `undecided=${verdict.undecided}`,
    `never-looked=${verdict.neverLooked}`,
    `stale=${verdict.stale}`,
    `candidates=${verdict.candidates.length}`,
    `— ${verdict.reason}`,
  ].join(" ");
}

async function main(): Promise<void> {
  const threshold = Number(process.env.LABEL_TRIAGE_THRESHOLD ?? DEFAULT_THRESHOLD);
  const staleDays = Number(process.env.LABEL_TRIAGE_STALE_DAYS ?? DEFAULT_STALE_DAYS);

  const verdict = decide(readUndecided(), { staleDays, threshold });
  console.log(summarize(verdict));

  if (!verdict.fire) {
    return;
  }

  console.log(
    `LABEL TRIAGE WORKLIST: ${verdict.candidates
      .slice(0, 400)
      .map((label) => label.slug)
      .join(" ")}`,
  );
}

if (import.meta.main) {
  await main();
}
