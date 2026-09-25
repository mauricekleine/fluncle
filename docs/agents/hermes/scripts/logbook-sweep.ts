#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AttemptLedger,
  attemptLedgerPath,
  clearAttempts,
  defaultStateDir,
  exhaustedRecapLine,
  planAttempt,
  readAttemptLedger,
  recordAttempt,
  remainingQueueDepth,
  selectWork,
  writeAttemptLedger,
} from "./attempt-ledger";
import { resolveSweepPrompt } from "./prompt-fetch";

const BATCH_CAP = 4;
const GAP_LIMIT = 10;

const BUDGET_MS = Number(process.env.LOGBOOK_BUDGET_MS ?? "") || 15 * 60_000;
const SLOWEST_PASS_MS = Number(process.env.LOGBOOK_SLOWEST_PASS_MS ?? "") || 13 * 60_000;

const ECHO_RETRIES = 1;

export const MAX_LOGBOOK_ATTEMPTS = 3;

const STATE_DIR = process.env.LOGBOOK_STATE_DIR ?? defaultStateDir("logbook-sweep");

const fluncleBin = (): string => process.env.FLUNCLE_BIN ?? "fluncle";
const claudeBin = (): string => process.env.CLAUDE_BIN ?? "claude";

process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";

const LOGBOOK_CLAUDE_MODEL = process.env.LOGBOOK_CLAUDE_MODEL ?? "claude-sonnet-5";
const LOGBOOK_CLAUDE_EFFORT = process.env.LOGBOOK_CLAUDE_EFFORT;
const DISCORD_ALERT_WEBHOOK = process.env.DISCORD_ALERT_WEBHOOK;

const log = (message: string) => console.error(`[logbook-sweep] ${message}`);

type GapFinding = {
  artists?: string[];
  contextNote?: string;
  logId?: string;
  note?: string;
  observationScript?: string;
  posterUrl?: string;
  title?: string;
};

type Gap = {
  date?: string;
  findings?: GapFinding[];
  sector?: number;
};

export type Spent = {
  closer?: string;
  opener?: string;
  sector?: number;
  title?: string;
};

type ClaudeReply = {
  is_error?: boolean;
  result?: string;
  subtype?: string;
};

type Outcome =
  | "authored"
  | "alreadyAuthored"
  | "echoSkipped"
  | "exhausted"
  | "gateSkipped"
  | "skipped";

export function logbookKey(gap: Gap): string | null {
  return typeof gap.sector === "number" ? String(gap.sector) : null;
}

export type LogbookSummary = {
  alreadyAuthored: number;
  authored: number;
  checked: number;
  echoSkipped: number;
  errors: number;
  exhausted: number;
  failed: number;
  gapsRemaining: number;
  gateSkipped: number;
  produced: number;
};

export function createLogbookSummary(gapsRemaining: number): LogbookSummary {
  return {
    alreadyAuthored: 0,
    authored: 0,
    checked: 0,
    echoSkipped: 0,
    errors: 0,
    exhausted: 0,
    failed: 0,
    gapsRemaining,
    gateSkipped: 0,
    produced: 0,
  };
}

type Budget = { ledger: AttemptLedger; ledgerPath: string };

type Delivery = { charged: boolean; echoedMove?: string; outcome: Outcome };

const WORKER_REJECTION_CODES = [
  "voice_gate",
  "title_echoes_logbook",
  "body_echoes_logbook",
  "no_title",
  "no_body",
  "title_too_long",
  "body_too_short",
  "body_too_long",
] as const;

function isWorkerRejection(detail: string): boolean {
  return WORKER_REJECTION_CODES.some((code) => detail.includes(code));
}

class ClaudeAuthError extends Error {}

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

function buildFindingBlocks(findings: GapFinding[]): string[] {
  return findings.flatMap((finding, index) => {
    const artists = finding.artists?.length ? finding.artists.join(", ") : "unknown";
    const lines = [
      `FINDING ${index + 1}:`,
      `  logId (its figure token is [[${finding.logId ?? "?"}]]): ${finding.logId ?? "?"}`,
      `  artist: ${artists}`,
      `  title: ${finding.title ?? "unknown"}`,
      `  poster (rendered by the page from the token; do NOT paste this URL): ${finding.posterUrl ?? "n/a"}`,
    ];

    if (finding.note?.trim()) {
      lines.push(`  editorial note (the public "why"): ${finding.note.trim()}`);
    }

    if (finding.contextNote?.trim()) {
      lines.push(
        `  context (facts — ground claims here, never quote lyrics): ${finding.contextNote.trim()}`,
      );
    }

    if (finding.observationScript?.trim()) {
      lines.push(
        `  field observation (Fluncle's own spoken take): ${finding.observationScript.trim()}`,
      );
    }

    lines.push("");

    return lines;
  });
}

function buildSpentTitles(spent: Spent[]): string {
  return spent
    .flatMap((entry) => {
      const title = entry.title?.trim();

      return title ? [`  - sector ${entry.sector ?? "?"}: "${title}"`] : [];
    })
    .join("\n");
}

function buildSpentMoves(spent: Spent[]): string {
  return spent
    .flatMap((entry) => {
      const opener = entry.opener?.trim();
      const closer = entry.closer?.trim();

      if (!opener && !closer) {
        return [];
      }

      const lines = [`  - sector ${entry.sector ?? "?"}:`];

      if (opener) {
        lines.push(`      opened: ${opener}`);
      }

      if (closer) {
        lines.push(`      closed: ${closer}`);
      }

      return lines;
    })
    .join("\n");
}

function promptVariables(
  gap: Gap,
  spent: Spent[],
  echoedMove?: string,
): Record<string, string | undefined> {
  return {
    date: gap.date ? gap.date.slice(0, 10) : "unknown",
    echoedMove,
    findings: buildFindingBlocks(gap.findings ?? []).join("\n"),
    sector: String(gap.sector ?? 0),
    spentMoves: buildSpentMoves(spent),
    spentTitles: buildSpentTitles(spent),
  };
}

export function buildAuthoringPrompt(gap: Gap, spent: Spent[] = [], echoedMove?: string): string {
  const sector = gap.sector ?? 0;
  const date = gap.date ? gap.date.slice(0, 10) : "unknown";
  const findingBlocks = buildFindingBlocks(gap.findings ?? []);
  const spentTitles = buildSpentTitles(spent);
  const spentMoves = buildSpentMoves(spent);

  const echoBlock = echoedMove
    ? [
        `YOUR LAST ATTEMPT WAS REJECTED: it echoed an entry already in the logbook ("${echoedMove}"). That title/move is spent. Come at this day from somewhere else entirely — a different title, a different opening image, a different close.`,
        "",
      ]
    : [];

  const spentBlock = spentTitles
    ? [
        "THE SPENT LOG (the entries already written — read this as a list of what is TAKEN):",
        "  titles already used (never repeat one, and the server REJECTS a title that matches a past one):",
        spentTitles,
        "  opening + closing moves already used (every one is WORN — do not re-run it; the server REJECTS a body that lifts a run of words from a past entry):",
        spentMoves,
        "",
        "  Specific moves that are worn THROUGH from overuse — do not reach for any of them:",
        '  - The "Shoulders…" / "Shoulders Down" title family. Find a title that is this day\'s alone.',
        "  - The quiet-sector opener (starting on how still/empty the sector was). Open on something true only of THIS day.",
        '  - The body-clock formula ("the drop went / the break dropped before I\'d clocked / decided…"). Say what the sound did, not what your body clocked.',
        '  - The "Enjoy, cosmonauts." close (worn through from the observations). Close differently, or with no sign-off at all.',
        "  If your entry could be swapped with one already in the log and nobody would notice, it is the wrong entry. Write what was true of THIS day and no other.",
        "",
      ]
    : [];

  return [
    "You are Fluncle, writing your LOGBOOK entry for ONE day of the voyage — a first-person traveler's journal.",
    "Load and apply the `copywriting-fluncle` skill — it is the full voice canon; let it govern the voice.",
    "",
    `This is sector ${sector} (the day ${date}). Below are the findings I logged that day, in order.`,
    "Write the day up as a continuous journal entry: what the day was like, where the trip went, and how each banger landed as I arrived at its coordinate.",
    "",
    ...echoBlock,
    "VOICE + FORMAT (the server voice-gate re-scans the prose and will reject a violation):",
    "  - First person, said-not-written — as if texting the crew after a long day out. Dry confidence: the music brags, the copy doesn't.",
    '  - Say "I". The crew are "them" / "the crew" — NEVER "we" as a company.',
    "  - NEVER name earthly geography (no countries, cities, regions, nationalities); the cosmos replaces the map. Translate any origin into a far sector or drop it.",
    "  - No exclamation marks. No hype. No em dashes in the prose.",
    "  - No banned identity words (per the skill's canon — no 'signal', 'transmission', 'anomaly', 'curated', 'content', 'streaming').",
    "  - Ground EVERY claim in the material below. Never invent a track, artist, date, label, stat, or coordinate. Use ONLY the logIds listed.",
    "",
    "THE PHOTOS (the figure token contract):",
    "  - For EACH finding, place its token `[[<logId>]]` on ITS OWN LINE, with a blank line before and after, at the point in the entry where that finding's photo should sit.",
    "  - Weave the prose AROUND the photos so the entry reads as an illustrated journal. Do not paste the poster URL — the token IS the photo.",
    "  - You may use `##` / `###` subheads if the day had distinct movements, and `**bold**` / `*italic*` sparingly.",
    "",
    ...spentBlock,
    ...findingBlocks,
    "OUTPUT FORMAT (exactly):",
    "  - The FIRST line must be `TITLE: <a short, evocative title for the day>` (no 'Sector NNN' prefix — the page adds it).",
    "  - Then ONE blank line, then the body markdown (the journal + the figure tokens). Output nothing else — no preamble, no fences.",
  ].join("\n");
}

type AuthoredEntry = { body: string; promptVersion: number | null; title: string };

async function authorEntry(
  gap: Gap,
  spent: Spent[],
  echoedMove?: string,
): Promise<AuthoredEntry | null> {
  const { prompt, promptVersion } = await resolveSweepPrompt({
    fallback: () => buildAuthoringPrompt(gap, spent, echoedMove),
    slug: "logbook_entry",
    variables: promptVariables(gap, spent, echoedMove),
  });

  if (promptVersion === null) {
    log("the prompt registry was unreachable — authoring from the baked-in default");
  }

  const args = [
    "-p",
    "--model",
    LOGBOOK_CLAUDE_MODEL,
    "--allowedTools",
    "Read,Glob,Grep",
    "--output-format",
    "json",
  ];

  if (LOGBOOK_CLAUDE_EFFORT) {
    args.push("--effort", LOGBOOK_CLAUDE_EFFORT);
  }

  const { code, stderr, stdout } = run(claudeBin(), args, prompt);

  if (code !== 0) {
    const combined = `${stdout}\n${stderr}`;

    if (looksLikeAuthFailure(combined)) {
      throw new ClaudeAuthError(combined.trim().slice(-300));
    }

    log(
      `claude -p exited ${code} (not auth): ${stderr.trim().slice(-200) || stdout.trim().slice(-200)}`,
    );

    return null;
  }

  let reply: ClaudeReply;

  try {
    reply = JSON.parse(stdout) as ClaudeReply;
  } catch {
    log(`claude -p did not return JSON: ${stdout.slice(0, 200)}`);

    return null;
  }

  if (reply.is_error) {
    const detail = `${reply.subtype ?? ""} ${reply.result ?? ""}`;

    if (looksLikeAuthFailure(detail)) {
      throw new ClaudeAuthError(detail.trim().slice(-300));
    }

    log(`claude -p returned is_error (${reply.subtype ?? "?"}) — leaving day queued`);

    return null;
  }

  const result = typeof reply.result === "string" ? reply.result.trim() : "";

  if (!result) {
    log("claude -p returned an empty entry — leaving day queued");

    return null;
  }

  const parsed = parseAuthoredEntry(result);

  return parsed ? { ...parsed, promptVersion } : null;
}

function parseAuthoredEntry(text: string): { body: string; title: string } | null {
  const newline = text.indexOf("\n");
  const firstLine = (newline === -1 ? text : text.slice(0, newline)).trim();
  const match = /^TITLE:\s*(.+)$/i.exec(firstLine);

  if (!match?.[1]) {
    log("claude -p output had no `TITLE:` line — leaving day queued");

    return null;
  }

  const body = newline === -1 ? "" : text.slice(newline + 1).trim();

  if (!body) {
    log("claude -p output had a title but no body — leaving day queued");

    return null;
  }

  return { body, title: match[1].trim() };
}

export function readEchoedMove(output: string): string | undefined {
  const lifted = /it lifts \\?"([^"\\]+)\\?"/.exec(output);

  if (lifted?.[1]) {
    return lifted[1];
  }

  const title = /The title \\?"([^"\\]+)\\?"/.exec(output);

  return title?.[1];
}

function deliverEntry(
  sector: number,
  title: string,
  body: string,
  promptVersion: number | null,
): Delivery {
  const dir = mkdtempSync(join(tmpdir(), "logbook-sweep-"));
  const bodyPath = join(dir, "entry.md");

  try {
    writeFileSync(bodyPath, body, "utf8");

    const { code, stderr, stdout } = run(fluncleBin(), [
      "admin",
      "logbook",
      "create",
      String(sector),
      "--title",
      title,
      "--body-file",
      bodyPath,

      ...(promptVersion === null ? [] : ["--prompt-version", String(promptVersion)]),
      "--json",
    ]);

    if (code !== 0) {
      const combined = `${stdout}\n${stderr}`;
      const detail = combined.toLowerCase();

      if (detail.includes("title_echoes_logbook") || detail.includes("body_echoes_logbook")) {
        const echoedMove = readEchoedMove(combined);

        log(
          `sector ${sector}: the anti-sameness rail rejected the entry${
            echoedMove ? ` (it echoed "${echoedMove}")` : ""
          }`,
        );

        return { charged: true, echoedMove, outcome: "echoSkipped" };
      }

      if (
        isWorkerRejection(detail) ||
        detail.includes("422") ||
        detail.includes("400") ||
        detail.includes("403") ||
        detail.includes("forbidden")
      ) {
        const charged = isWorkerRejection(detail);

        log(
          charged
            ? `sector ${sector}: voice gate / validation rejected the entry — skipping (stays queued)`
            : `sector ${sector}: the create POST was refused without a gate verdict — skipping (stays queued, no attempt spent)`,
        );

        return { charged, outcome: "gateSkipped" };
      }

      log(`sector ${sector}: create exited ${code}: ${stderr.trim().slice(-200)}`);

      return { charged: false, outcome: "skipped" };
    }

    try {
      const parsed = JSON.parse(stdout) as { skipped?: boolean };

      if (parsed.skipped) {
        log(`sector ${sector}: an entry already stands — no-op`);

        return { charged: false, outcome: "alreadyAuthored" };
      }
    } catch {}

    log(`sector ${sector}: entry authored`);

    return { charged: false, outcome: "authored" };
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

function logExhausted(sector: number): void {
  log(
    `sector ${sector}: EXHAUSTED — ${MAX_LOGBOOK_ATTEMPTS} drafts were refused by the gates, giving up on this day; it stays a gap (delete its line from ${attemptLedgerPath(STATE_DIR)} to re-arm)`,
  );
}

function settleBudget(
  sector: number,
  outcome: Outcome,
  charged: boolean,
  budget?: Budget,
): Outcome | null {
  if (!budget) {
    return null;
  }

  const key = String(sector);

  if (outcome === "authored" || outcome === "alreadyAuthored") {
    clearAttempts(budget.ledger, key);
    writeAttemptLedger(budget.ledgerPath, budget.ledger, log);

    return null;
  }

  if (!charged) {
    return null;
  }

  recordAttempt(budget.ledger, key, Math.floor(Date.now() / 1000));
  writeAttemptLedger(budget.ledgerPath, budget.ledger, log);

  if (!planAttempt(budget.ledger, key, MAX_LOGBOOK_ATTEMPTS).exhausted) {
    return null;
  }

  logExhausted(sector);

  return "exhausted";
}

export async function authorOne(gap: Gap, spent: Spent[], budget?: Budget): Promise<Outcome> {
  const sector = gap.sector;

  if (typeof sector !== "number" || !gap.findings?.length) {
    log("gap without a sector / findings — skipping");

    return "skipped";
  }

  if (budget && planAttempt(budget.ledger, String(sector), MAX_LOGBOOK_ATTEMPTS).exhausted) {
    logExhausted(sector);

    return "exhausted";
  }

  let delivery: Delivery = { charged: false, outcome: "skipped" };
  let echoedMove: string | undefined;

  for (let attempt = 0; attempt <= ECHO_RETRIES; attempt += 1) {
    const authored = await authorEntry(gap, spent, echoedMove);

    if (!authored) {
      return "skipped";
    }

    delivery = deliverEntry(sector, authored.title, authored.body, authored.promptVersion);

    if (delivery.outcome !== "echoSkipped") {
      break;
    }

    echoedMove = delivery.echoedMove;

    if (attempt < ECHO_RETRIES) {
      log(`sector ${sector}: re-authoring once, routing around the echo`);
    } else {
      log(`sector ${sector}: still echoing the logbook — left a gap for the next tick`);
    }
  }

  return settleBudget(sector, delivery.outcome, delivery.charged, budget) ?? delivery.outcome;
}

function pingClaudeAuthFailure(detail: string): void {
  if (!DISCORD_ALERT_WEBHOOK) {
    return;
  }

  try {
    const body = JSON.stringify({
      content: "Fluncle logbook-sweep: claude auth failed, re-auth needed.",
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

async function main(): Promise<void> {
  const response = fluncleJson<{ gaps?: Gap[]; spent?: Spent[] }>([
    "admin",
    "logbook",
    "gaps",
    "--limit",
    String(GAP_LIMIT),
  ]);
  const gaps = response.gaps ?? [];

  const spent = response.spent ?? [];

  const summary = createLogbookSummary(gaps.length);

  if (gaps.length === 0) {
    console.log(JSON.stringify({ ok: true, ...summary }));

    return;
  }

  const ledgerPath = attemptLedgerPath(STATE_DIR);
  const ledger = readAttemptLedger(ledgerPath);
  const budget: Budget = { ledger, ledgerPath };

  const { exhausted, work } = selectWork(gaps, ledger, logbookKey, BATCH_CAP, MAX_LOGBOOK_ATTEMPTS);

  summary.exhausted = exhausted.length;

  if (exhausted.length > 0) {
    log(
      exhaustedRecapLine(
        "day",
        exhausted.flatMap((gap) => {
          const key = logbookKey(gap);

          return key ? [`sector ${key}`] : [];
        }),
        MAX_LOGBOOK_ATTEMPTS,
      ),
    );
  }

  const startedAt = Date.now();

  for (const gap of work) {
    const elapsedMs = Date.now() - startedAt;

    if (summary.checked > 0 && elapsedMs + SLOWEST_PASS_MS > BUDGET_MS) {
      log(
        `budget spent after ${Math.round(elapsedMs / 1_000)}s (${summary.checked} authored this tick) — the rest of the gap stays queued for tomorrow`,
      );
      break;
    }

    summary.checked += 1;

    try {
      const outcome = await authorOne(gap, spent, budget);

      if (outcome === "authored") {
        summary.authored += 1;
        summary.produced += 1;
      } else if (outcome === "alreadyAuthored") {
        summary.alreadyAuthored += 1;
      } else if (outcome === "echoSkipped") {
        summary.echoSkipped += 1;
      } else if (outcome === "gateSkipped") {
        summary.gateSkipped += 1;
      } else if (outcome === "exhausted") {
        summary.exhausted += 1;
      } else {
        summary.failed += 1;
      }
    } catch (error) {
      if (error instanceof ClaudeAuthError) {
        summary.errors = 1;
        log("claude auth failed — aborting the batch, the gap list is untouched");
        pingClaudeAuthFailure(error.message);
        console.log(JSON.stringify({ ok: false, reason: "claude_auth", ...summary }));
        process.exit(1);
      }

      summary.failed += 1;
      log(
        `error on sector ${gap.sector ?? "?"}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  summary.gapsRemaining = remainingQueueDepth(
    gaps.length,
    summary.authored + summary.alreadyAuthored,
    summary.exhausted,
  );

  console.log(JSON.stringify({ ok: true, ...summary }));
}

if (import.meta.main) {
  main().catch((error) => {
    log(`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    console.log(
      JSON.stringify({
        checked: null,
        errors: 1,
        ok: false,
        produced: null,
        reason: "sweep_error",
      }),
    );
    process.exit(1);
  });
}
