#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type BoxCostEvent, emitCost, parseAuthoringSpend } from "./cost-emit";
import {
  databaseAdmissionYieldSummary,
  runDatabaseAdmissionPhase,
} from "./database-admission-phase";
import {
  dueWorkRepairPendingSummary,
  isDueWorkRepairPending,
  throwIfCliRepairPending,
} from "./due-work-repair-pending";

const BATCH_CAP = parsePositiveInt(process.env.ENTITY_BIO_BATCH_CAP, 1);
const QUEUE_LIMIT = 200;

export const MAX_BIO_ATTEMPTS = 3;

const STATE_DIR =
  process.env.ENTITY_BIO_STATE_DIR ??
  join(process.env.HOME ?? "/opt/data/home", ".entity-bio-sweep");

const fluncleBin = (): string => process.env.FLUNCLE_BIN ?? "fluncle";
const claudeBin = (): string => process.env.CLAUDE_BIN ?? "claude";

process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";

const ARTIST_BIO_CLAUDE_MODEL = process.env.ARTIST_BIO_CLAUDE_MODEL;
const LABEL_BIO_CLAUDE_MODEL = process.env.LABEL_BIO_CLAUDE_MODEL;
const ALBUM_BIO_CLAUDE_MODEL = process.env.ALBUM_BIO_CLAUDE_MODEL;
const ENTITY_BIO_CLAUDE_MODEL = process.env.ENTITY_BIO_CLAUDE_MODEL ?? "claude-sonnet-5";

const ENTITY_BIO_CLAUDE_EFFORT = process.env.ENTITY_BIO_CLAUDE_EFFORT;

const DISCORD_ALERT_WEBHOOK = process.env.DISCORD_ALERT_WEBHOOK;

const log = (message: string) => console.error(`[entity-bio-sweep] ${message}`);

export type EntityKind = "artist" | "label" | "album";

function groupForKind(kind: EntityKind): "artists" | "labels" | "albums" {
  return kind === "artist" ? "artists" : kind === "label" ? "labels" : "albums";
}

type QueueRow = {
  id?: string;
  name?: string;
  slug?: string;
};

type BioDraft = {
  findingCount?: number;
  found?: boolean;
  hasFacts?: boolean;
  name?: string;
  prompt?: string;
  promptVersion?: number;
};

type BioResult = {
  bio?: string;
  dryRun?: boolean;

  gateBypassed?: boolean;
  ok?: boolean;
  skipped?: boolean;
  slug?: string;

  voiceViolations?: string[];
};

type ClaudeReply = {
  is_error?: boolean;
  modelUsage?: Record<string, unknown>;
  result?: string;
  subtype?: string;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
};

export type BioOutcome = "authored" | "alreadyBio" | "exhausted" | "gateSkipped" | "skipped";

export type BioSweepSummary = {
  alreadyBio: number;
  authored: number;
  bypassedGate: number;
  checked: number;
  errors: number;
  exhausted: number;
  failed: number;
  gateSkipped: number;
  kind: EntityKind;
  produced: number;
};

export function createBioSweepSummary(kind: EntityKind): BioSweepSummary {
  return {
    alreadyBio: 0,
    authored: 0,
    bypassedGate: 0,
    checked: 0,
    errors: 0,
    exhausted: 0,
    failed: 0,
    gateSkipped: 0,
    kind,
    produced: 0,
  };
}

export function bioSweepOk(summary: Pick<BioSweepSummary, "errors">): boolean {
  return summary.errors === 0;
}

export function recordBioOutcome(
  summary: BioSweepSummary,
  outcome: BioOutcome,
  gateBypassed = false,
  stored = true,
): void {
  summary.checked += 1;

  if (gateBypassed) {
    summary.bypassedGate += 1;
  }

  if (outcome === "authored") {
    summary.authored += 1;

    if (stored) {
      summary.produced += 1;
    }
  } else if (outcome === "alreadyBio") {
    summary.alreadyBio += 1;
  } else if (outcome === "gateSkipped") {
    summary.gateSkipped += 1;
  } else if (outcome === "exhausted") {
    summary.exhausted += 1;
  } else {
    summary.failed += 1;
  }
}

export function buildBioFatalSummary(): Record<string, unknown> {
  return {
    checked: null,
    errors: 1,
    failed: null,
    ok: false,
    produced: null,
    reason: "sweep_error",
  };
}

type AuthoredBio = {
  bio: string;
  model: string;
  promptVersion: number | null;
  tokens: number;
  usd: number | null;
};

type DescribeResult = {
  cost: BoxCostEvent | null;

  gateBypassed?: boolean;
  outcome: BioOutcome;
};

type PhasedBioRead = Readonly<{
  exhausted: QueueRow[];
  queueLength: number;

  repairPending: boolean;
  work: ReadonlyArray<Readonly<{ draft: BioDraft | null; row: QueueRow }>>;
}>;

type PhasedBioWrite = Readonly<{
  authored: AuthoredBio;
  finalAttempt: boolean;
  slug: string;
}>;

type PhasedBioWriteResult = Readonly<{
  costWriteFailures: number;
  deliveries: ReadonlyArray<Readonly<{ delivery: Delivery; slug: string }>>;
}>;

class ClaudeAuthError extends Error {}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export type AttemptRecord = { attempts: number; lastAttemptEpoch: number };
export type AttemptLedger = Map<string, AttemptRecord>;

export function attemptKey(kind: EntityKind, slug: string): string {
  return `${kind}:${slug}`;
}

export function attemptLedgerPath(): string {
  return join(STATE_DIR, "attempts");
}

export function parseAttemptLedger(text: string): AttemptLedger {
  const ledger: AttemptLedger = new Map();

  for (const line of text.split("\n")) {
    const [key, attempts, epoch] = line.split("\t");
    const parsed = Number.parseInt(attempts ?? "", 10);

    if (!key || !Number.isFinite(parsed) || parsed <= 0) {
      continue;
    }

    const parsedEpoch = Number.parseInt(epoch ?? "", 10);

    ledger.set(key, {
      attempts: parsed,
      lastAttemptEpoch: Number.isFinite(parsedEpoch) ? parsedEpoch : 0,
    });
  }

  return ledger;
}

export function formatAttemptLedger(ledger: AttemptLedger): string {
  return [...ledger.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, record]) => `${key}\t${record.attempts}\t${record.lastAttemptEpoch}`)
    .join("\n");
}

export function planAttempt(
  ledger: AttemptLedger,
  kind: EntityKind,
  slug: string,
): { attempt: number; exhausted: boolean; final: boolean; spent: number } {
  const spent = ledger.get(attemptKey(kind, slug))?.attempts ?? 0;
  const attempt = spent + 1;

  return {
    attempt,
    exhausted: spent >= MAX_BIO_ATTEMPTS,
    final: attempt >= MAX_BIO_ATTEMPTS,
    spent,
  };
}

export function recordAttempt(
  ledger: AttemptLedger,
  kind: EntityKind,
  slug: string,
  nowEpoch: number,
): AttemptLedger {
  const key = attemptKey(kind, slug);

  ledger.set(key, {
    attempts: (ledger.get(key)?.attempts ?? 0) + 1,
    lastAttemptEpoch: nowEpoch,
  });

  return ledger;
}

export function clearAttempts(
  ledger: AttemptLedger,
  kind: EntityKind,
  slug: string,
): AttemptLedger {
  ledger.delete(attemptKey(kind, slug));

  return ledger;
}

export function selectBioWork(
  queue: readonly QueueRow[],
  ledger: AttemptLedger,
  kind: EntityKind,
  cap: number,
): { exhausted: QueueRow[]; work: QueueRow[] } {
  const exhausted: QueueRow[] = [];
  const workable: QueueRow[] = [];

  for (const row of queue) {
    if (row.slug && planAttempt(ledger, kind, row.slug).exhausted) {
      exhausted.push(row);
      continue;
    }

    workable.push(row);
  }

  return { exhausted, work: workable.slice(0, cap) };
}

function readAttemptLedger(path: string): AttemptLedger {
  try {
    return parseAttemptLedger(readFileSync(path, "utf8"));
  } catch {
    return new Map();
  }
}

function writeAttemptLedger(path: string, ledger: AttemptLedger): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${formatAttemptLedger(ledger)}\n`, "utf8");
  } catch (error) {
    log(
      `could not persist the attempt ledger (${error instanceof Error ? error.message : String(error)}) — the budget may be re-spent next tick`,
    );
  }
}

function run(
  bin: string,
  args: string[],
  input?: string,
): { code: number; stderr: string; stdout: string } {
  const result = spawnSync(bin, args, {
    encoding: "utf8",
    input,
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error) {
    throw new Error(`failed to spawn ${bin}: ${result.error.message}`);
  }

  return {
    code: result.status ?? 1,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}

function fluncleJson<T>(args: string[]): T {
  const { code, stderr, stdout } = run(fluncleBin(), [...args, "--json"]);

  if (code !== 0) {
    throwIfCliRepairPending(`fluncle ${args.join(" ")}`, code, stdout);
    throw new Error(`fluncle ${args.join(" ")} exited ${code}: ${stderr.trim()}`);
  }

  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error(`fluncle ${args.join(" ")} did not return JSON: ${stdout.slice(0, 200)}`);
  }
}

const AUTH_SIGNATURES = [
  "invalid api key",
  "authentication_error",
  "oauth token",
  "oauth_token",
  "please run /login",
  "please run `claude /login`",
  "run claude login",
  "claude setup-token",
  "not logged in",
  "unauthorized",
  "401",
  "credit balance is too low",
];

function looksLikeAuthFailure(text: string): boolean {
  const haystack = text.toLowerCase();

  return AUTH_SIGNATURES.some((signature) => haystack.includes(signature));
}

function fetchBioDraft(group: "artists" | "labels" | "albums", slug: string): BioDraft | null {
  try {
    return fluncleJson<BioDraft>(["admin", group, "draft-bio", slug]);
  } catch (error) {
    log(
      `${slug}: draft-bio failed (${
        error instanceof Error ? error.message : String(error)
      }) — skipping (stays queued)`,
    );

    return null;
  }
}

export function isAuthorableDraft(draft: BioDraft | null): draft is BioDraft & { prompt: string } {
  return (
    draft != null &&
    draft.found === true &&
    typeof draft.prompt === "string" &&
    draft.prompt.trim().length > 0 &&
    (draft.hasFacts === true || (draft.findingCount ?? 0) > 0)
  );
}

export function readBioRejection(output: string): string | undefined {
  const raw =
    /The bio fails the voice gate: ([^\n]+)/.exec(output)?.[1] ??
    /The bio is too (?:short|long) \([^)]*\)/.exec(output)?.[0];

  if (!raw) {
    return undefined;
  }

  return raw

    .replace(/\\"/g, '"')

    .replace(/"\s*[,}].*$/, "")
    .trim();
}

export function buildRewriteBlock(rejection: string | undefined, attempt: number): string {
  if (attempt <= 1) {
    return "";
  }

  const reason = rejection
    ? `it was refused because: ${rejection}`
    : "it was refused by the voice gate (no reason was recoverable)";

  return [
    `YOUR LAST DRAFT WAS REJECTED — ${reason}.`,
    "Write the paragraph again from the same facts, wording it so that reason no longer applies. Do not invent new facts to route around it, and do not pad the length; change the phrasing.",

    "Keep the dossier register — dry, scene-literate, sentence case, plain facts; do not go generic to dodge the word.",
    "",
    "",
  ].join("\n");
}

async function authorBio(
  kind: EntityKind,
  prompt: string,
  promptVersion: number,
): Promise<AuthoredBio | null> {
  const args = [
    "-p",
    "--model",
    modelForKind(kind),
    "--allowedTools",
    "Read,Glob,Grep",
    "--output-format",
    "json",
  ];

  if (ENTITY_BIO_CLAUDE_EFFORT) {
    args.push("--effort", ENTITY_BIO_CLAUDE_EFFORT);
  }

  const { code, stderr, stdout } = run(claudeBin(), args, prompt);

  if (code !== 0) {
    const combined = `${stdout}\n${stderr}`;

    if (looksLikeAuthFailure(combined)) {
      throw new ClaudeAuthError(combined.trim().slice(-300));
    }

    log(
      `claude -p exited ${code} (not auth), no attempt spent — retrying next tick: ${stderr.trim().slice(-200) || stdout.trim().slice(-200)}`,
    );

    return null;
  }

  let reply: ClaudeReply;

  try {
    reply = JSON.parse(stdout) as ClaudeReply;
  } catch {
    log(
      `claude -p did not return JSON, no attempt spent — retrying next tick: ${stdout.slice(0, 200)}`,
    );

    return null;
  }

  if (reply.is_error) {
    const detail = `${reply.subtype ?? ""} ${reply.result ?? ""}`;

    if (looksLikeAuthFailure(detail)) {
      throw new ClaudeAuthError(detail.trim().slice(-300));
    }

    log(
      `claude -p returned is_error (${reply.subtype ?? "?"}), no attempt spent — retrying next tick`,
    );

    return null;
  }

  const bio = typeof reply.result === "string" ? reply.result.trim() : "";

  if (!bio) {
    log("claude -p returned an empty bio, no attempt spent — retrying next tick");

    return null;
  }

  return { bio, promptVersion, ...parseAuthoringSpend(reply, modelForKind(kind)) };
}

export function bioCostEvent(input: {
  authored: AuthoredBio | null;
  dryRun: boolean;
  outcome: BioOutcome;
  slug: string;
}): BoxCostEvent | null {
  const { authored, dryRun, outcome, slug } = input;

  if (outcome !== "authored" || dryRun || !authored) {
    return null;
  }

  return {
    costBasis: "subsidized",
    logId: slug,
    model: authored.model,
    occurredAt: new Date().toISOString(),
    quantity: authored.tokens,
    source: "measured",
    step: "bio",
    trackId: null,
    unitType: "tokens",
    usd: authored.usd,
    vendor: "anthropic",
  };
}

function modelForKind(kind: EntityKind): string {
  const perKind =
    kind === "artist"
      ? ARTIST_BIO_CLAUDE_MODEL
      : kind === "label"
        ? LABEL_BIO_CLAUDE_MODEL
        : ALBUM_BIO_CLAUDE_MODEL;

  return perKind ?? ENTITY_BIO_CLAUDE_MODEL;
}

type Delivery = { gateBypassed: boolean; outcome: BioOutcome; rejection?: string };

function deliverBio(input: {
  bio: string;
  dryRun?: boolean;
  finalAttempt?: boolean;
  kind: EntityKind;
  promptVersion: number | null;
  slug: string;
}): Delivery {
  const { bio, dryRun = false, finalAttempt = false, kind, promptVersion, slug } = input;
  const group = groupForKind(kind);
  const dir = mkdtempSync(join(tmpdir(), "entity-bio-sweep-"));
  const bioPath = join(dir, "bio.txt");

  try {
    writeFileSync(bioPath, bio, "utf8");

    const { code, stderr, stdout } = run(fluncleBin(), [
      "admin",
      group,
      "describe",
      slug,
      "--bio-file",
      bioPath,

      ...(promptVersion === null ? [] : ["--prompt-version", String(promptVersion)]),
      ...(dryRun ? ["--dry-run"] : []),
      ...(finalAttempt ? ["--final-attempt"] : []),
      "--json",
    ]);

    if (code !== 0) {
      const combined = `${stdout}\n${stderr}`;
      const detail = combined.toLowerCase();

      if (
        detail.includes("voice_gate") ||
        detail.includes("bio_too_short") ||
        detail.includes("bio_too_long") ||
        detail.includes("no_bio") ||
        detail.includes("403") ||
        detail.includes("422") ||
        detail.includes("forbidden")
      ) {
        const rejection = readBioRejection(combined);

        log(
          `${slug}: draft did not clear the voice gate / length bounds${rejection ? ` (${rejection})` : ""}`,
        );

        return { gateBypassed: false, outcome: "gateSkipped", rejection };
      }

      log(`${slug}: describe exited ${code}: ${stderr.trim().slice(-200)}`);

      return { gateBypassed: false, outcome: "skipped" };
    }

    let parsed: BioResult | undefined;

    try {
      parsed = JSON.parse(stdout) as BioResult;
    } catch {}

    if (parsed?.skipped) {
      log(`${slug}: a bio is already on file — operator bio stands, no-op`);

      return { gateBypassed: false, outcome: "alreadyBio" };
    }

    if (parsed?.gateBypassed) {
      log(
        `${slug}: FINAL-ATTEMPT ACCEPTANCE — stored a bio the voice gate refused${
          dryRun ? " (dry run, nothing stored)" : ""
        }: ${(parsed.voiceViolations ?? []).join("; ") || "(no reasons reported)"} — REVIEW THIS ${kind.toUpperCase()}`,
      );

      return { gateBypassed: true, outcome: "authored" };
    }

    log(`${slug}: bio ${dryRun ? "cleared the voice gate (dry run, nothing stored)" : "authored"}`);

    return { gateBypassed: false, outcome: "authored" };
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

function logExhausted(kind: EntityKind, slug: string): void {
  log(
    `${slug}: EXHAUSTED — ${MAX_BIO_ATTEMPTS} drafts were rejected, giving up on this ${kind} (delete its line from ${attemptLedgerPath()} to re-arm)`,
  );
}

async function describeOneWithOptions(
  kind: EntityKind,
  row: QueueRow,
  options: { dryRun: boolean; ledger?: AttemptLedger; ledgerPath?: string },
): Promise<DescribeResult> {
  const { dryRun, ledger, ledgerPath } = options;
  const slug = row.slug;

  if (!slug) {
    log("queue row without a slug — skipping");

    return { cost: null, outcome: "skipped" };
  }

  if (ledger && planAttempt(ledger, kind, slug).exhausted) {
    logExhausted(kind, slug);

    return { cost: null, outcome: "exhausted" };
  }

  const group = groupForKind(kind);

  const draft = fetchBioDraft(group, slug);

  if (!isAuthorableDraft(draft)) {
    if (draft && !draft.found) {
      log(`${slug}: the Worker did not resolve the ${kind} — skipping (stays queued)`);
    }

    return { cost: null, outcome: "skipped" };
  }

  const name = draft.name ?? slug;

  if (draft.hasFacts) {
    log(`${slug}: authoring with Worker-gathered Firecrawl facts`);
  }

  let authored: AuthoredBio | null = null;
  let delivery: Delivery = { gateBypassed: false, outcome: "skipped" };
  let rejection: string | undefined;

  for (;;) {
    const plan = ledger
      ? planAttempt(ledger, kind, slug)
      : { attempt: 1, exhausted: false, final: false, spent: 0 };

    if (plan.exhausted) {
      logExhausted(kind, slug);

      return { cost: null, outcome: "exhausted" };
    }

    if (plan.attempt > 1) {
      log(
        `${slug}: re-authoring (attempt ${plan.attempt} of ${MAX_BIO_ATTEMPTS})${
          plan.final ? " — the LAST one; its draft lands even if the gate refuses it" : ""
        }`,
      );
    }

    authored = await authorBio(
      kind,
      `${buildRewriteBlock(rejection, plan.attempt)}${draft.prompt}`,
      draft.promptVersion ?? 0,
    );

    if (!authored) {
      return { cost: null, outcome: "skipped" };
    }

    delivery = deliverBio({
      bio: authored.bio,
      dryRun,
      finalAttempt: plan.final,
      kind,
      promptVersion: authored.promptVersion,
      slug,
    });

    if (delivery.outcome !== "gateSkipped" || !ledger) {
      break;
    }

    rejection = delivery.rejection;
    recordAttempt(ledger, kind, slug, Math.floor(Date.now() / 1000));

    if (ledgerPath) {
      writeAttemptLedger(ledgerPath, ledger);
    }

    if (planAttempt(ledger, kind, slug).exhausted) {
      log(
        `${slug}: EXHAUSTED — the last of ${MAX_BIO_ATTEMPTS} drafts was still rejected${
          rejection ? ` (${rejection})` : ""
        }; giving up on this ${kind}, it stays bio-less`,
      );

      return { cost: null, outcome: "exhausted" };
    }
  }

  const outcome = delivery.outcome;

  if (ledger && ledgerPath && (outcome === "authored" || outcome === "alreadyBio")) {
    clearAttempts(ledger, kind, slug);
    writeAttemptLedger(ledgerPath, ledger);
  }

  if (dryRun) {
    console.error(`\n── ${slug} — ${name}`);
    console.error(`   facts: ${draft.hasFacts ? "Worker-gathered" : "(none)"}`);
    console.error(`   BIO: ${authored.bio}`);
    console.error(
      `   prompt: ${
        authored.promptVersion === null
          ? "the baked-in default"
          : authored.promptVersion === 0
            ? "the registry default (v0)"
            : `override v${authored.promptVersion}`
      }`,
    );
    console.error(`   verdict: ${outcome}\n`);
  }

  return {
    cost: bioCostEvent({ authored, dryRun, outcome, slug }),
    gateBypassed: delivery.gateBypassed,
    outcome,
  };
}

export function describeOne(
  kind: EntityKind,
  row: QueueRow,
  options: { dryRun?: boolean; ledger?: AttemptLedger; ledgerPath?: string } = {},
): Promise<DescribeResult> {
  return describeOneWithOptions(kind, row, { ...options, dryRun: options.dryRun ?? false });
}

function pingClaudeAuthFailure(kind: EntityKind, detail: string): void {
  if (!DISCORD_ALERT_WEBHOOK) {
    return;
  }

  try {
    const body = JSON.stringify({
      content: `Fluncle ${kind}-bio-sweep: claude auth failed, re-auth needed.`,
    });
    const { code } = run("curl", [
      "-sS",
      "-X",
      "POST",
      "-H",
      "Content-Type: application/json",
      "-d",
      body,
      "--max-time",
      "10",
      DISCORD_ALERT_WEBHOOK,
    ]);

    if (code !== 0) {
      log(`discord alert POST exited ${code} (best-effort, ignored)`);
    }
  } catch (error) {
    log(
      `discord alert failed (best-effort, ignored): ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  log(`claude auth failure detail (tail): ${detail}`);
}

function parseKind(argv: string[]): EntityKind {
  const index = argv.indexOf("--kind");
  const value = index >= 0 ? argv[index + 1] : undefined;

  if (value !== "artist" && value !== "label" && value !== "album") {
    log("usage: entity-bio-sweep.ts --kind <artist|label|album> [--dry-run <slug…>]");
    process.exit(2);
  }

  return value;
}

export function exhaustedRecapLine(kind: EntityKind, exhausted: readonly QueueRow[]): string {
  const slugs = exhausted
    .map((row) => row.slug)
    .filter(Boolean)
    .slice(0, 10)
    .join(", ");

  return `not working ${exhausted.length} exhausted ${kind}(s) — ${MAX_BIO_ATTEMPTS} drafts spent each (${slugs})`;
}

function argumentValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function phaseCommand(kind: EntityKind, phase: "read" | "write", statePath: string): string[] {
  return [
    process.execPath,
    import.meta.path,
    "--kind",
    kind,
    "--admission-phase",
    phase,
    "--phase-state",
    statePath,
  ];
}

async function runBioReadPhase(kind: EntityKind, statePath: string): Promise<void> {
  const group = groupForKind(kind);
  let queue: QueueRow[];

  try {
    queue = fluncleJson<QueueRow[]>([
      "admin",
      group,
      "describe",
      "--queue",
      "--limit",
      String(QUEUE_LIMIT),
    ]);
  } catch (error) {
    if (!isDueWorkRepairPending(error)) {
      throw error;
    }

    log(error.message);
    const deferred: PhasedBioRead = {
      exhausted: [],
      queueLength: 0,
      repairPending: true,
      work: [],
    };
    writeFileSync(statePath, JSON.stringify(deferred), "utf8");

    return;
  }

  const ledger = readAttemptLedger(attemptLedgerPath());
  const { exhausted, work } = selectBioWork(queue, ledger, kind, BATCH_CAP);
  const state: PhasedBioRead = {
    exhausted,
    queueLength: queue.length,
    repairPending: false,
    work: work.map((row) => ({
      draft: row.slug ? fetchBioDraft(group, row.slug) : null,
      row,
    })),
  };

  writeFileSync(statePath, JSON.stringify(state), "utf8");
}

async function runBioWritePhase(kind: EntityKind, statePath: string): Promise<void> {
  const writes = readJsonFile<PhasedBioWrite[]>(statePath);
  const deliveries: Array<{ delivery: Delivery; slug: string }> = [];
  const costs: BoxCostEvent[] = [];

  for (const write of writes) {
    const delivery = deliverBio({
      bio: write.authored.bio,
      finalAttempt: write.finalAttempt,
      kind,
      promptVersion: write.authored.promptVersion,
      slug: write.slug,
    });
    deliveries.push({ delivery, slug: write.slug });
    const cost = bioCostEvent({
      authored: write.authored,
      dryRun: false,
      outcome: delivery.outcome,
      slug: write.slug,
    });

    if (cost) {
      costs.push(cost);
    }
  }

  const costWriteFailures = (await emitCost(costs)).failed;
  const result: PhasedBioWriteResult = { costWriteFailures, deliveries };
  writeFileSync(`${statePath}.result`, JSON.stringify(result), "utf8");
}

type PendingBio = {
  draft: BioDraft & { prompt: string };
  rejection?: string;
  row: QueueRow & { slug: string };
};

async function runPhasedBioMain(kind: EntityKind): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "entity-bio-phases-"));
  const readStatePath = join(directory, "read.json");
  const owner = `fluncle-${kind}-bio`;

  try {
    const readPhase = runDatabaseAdmissionPhase({
      command: phaseCommand(kind, "read", readStatePath),
      owner,
      yieldRetries: 0,
    });

    if (readPhase.kind === "yielded") {
      console.log(
        JSON.stringify(databaseAdmissionYieldSummary({ checked: 0, kind, queueDepth: null })),
      );
      return;
    }

    const readState = readJsonFile<PhasedBioRead>(readStatePath);

    if (readState.repairPending) {
      console.log(
        JSON.stringify(dueWorkRepairPendingSummary({ checked: 0, kind, queueDepth: null })),
      );
      return;
    }

    const summary = createBioSweepSummary(kind);
    const ledgerPath = attemptLedgerPath();
    const ledger = readAttemptLedger(ledgerPath);
    summary.exhausted = readState.exhausted.length;

    if (readState.queueLength === 0) {
      console.log(JSON.stringify({ ok: bioSweepOk(summary), ...summary }));
      return;
    }

    if (readState.exhausted.length > 0) {
      log(exhaustedRecapLine(kind, readState.exhausted));
    }

    let pending: PendingBio[] = [];

    for (const candidate of readState.work) {
      const slug = candidate.row.slug;
      if (!slug || !isAuthorableDraft(candidate.draft)) {
        if (candidate.draft?.found === false && slug) {
          log(`${slug}: the Worker did not resolve the ${kind} — skipping (stays queued)`);
        }
        recordBioOutcome(summary, "skipped");
        continue;
      }

      pending.push({ draft: candidate.draft, row: { ...candidate.row, slug } });
    }

    let costWriteFailures = 0;

    while (pending.length > 0) {
      const writes: PhasedBioWrite[] = [];
      const attempted = new Map<string, { authored: AuthoredBio; pending: PendingBio }>();

      for (const item of pending) {
        const plan = planAttempt(ledger, kind, item.row.slug);
        if (plan.exhausted) {
          logExhausted(kind, item.row.slug);
          recordBioOutcome(summary, "exhausted");
          continue;
        }
        if (plan.attempt > 1) {
          log(
            `${item.row.slug}: re-authoring (attempt ${plan.attempt} of ${MAX_BIO_ATTEMPTS})${
              plan.final ? " — the LAST one; its draft lands even if the gate refuses it" : ""
            }`,
          );
        }

        const authored = await authorBio(
          kind,
          `${buildRewriteBlock(item.rejection, plan.attempt)}${item.draft.prompt}`,
          item.draft.promptVersion ?? 0,
        );
        if (!authored) {
          recordBioOutcome(summary, "skipped");
          continue;
        }

        writes.push({ authored, finalAttempt: plan.final, slug: item.row.slug });
        attempted.set(item.row.slug, { authored, pending: item });
      }

      if (writes.length === 0) {
        break;
      }

      const writeStatePath = join(directory, `write-${summary.checked}.json`);
      writeFileSync(writeStatePath, JSON.stringify(writes), "utf8");
      const writePhase = runDatabaseAdmissionPhase({
        command: phaseCommand(kind, "write", writeStatePath),
        owner,

        yieldRetries: 1,
      });

      if (writePhase.kind === "yielded") {
        console.log(
          JSON.stringify(
            databaseAdmissionYieldSummary({
              ...summary,
              checked: summary.checked + writes.length,
              costWriteFailures,
              produced: summary.produced,
            }),
          ),
        );
        return;
      }

      const writeResult = readJsonFile<PhasedBioWriteResult>(`${writeStatePath}.result`);
      costWriteFailures += writeResult.costWriteFailures;
      const next: PendingBio[] = [];

      for (const result of writeResult.deliveries) {
        const source = attempted.get(result.slug);
        if (!source) {
          throw new Error(`bio write phase returned unknown slug ${result.slug}`);
        }

        if (result.delivery.outcome === "gateSkipped") {
          recordAttempt(ledger, kind, result.slug, Math.floor(Date.now() / 1000));
          writeAttemptLedger(ledgerPath, ledger);
          if (planAttempt(ledger, kind, result.slug).exhausted) {
            log(
              `${result.slug}: EXHAUSTED — the last of ${MAX_BIO_ATTEMPTS} drafts was still rejected${
                result.delivery.rejection ? ` (${result.delivery.rejection})` : ""
              }; giving up on this ${kind}, it stays bio-less`,
            );
            recordBioOutcome(summary, "exhausted");
          } else {
            next.push({ ...source.pending, rejection: result.delivery.rejection });
          }
          continue;
        }

        if (result.delivery.outcome === "authored" || result.delivery.outcome === "alreadyBio") {
          clearAttempts(ledger, kind, result.slug);
          writeAttemptLedger(ledgerPath, ledger);
        }
        recordBioOutcome(summary, result.delivery.outcome, result.delivery.gateBypassed);
      }

      pending = next;
    }

    console.log(JSON.stringify({ costWriteFailures, ok: bioSweepOk(summary), ...summary }));
  } catch (error) {
    if (error instanceof ClaudeAuthError) {
      log("claude auth failed — aborting the batch, the queue is untouched");
      pingClaudeAuthFailure(kind, error.message);
      console.log(
        JSON.stringify({
          ...createBioSweepSummary(kind),
          errors: 1,
          ok: false,
          reason: "claude_auth",
        }),
      );
      process.exitCode = 1;
      return;
    }

    throw error;
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const kind = parseKind(argv);
  const admissionPhase = argumentValue(argv, "--admission-phase");
  const phaseStatePath = argumentValue(argv, "--phase-state");

  if (admissionPhase) {
    if (!phaseStatePath || (admissionPhase !== "read" && admissionPhase !== "write")) {
      throw new Error("invalid entity-bio admission phase invocation");
    }
    if (admissionPhase === "read") {
      await runBioReadPhase(kind, phaseStatePath);
    } else {
      await runBioWritePhase(kind, phaseStatePath);
    }
    return;
  }

  const dryRunSlugs = argv.includes("--dry-run")
    ? argv.filter((arg, index) => !arg.startsWith("-") && argv[index - 1] !== "--kind")
    : [];

  if (dryRunSlugs.length > 0) {
    log(`DRY RUN over ${dryRunSlugs.length} ${kind}(s) — nothing will be stored`);

    const outcomes: Record<string, string> = {};
    const summary = createBioSweepSummary(kind);

    for (const slug of dryRunSlugs) {
      try {
        const { gateBypassed, outcome } = await describeOne(
          kind,
          { name: slug, slug },
          { dryRun: true },
        );
        outcomes[slug] = outcome;

        recordBioOutcome(summary, outcome, gateBypassed, false);
      } catch (error) {
        outcomes[slug] = "failed";
        recordBioOutcome(summary, "skipped");

        if (error instanceof ClaudeAuthError) {
          summary.errors += 1;
        }

        log(`error on ${slug}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    console.log(
      JSON.stringify({ gateState: "dry-run", ok: bioSweepOk(summary), outcomes, ...summary }),
    );

    return;
  }

  await runPhasedBioMain(kind);
}

if (import.meta.main) {
  main().catch((error) => {
    log(`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    console.log(JSON.stringify(buildBioFatalSummary()));
    process.exit(1);
  });
}
