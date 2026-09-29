#!/usr/bin/env bun

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultStateDir } from "./attempt-ledger";

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";

const DEFAULT_THRESHOLD = 40;

const DEFAULT_STALE_DAYS = 30;

export const RESEARCH_DEFAULTS = {
  batchSize: 10,
  batchTimeoutSecs: 1800,
  concurrency: 2,
  effort: "medium",
  maxBatches: 3,
  maxLabels: 30,
  maxTurns: 120,
  model: "opus",
  skillPath: "/opt/claude/skills/fluncle-label-triage/SKILL.md",
} as const;

export type TriageLabel = {
  carriesArtistRules?: boolean;
  mbLabelId?: string | null;
  name: string;
  seedState: string;
  slug: string;
  triageCheckedAt?: string | null;
  triageReason?: string | null;
  triageVerdict?: string | null;
};

export type GateVerdict = {
  candidates: TriageLabel[];
  carried: number;
  excluded: number;
  fire: boolean;
  neverLooked: number;
  reason: string;
  stale: number;
  undecided: number;
};

export type TriageVerdict = "dnb" | "dnb_partial" | "not_dnb" | "unclear";

export type RuleProposal = {
  artistMbid: string;
  artistName: string;
  evidence?: string;
  firstCreditCount: number;
  verdict: "allow" | "block";
};

export type ResearchedLabel = {
  censusSummary?: string;
  confidence: "high" | "low" | "medium";
  conflation?: string;
  evidence: string;
  globalSuggestion?: string;
  imprintChild?: string;
  offLaneShare?: number;
  reason?: "conflation" | "mixed" | "thin";
  residualOffLaneShare?: number;
  rules?: RuleProposal[];
  slug: string;
  verdict: TriageVerdict;
};

export type TriagePayload = {
  censusSummary?: string;
  confidence: ResearchedLabel["confidence"];
  evidence: string;
  offLaneShare?: number;
  reason?: string;
  residualOffLaneShare?: number;
  roundId: string;
  rules?: RuleProposal[];
  verdict: TriageVerdict;
};

export type Spend = { tokens: number; usd: number | null };

export type BatchResearch =
  | { labels: ResearchedLabel[]; ok: true; spend: Spend }
  | { detail: string; ok: false; reason: "claude_auth" | "claude_error"; spend: Spend };

export type Calibration = { disabled: string[]; enabled: string[]; globalRules: string[] };

export type ResearchConfig = {
  batchSize: number;
  batchTimeoutSecs: number;
  concurrency: number;
  effort: string;
  maxBatches: number;
  maxLabels: number;
  maxTurns: number;
  model: string;
  skillPath: string;
};

export type RoundDeps = {
  alert: (text: string) => Promise<boolean>;
  calibration: () => Promise<Calibration>;
  record: (slug: string, payload: TriagePayload) => Promise<void>;
  research: (batch: TriageLabel[], context: BatchContext) => Promise<BatchResearch>;
};

export type BatchContext = { calibration: Calibration; config: ResearchConfig; index: number };

export type RoundSummary = {
  alerted?: boolean;
  batches: number;
  batchesFailed: number;
  checked: number;
  failures: string[];
  missed: number;
  ok: boolean;
  produced: number;
  reason?: string;
  recordFailures: number;
  roundId: string;
  tokens: number;
  usd: number | null;
  verdicts: Record<TriageVerdict, number>;
};

const log = (message: string) => console.error(`[label-triage] ${message}`);

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

export function researchable(label: TriageLabel): boolean {
  return Boolean(label.mbLabelId) && label.carriesArtistRules !== true;
}

export function decide(
  labels: TriageLabel[],
  options: { carry?: readonly string[]; now?: number; staleDays?: number; threshold?: number } = {},
): GateVerdict {
  const now = options.now ?? Date.now();
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const staleMs = (options.staleDays ?? DEFAULT_STALE_DAYS) * 24 * 60 * 60 * 1000;

  const eligible = labels.filter(researchable);
  const neverLooked = eligible.filter((label) => !label.triageCheckedAt);
  const stale = eligible.filter(
    (label) => Boolean(label.triageCheckedAt) && ageMs(label, now) >= staleMs,
  );

  const carry = new Set(options.carry ?? []);
  const candidates = [...neverLooked, ...stale].sort((a, b) => {
    const carriedFirst = Number(carry.has(b.slug)) - Number(carry.has(a.slug));

    return carriedFirst === 0 ? ageMs(b, now) - ageMs(a, now) : carriedFirst;
  });
  const carried = candidates.filter((label) => carry.has(label.slug)).length;
  const reached = neverLooked.length >= threshold;
  const fire = reached || carried > 0;

  return {
    candidates,
    carried,
    excluded: labels.length - eligible.length,
    fire,
    neverLooked: neverLooked.length,
    reason: reached
      ? `${neverLooked.length} never-looked labels reached the threshold of ${threshold}`
      : carried > 0
        ? `${carried} labels an earlier round left unfinished`
        : `${neverLooked.length} never-looked labels, below the threshold of ${threshold}`,
    stale: stale.length,
    undecided: labels.length,
  };
}

export function summarize(verdict: GateVerdict): string {
  return [
    `LABEL TRIAGE GATE: ${verdict.fire ? "FIRE" : "HOLD"}`,
    `undecided=${verdict.undecided}`,
    `excluded=${verdict.excluded}`,
    `carried=${verdict.carried}`,
    `never-looked=${verdict.neverLooked}`,
    `stale=${verdict.stale}`,
    `candidates=${verdict.candidates.length}`,
    `— ${verdict.reason}`,
  ].join(" ");
}

export function planBatches(candidates: TriageLabel[], config: ResearchConfig): TriageLabel[][] {
  const size = Math.max(1, Math.floor(config.batchSize));
  const selected = candidates.slice(0, Math.max(0, Math.floor(config.maxLabels)));
  const batches: TriageLabel[][] = [];

  for (let start = 0; start < selected.length; start += size) {
    batches.push(selected.slice(start, start + size));
  }

  return batches.slice(0, Math.max(0, Math.floor(config.maxBatches)));
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);

  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

export function researchConfig(env: NodeJS.ProcessEnv): ResearchConfig {
  return {
    batchSize: positiveInt(env.LABEL_TRIAGE_BATCH_SIZE, RESEARCH_DEFAULTS.batchSize),
    batchTimeoutSecs: positiveInt(
      env.LABEL_TRIAGE_BATCH_TIMEOUT_SECS,
      RESEARCH_DEFAULTS.batchTimeoutSecs,
    ),
    concurrency: positiveInt(env.LABEL_TRIAGE_CONCURRENCY, RESEARCH_DEFAULTS.concurrency),
    effort: env.LABEL_TRIAGE_CLAUDE_EFFORT ?? RESEARCH_DEFAULTS.effort,
    maxBatches: positiveInt(env.LABEL_TRIAGE_MAX_BATCHES, RESEARCH_DEFAULTS.maxBatches),
    maxLabels: positiveInt(env.LABEL_TRIAGE_MAX_LABELS, RESEARCH_DEFAULTS.maxLabels),
    maxTurns: positiveInt(env.LABEL_TRIAGE_MAX_TURNS, RESEARCH_DEFAULTS.maxTurns),
    model: env.LABEL_TRIAGE_CLAUDE_MODEL ?? RESEARCH_DEFAULTS.model,
    skillPath: env.LABEL_TRIAGE_SKILL_PATH ?? RESEARCH_DEFAULTS.skillPath,
  };
}

export function roundIdFor(now: Date, suffix = randomUUID().slice(0, 8)): string {
  return `box-${now.toISOString().slice(0, 10)}-${suffix}`;
}

function withEvidenceNotes(label: ResearchedLabel): string {
  const notes = [
    label.evidence.trim(),
    label.imprintChild && label.imprintChild.trim().toLowerCase() !== "none"
      ? `Imprint child: ${label.imprintChild.trim()}`
      : "",
    label.conflation ? `Conflation: ${label.conflation.trim()}` : "",
    label.globalSuggestion ? `Global suggestion: ${label.globalSuggestion.trim()}` : "",
  ].filter(Boolean);

  return notes.join(" · ");
}

export function toPayload(label: ResearchedLabel, roundId: string): TriagePayload {
  const rules = (label.rules ?? []).filter((rule) => rule.firstCreditCount > 0);

  return {
    confidence: label.confidence,
    evidence: withEvidenceNotes(label),
    roundId,
    verdict: label.verdict,
    ...(label.censusSummary ? { censusSummary: label.censusSummary } : {}),
    ...(typeof label.offLaneShare === "number" ? { offLaneShare: label.offLaneShare } : {}),
    ...(label.verdict === "unclear" && label.reason ? { reason: label.reason } : {}),
    ...(typeof label.residualOffLaneShare === "number"
      ? { residualOffLaneShare: label.residualOffLaneShare }
      : {}),
    ...(rules.length > 0 ? { rules } : {}),
  };
}

async function pool<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item !== undefined) {
        await work(item);
      }
    }
  });

  await Promise.all(lanes);
}

function emptyVerdicts(): Record<TriageVerdict, number> {
  return { dnb: 0, dnb_partial: 0, not_dnb: 0, unclear: 0 };
}

export async function runRound(
  candidates: TriageLabel[],
  config: ResearchConfig,
  deps: RoundDeps,
  roundId: string,
): Promise<RoundSummary> {
  const batches = planBatches(candidates, config);
  const summary: RoundSummary = {
    batches: batches.length,
    batchesFailed: 0,
    checked: 0,
    failures: [],
    missed: 0,
    ok: false,
    produced: 0,
    recordFailures: 0,
    roundId,
    tokens: 0,
    usd: null,
    verdicts: emptyVerdicts(),
  };

  let calibration: Calibration;
  try {
    calibration = await deps.calibration();
  } catch (error) {
    summary.reason = "calibration_unreadable";
    summary.failures.push(`calibration: ${error instanceof Error ? error.message : String(error)}`);

    return finish(summary, deps);
  }

  let authFailed = false;
  const indexed = batches.map((batch, index) => ({ batch, index }));

  await pool(indexed, config.concurrency, async ({ batch, index }) => {
    summary.checked += batch.length;

    if (authFailed) {
      summary.batchesFailed += 1;
      summary.failures.push(`batch ${index + 1}: skipped after a Claude auth failure`);

      return;
    }

    let research: BatchResearch;
    try {
      research = await deps.research(batch, { calibration, config, index });
    } catch (error) {
      research = {
        detail: error instanceof Error ? error.message : String(error),
        ok: false,
        reason: "claude_error",
        spend: { tokens: 0, usd: null },
      };
    }

    summary.tokens += research.spend.tokens;
    if (research.spend.usd !== null) {
      summary.usd = (summary.usd ?? 0) + research.spend.usd;
    }

    if (!research.ok) {
      summary.batchesFailed += 1;
      summary.failures.push(`batch ${index + 1}: ${research.reason} ${research.detail}`.trim());
      if (research.reason === "claude_auth") {
        authFailed = true;
      }

      return;
    }

    const wanted = new Set(batch.map((label) => label.slug));
    const seen = new Set<string>();
    let batchFailed = false;

    for (const label of research.labels) {
      if (!wanted.has(label.slug) || seen.has(label.slug)) {
        continue;
      }
      seen.add(label.slug);

      try {
        await deps.record(label.slug, toPayload(label, roundId));
        summary.produced += 1;
        summary.verdicts[label.verdict] += 1;
      } catch (error) {
        batchFailed = true;
        summary.recordFailures += 1;
        summary.failures.push(
          `record ${label.slug}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const missed = batch.filter((label) => !seen.has(label.slug)).map((label) => label.slug);
    if (missed.length > 0) {
      batchFailed = true;
      summary.missed += missed.length;
      summary.failures.push(`batch ${index + 1}: no verdict for ${missed.join(", ")}`);
    }

    if (batchFailed) {
      summary.batchesFailed += 1;
    }
  });

  if (authFailed) {
    summary.reason = "claude_auth";
  } else if (summary.produced === 0) {
    summary.reason = "zero_proposals";
  } else if (summary.batchesFailed > 0) {
    summary.reason = "batch_failed";
  }

  return finish(summary, deps);
}

export function alertText(summary: RoundSummary): string {
  const failures = summary.failures.slice(0, 5).map((line) => `- ${line.slice(0, 300)}`);

  return [
    `Fluncle label-triage: round ${summary.roundId} FAILED (${summary.reason ?? "unknown"}) — recorded ${summary.produced}/${summary.checked} proposals, ${summary.batchesFailed}/${summary.batches} batches failed.`,
    ...failures,
  ].join("\n");
}

async function finish(summary: RoundSummary, deps: RoundDeps): Promise<RoundSummary> {
  summary.ok = summary.reason === undefined && summary.produced > 0 && summary.batchesFailed === 0;

  if (!summary.ok) {
    summary.reason ??= "zero_proposals";
    summary.alerted = await deps.alert(alertText(summary)).catch(() => false);
  }

  return summary;
}

export async function postDiscordAlert(
  text: string,
  webhook = process.env.DISCORD_ALERT_WEBHOOK,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!webhook) {
    log("DISCORD_ALERT_WEBHOOK is not set — the failure is in the marker and the ledger only");

    return false;
  }

  try {
    const response = await fetchImpl(webhook, {
      body: JSON.stringify({ content: text.slice(0, 1900) }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      log(`discord alert answered ${response.status}`);
    }

    return response.ok;
  } catch (error) {
    log(`discord alert failed: ${error instanceof Error ? error.message : String(error)}`);

    return false;
  }
}

const VERDICT_ITEM_SCHEMA = {
  additionalProperties: false,
  properties: {
    censusSummary: { type: "string" },
    confidence: { enum: ["high", "medium", "low"], type: "string" },
    conflation: { type: "string" },
    evidence: { type: "string" },
    globalSuggestion: { type: "string" },
    imprintChild: { type: "string" },
    offLaneShare: { maximum: 1, minimum: 0, type: "number" },
    reason: { enum: ["conflation", "thin", "mixed"], type: "string" },
    residualOffLaneShare: { maximum: 1, minimum: 0, type: "number" },
    rules: {
      items: {
        additionalProperties: false,
        properties: {
          artistMbid: { type: "string" },
          artistName: { type: "string" },
          evidence: { type: "string" },
          firstCreditCount: { minimum: 0, type: "integer" },
          verdict: { enum: ["allow", "block"], type: "string" },
        },
        required: ["artistMbid", "artistName", "verdict", "evidence", "firstCreditCount"],
        type: "object",
      },
      type: "array",
    },
    slug: { type: "string" },
    verdict: { enum: ["dnb", "dnb_partial", "not_dnb", "unclear"], type: "string" },
  },
  required: ["slug", "verdict", "confidence", "evidence"],
  type: "object",
};

export const RESEARCH_SCHEMA = JSON.stringify({
  additionalProperties: false,
  properties: { verdicts: { items: VERDICT_ITEM_SCHEMA, type: "array" } },
  required: ["verdicts"],
  type: "object",
});

export const EVIDENCE_TOOL = "Bash(fluncle admin labels evidence:*)";

export function buildResearchPrompt(batch: TriageLabel[], config: ResearchConfig): string {
  const labels = batch.map(
    (label) =>
      `- slug \`${label.slug}\` · name "${label.name}" · mb_label_id \`${label.mbLabelId}\``,
  );

  return `You are triaging crawl-seed labels for **Fluncle**, a drum & bass archive. Fluncle's catalogue crawler only STORES tracks from labels the operator marks \`enabled\`, so your verdict is a PROPOSAL the operator rules on by hand. A wrong "dnb" pollutes the catalogue with off-genre music; a wrong "not_dnb" silently loses good music. Be accurate over decisive.

## Read first
Read \`${config.skillPath}\` before your first label. Its four standing rulings, its DSP oracle ladder, its calibration shape and its 15 % census rule bind this pass and are not repeated in full here.

Then read the operator's LIVE ruling boundary in your working directory: \`calib-enabled.txt\` (labels he enabled), \`calib-disabled.txt\` (labels he disabled) and \`calib-rules.txt\` (the GLOBAL artist rules already in force). Majors, subsidiaries, distributors and aggregators are OUT even when they carry DnB; DnB-specific media brands are IN; genre-adjacent scenes (dubstep, grime, UKG, jungle-adjacent electronica) are OUT.

## Your labels
${labels.join("\n")}

Research the EXACT MusicBrainz entity named by each \`mb_label_id\`, never a same-named label.

## Evidence
Your ONLY fetcher is \`fluncle admin labels evidence <mb_label_id> --json\`. It returns the MusicBrainz label and a first-credit release sample, Discogs per-release styles, Beatport's genre facet and Apple's genre for sampled barcodes, each with its own \`status\` and \`errors\` (\`not_configured\` or \`no_link\` means that rung is silent, not negative). Run it once per label. For a label that is genuinely two-sided, run \`fluncle admin labels evidence <mb_label_id> --census --json\` once more for the first-credit census. **Do not write fetchers** and do not try any other command: you have no other network access. Read the ladder in the skill and record which rung answered and the exact string it returned.

## Buckets
- **dnb** — predominantly drum & bass or jungle (any subgenre), or a mixed label whose census RAW off-lane first-credit share is ≤ 0.15, with \`block\` rules for the off-lane acts.
- **not_dnb** — clearly another genre, or a major/subsidiary/distributor/aggregator/reissue house/compilation mill.
- **dnb_partial** — mostly off-lane, with DnB acts whose own records deserve the archive: \`allow\` rules only.
- **unclear** — the operator's call. Set \`reason\`: \`conflation\` when one MBID holds two real labels (name the strands in \`conflation\`; never rule through it), \`mixed\` when the census cannot carve it (raw share above 0.15 and no partial case), \`thin\` when no rung of the ladder answers.

## Census rails (only for two-sided labels)
1. Imprint child first: when \`labelRelations\` shows a child imprint covering the boundary, name it in \`imprintChild\` and propose no rules.
2. \`offLaneShare\` is the RAW off-lane share of censused FIRST credits (every off-lane credit). It is the rail.
3. \`residualOffLaneShare\` drops credits whose artist already carries a GLOBAL rule in \`calib-rules.txt\`. Report it; it never changes the verdict.
4. No inert rules: every rule needs \`firstCreditCount > 0\` on your census.
5. One act is often several MBIDs: give every collaboration entity its own rule row and count.
6. Globals are the operator's: an act that deserves a rule everywhere goes in \`globalSuggestion\` as prose, never as a rule row.
7. Copy the census \`caveat\` verbatim into \`censusSummary\` when set, and drop your confidence a step.

## Output
Return exactly one verdict per label above, keyed by its \`slug\`, through the structured schema. \`evidence\` is one or two lines citing what you actually saw (artists, styles, genre strings, the rung that answered). Do not write any files.`;
}

export function claudeArgs(config: ResearchConfig): string[] {
  return [
    "-p",
    "--model",
    config.model,
    "--effort",
    config.effort,
    "--max-turns",
    String(config.maxTurns),
    "--restricted",
    "--strict-mcp-config",
    "--permission-mode",
    "dontAsk",
    "--tools",
    "Read,Glob,Grep,Bash",
    "--allowedTools",
    EVIDENCE_TOOL,
    "--add-dir",
    dirname(config.skillPath),
    "--output-format",
    "json",
    "--json-schema",
    RESEARCH_SCHEMA,
  ];
}

const RESEARCH_ENV_ALLOW = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "DISCOGS_USER_TOKEN",
  "FIRECRAWL_API_KEY",
  "LANG",
  "LC_ALL",
  "PATH",
  "TMPDIR",
  "TZ",
  "XDG_CACHE_HOME",
];

export function researchEnv(env: NodeJS.ProcessEnv, workdir: string): Record<string, string> {
  const scoped: Record<string, string> = {
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    FLUNCLE_UNATTENDED: "1",
    HOME: workdir,
    XDG_CACHE_HOME: env.XDG_CACHE_HOME ?? join(env.HOME ?? workdir, ".cache"),
  };

  for (const key of RESEARCH_ENV_ALLOW) {
    const value = env[key];
    if (value !== undefined) {
      scoped[key] = value;
    }
  }

  return scoped;
}

const AUTH_SIGNATURES = [
  "invalid api key",
  "authentication_error",
  "oauth token",
  "oauth_token",
  "please run /login",
  "not logged in",
  "claude setup-token",
  "credit balance is too low",
  "401",
];

export function looksLikeAuthFailure(text: string): boolean {
  const haystack = text.toLowerCase();

  return AUTH_SIGNATURES.some((signature) => haystack.includes(signature));
}

type ClaudeReply = {
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  subtype?: string;
  total_cost_usd?: number;
  usage?: {
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
};

export function spendOf(reply: ClaudeReply): Spend {
  const usage = reply.usage ?? {};
  const tokens =
    (usage.input_tokens ?? 0) +
    (usage.output_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0);

  return { tokens, usd: typeof reply.total_cost_usd === "number" ? reply.total_cost_usd : null };
}

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");

  return start >= 0 && end > start ? body.slice(start, end + 1) : body;
}

export function parseResearchReply(stdout: string): BatchResearch {
  let reply: ClaudeReply;
  try {
    reply = JSON.parse(stdout) as ClaudeReply;
  } catch {
    return {
      detail: `claude -p did not return JSON: ${stdout.slice(0, 200)}`,
      ok: false,
      reason: "claude_error",
      spend: { tokens: 0, usd: null },
    };
  }

  const spend = spendOf(reply);

  if (reply.is_error) {
    const detail = `${reply.subtype ?? ""} ${reply.result ?? ""}`.trim().slice(0, 300);

    return {
      detail,
      ok: false,
      reason: looksLikeAuthFailure(detail) ? "claude_auth" : "claude_error",
      spend,
    };
  }

  let structured: unknown = reply.structured_output;
  if (!structured || typeof structured !== "object") {
    try {
      structured = JSON.parse(extractJson(reply.result ?? ""));
    } catch {
      return {
        detail: `unparseable result: ${(reply.result ?? "").slice(0, 200)}`,
        ok: false,
        reason: "claude_error",
        spend,
      };
    }
  }

  const verdicts = (structured as { verdicts?: unknown }).verdicts;
  if (!Array.isArray(verdicts)) {
    return {
      detail: "the reply carried no verdicts array",
      ok: false,
      reason: "claude_error",
      spend,
    };
  }

  return { labels: verdicts.filter(isResearchedLabel), ok: true, spend };
}

const VERDICTS = new Set(["dnb", "dnb_partial", "not_dnb", "unclear"]);
const CONFIDENCES = new Set(["high", "medium", "low"]);

function isResearchedLabel(value: unknown): value is ResearchedLabel {
  if (!value || typeof value !== "object") {
    return false;
  }
  const row = value as Record<string, unknown>;

  return (
    typeof row.slug === "string" &&
    typeof row.evidence === "string" &&
    row.evidence.trim().length > 0 &&
    VERDICTS.has(String(row.verdict)) &&
    CONFIDENCES.has(String(row.confidence))
  );
}

type Captured = { code: number; stderr: string; stdout: string; timedOut: boolean };

function capture(
  bin: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string>; input?: string; timeoutMs?: number },
): Promise<Captured> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            setTimeout(() => child.kill("SIGKILL"), 30_000).unref();
          }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (timer) {
        clearTimeout(timer);
      }
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) {
        clearTimeout(timer);
      }
      resolve({ code: code ?? 1, stderr, stdout, timedOut });
    });
    child.stdin.end(options.input ?? "");
  });
}

async function fluncleJson<T>(args: string[]): Promise<T> {
  const result = await capture(FLUNCLE_BIN, [...args, "--json"], { timeoutMs: 120_000 });

  if (result.code !== 0) {
    throw new Error(
      `fluncle ${args.join(" ")} exited ${result.code}: ${(result.stderr || result.stdout).trim().slice(-300)}`,
    );
  }

  return JSON.parse(result.stdout) as T;
}

async function readCalibration(): Promise<Calibration> {
  const [enabled, disabled, rules] = await Promise.all([
    fluncleJson<{ labels?: TriageLabel[] }>(["admin", "labels", "list", "--seed-state", "enabled"]),
    fluncleJson<{ labels?: TriageLabel[] }>([
      "admin",
      "labels",
      "list",
      "--seed-state",
      "disabled",
    ]),
    fluncleJson<{
      rules?: Array<{
        artistMbid?: string;
        artistName?: string;
        resolvedName?: string | null;
        verdict?: string;
      }>;
    }>(["admin", "artists", "rules"]),
  ]);

  return {
    disabled: (disabled.labels ?? []).map((label) => label.name),
    enabled: (enabled.labels ?? []).map((label) => label.name),
    globalRules: (rules.rules ?? []).map(
      (rule) =>
        `${rule.verdict ?? "?"} | GLOBAL | ${rule.resolvedName ?? rule.artistName ?? "?"} (${rule.artistMbid ?? "?"})`,
    ),
  };
}

async function researchWithClaude(
  batch: TriageLabel[],
  { calibration, config, index }: BatchContext,
): Promise<BatchResearch> {
  const workdir = mkdtempSync(join(tmpdir(), "label-triage-batch-"));

  try {
    writeFileSync(join(workdir, "calib-enabled.txt"), `${calibration.enabled.join("\n")}\n`);
    writeFileSync(join(workdir, "calib-disabled.txt"), `${calibration.disabled.join("\n")}\n`);
    writeFileSync(join(workdir, "calib-rules.txt"), `${calibration.globalRules.join("\n")}\n`);

    log(`batch ${index + 1}: researching ${batch.map((label) => label.slug).join(", ")}`);
    const result = await capture(process.env.CLAUDE_BIN ?? "claude", claudeArgs(config), {
      cwd: workdir,
      env: researchEnv(process.env, workdir),
      input: buildResearchPrompt(batch, config),
      timeoutMs: config.batchTimeoutSecs * 1000,
    });

    if (result.timedOut) {
      return {
        detail: `timed out after ${config.batchTimeoutSecs}s`,
        ok: false,
        reason: "claude_error",
        spend: { tokens: 0, usd: null },
      };
    }

    const parsed = parseResearchReply(result.stdout);

    if (
      !parsed.ok &&
      result.code !== 0 &&
      looksLikeAuthFailure(`${result.stdout}\n${result.stderr}`)
    ) {
      return { ...parsed, reason: "claude_auth" };
    }

    if (!parsed.ok && result.code !== 0) {
      return {
        ...parsed,
        detail: `claude -p exited ${result.code}: ${(result.stderr || result.stdout).trim().slice(-200)}`,
      };
    }

    return parsed;
  } finally {
    rmSync(workdir, { force: true, recursive: true });
  }
}

async function recordWithFluncle(slug: string, payload: TriagePayload): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "label-triage-record-"));

  try {
    const path = join(dir, "payload.json");
    writeFileSync(path, JSON.stringify(payload));
    await fluncleJson(["admin", "labels", "triage", slug, "--payload", path]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

export type CarryStore = { read: () => string[]; write: (slugs: string[]) => void };

export function fileCarryStore(
  path = join(process.env.LABEL_TRIAGE_STATE_DIR ?? defaultStateDir("label-triage"), "carry.json"),
): CarryStore {
  return {
    read: () => {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as { slugs?: unknown };

        return Array.isArray(parsed.slugs)
          ? parsed.slugs.filter((slug): slug is string => typeof slug === "string")
          : [];
      } catch {
        return [];
      }
    },
    write: (slugs) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ slugs, writtenAt: new Date().toISOString() }));
    },
  };
}

export function unfinished(
  candidates: TriageLabel[],
  selected: TriageLabel[],
  recorded: ReadonlySet<string>,
): string[] {
  const chosen = new Set(selected.map((label) => label.slug));

  return candidates
    .filter((label) => !recorded.has(label.slug))
    .filter((label) => !label.triageCheckedAt || chosen.has(label.slug))
    .map((label) => label.slug);
}

export const LIVE_DEPS: RoundDeps = {
  alert: (text) => postDiscordAlert(text),
  calibration: readCalibration,
  record: recordWithFluncle,
  research: researchWithClaude,
};

export async function runSweep(
  env: NodeJS.ProcessEnv,
  labels: TriageLabel[],
  deps: RoundDeps,
  options: {
    carry?: CarryStore;
    now?: Date;
    print?: (line: string) => void;
    roundId?: string;
  } = {},
): Promise<number> {
  const carry = options.carry ?? fileCarryStore();
  const print = options.print ?? ((line: string) => console.log(line));
  const now = options.now ?? new Date();
  const threshold = Number(env.LABEL_TRIAGE_THRESHOLD ?? DEFAULT_THRESHOLD);
  const staleDays = Number(env.LABEL_TRIAGE_STALE_DAYS ?? DEFAULT_STALE_DAYS);

  const verdict = decide(labels, {
    carry: carry.read(),
    now: now.getTime(),
    staleDays,
    threshold,
  });
  print(summarize(verdict));

  const gate = {
    candidates: verdict.candidates.length,
    carried: verdict.carried,
    excluded: verdict.excluded,
    neverLooked: verdict.neverLooked,
    stale: verdict.stale,
    undecided: verdict.undecided,
  };

  if (!verdict.fire) {
    print(JSON.stringify({ checked: 0, gate: "hold", ok: true, produced: 0, ...gate }));

    return 0;
  }

  const config = researchConfig(env);
  const batches = planBatches(verdict.candidates, config);
  print(
    `LABEL TRIAGE WORKLIST: ${batches
      .flat()
      .map((label) => label.slug)
      .join(" ")}`,
  );

  const recorded = new Set<string>();
  const round = await runRound(
    verdict.candidates,
    config,
    {
      ...deps,
      record: async (slug, payload) => {
        await deps.record(slug, payload);
        recorded.add(slug);
      },
    },
    options.roundId ?? roundIdFor(now),
  );

  const left = unfinished(verdict.candidates, batches.flat(), recorded);
  let carryWritten = true;
  try {
    carry.write(left);
  } catch (error) {
    carryWritten = false;
    log(
      `could not write the carry-over: ${error instanceof Error ? error.message : String(error)}`,
    );
    if (round.ok) {
      round.ok = false;
      round.reason = "carry_unwritten";
      round.alerted = await deps
        .alert(
          `Fluncle label-triage: round ${round.roundId} could not save its unfinished labels (${left.length}); they wait for the threshold instead.`,
        )
        .catch(() => false);
    }
  }

  print(JSON.stringify({ gate: "fire", ...gate, ...round, carryWritten, unfinished: left.length }));

  return round.ok ? 0 : 1;
}

async function main(): Promise<void> {
  let labels: TriageLabel[];

  try {
    labels = readUndecided();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(message);
    const alerted = await postDiscordAlert(
      `Fluncle label-triage: could not read the undecided pile — ${message.slice(0, 300)}`,
    );
    console.log(JSON.stringify({ alerted, gate: "unread", ok: false, reason: "pile_unreadable" }));
    process.exit(1);
  }

  process.exitCode = await runSweep(process.env, labels, LIVE_DEPS);
}

if (import.meta.main) {
  await main();
}
