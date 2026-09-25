#!/usr/bin/env bun
// label-triage-sweep.ts — the `fluncle-label-triage` cron's orchestrator.
//
// THE GATE HALF ONLY. This is deliberately a PURE, deterministic trigger: it reads the undecided
// pile, sorts it by the triage cursor, and decides whether enough NEVER-LOOKED labels have
// accumulated to be worth a research round. It spends zero model tokens and makes no ruling.
//
// Why the gate is separate from the research: every agent-bearing cron in this repo has had a
// silent outage — a Claude token six days dead while the sweep reported green, a pinned binary
// rotting for thirteen days the same way. A cheap deterministic gate that runs nightly and says
// "not yet" is something whose health can be trusted; an expensive one that runs an LLM fan-out is
// not. So the gate always runs, and the leg it fires is the part allowed to be fragile.
//
// WHAT IT CANNOT DO. The gate reads `list_labels_admin` and reports. Recording a round's finding is
// `record_label_triage` (agent tier, `admin labels triage`); RULING on a label is `update_label`
// (operator tier), which 403s the box's agent token at `operatorGuard`. Nothing here can enable a
// label, disable one, or write an artist rule, whatever it concludes.
//
// The pair is BAKED into the image at /opt/hermes-scripts/ and auto-updates from main via
// pin-watch; a rave-02 HOST systemd timer docker-execs the .sh wrapper. See ../cron/README.md and
// the fluncle-label-triage skill for the round this gates.
import { spawnSync } from "node:child_process";

/** The box bakes absolute paths; a bare `fluncle` can miss on a minimal cron PATH. */
const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";

/**
 * How many NEVER-LOOKED labels must accumulate before a round is worth its tokens.
 *
 * A round costs roughly 14k subagent tokens per label, so firing on a trickle spends a fixed
 * orchestration cost to research a handful. Forty is about five days of accumulation at the refill
 * rate measured after the graph started exhausting, and it is a first guess against a rate that is
 * still falling — revisit once the gate has a few weeks of depth readings.
 */
const DEFAULT_THRESHOLD = 40;

/**
 * How long before a label a round could not rule is looked at again.
 *
 * The cursor is a rotation, not a hold list: a conflation fixed upstream in MusicBrainz, or a new
 * global rule that moves a share test, resolves a stuck label on its own the next time it comes
 * round. Thirty days is often enough to catch those and rare enough that the permanently-stuck core
 * — conflations awaiting an upstream edit — is not re-derived every week.
 */
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
  /** Labels a round should research this firing, never-looked first then stalest. */
  candidates: TriageLabel[];
  /** True when the threshold is met and the research leg should run. */
  fire: boolean;
  neverLooked: number;
  reason: string;
  stale: number;
  /** Every undecided label, including the ones a round looked at recently. */
  undecided: number;
};

/** Read the undecided pile through the CLI. Parse-first: a partial read is still a reading. */
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

/** Milliseconds since a label was last looked at; Infinity when no round ever has. */
function ageMs(label: TriageLabel, now: number): number {
  if (!label.triageCheckedAt) {
    return Number.POSITIVE_INFINITY;
  }
  const looked = Date.parse(label.triageCheckedAt);

  return Number.isNaN(looked) ? Number.POSITIVE_INFINITY : now - looked;
}

/**
 * The gate decision.
 *
 * The threshold counts ONLY never-looked labels. Counting the whole pile would fire every firing
 * forever, because the stuck core never shrinks — the labels a round cannot rule are exactly the
 * ones that stay. Stale labels still ride ALONG once a round fires (they are cheap to re-read and
 * self-healing depends on it); they just never trigger one by themselves.
 */
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

  // Never-looked first, then stalest — the rotation the cursor exists to drive.
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

/** The one-line run summary the cron output and the /status marker are read from. */
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

  // The research leg is operator-gated for now: the gate names the worklist and stops. Wiring the
  // batched `claude -p` leg is the remaining half, and it stays unwired until the gate has proven
  // it reports honestly — a sweep that fires a five-million-token round on a miscount is worse
  // than one that does nothing.
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
