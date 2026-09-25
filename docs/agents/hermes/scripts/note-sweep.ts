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
import { type BoxCostEvent, emitCost, parseAuthoringSpend } from "./cost-emit";
import {
  dueWorkRepairPendingSummary,
  isDueWorkRepairPending,
  throwIfCliRepairPending,
} from "./due-work-repair-pending";
import { resolveSweepPrompt } from "./prompt-fetch";

const BATCH_CAP = 1;
const QUEUE_LIMIT = 50;

const NEIGHBOR_LIMIT = 6;

const ECHO_RETRIES = 1;

export const MAX_NOTE_ATTEMPTS = 3;

const STATE_DIR = process.env.NOTE_STATE_DIR ?? defaultStateDir("note-sweep");

const fluncleBin = (): string => process.env.FLUNCLE_BIN ?? "fluncle";
const claudeBin = (): string => process.env.CLAUDE_BIN ?? "claude";

process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";

const NEIGHBORS_ENABLED = process.env.NOTE_NEIGHBORS !== "0";

const NOTE_CLAUDE_MODEL = process.env.NOTE_CLAUDE_MODEL ?? "claude-sonnet-5";

const NOTE_CLAUDE_EFFORT = process.env.NOTE_CLAUDE_EFFORT;

const DISCORD_ALERT_WEBHOOK = process.env.DISCORD_ALERT_WEBHOOK;

const log = (message: string) => console.error(`[note-sweep] ${message}`);

type QueueFinding = {
  logId?: string;
  trackId?: string;
};

type Finding = {
  artists?: string[];
  bpm?: number;
  galaxy?: { key?: string; name?: string };
  key?: string;
  label?: string;
  logId?: string;
  note?: string;
  releaseDate?: string;
  title?: string;
  trackId?: string;
};

export type Neighbor = {
  artists: string[];
  logId: string;
  note: string;
  title: string;
};

type SimilarResponse = { findings?: Finding[] };

type TrackGetResponse = { mixtape?: unknown; track?: Finding };

type ClaudeUsage = {
  input_tokens?: number;
  output_tokens?: number;
};

type ClaudeReply = {
  is_error?: boolean;
  modelUsage?: Record<string, unknown>;
  result?: string;
  subtype?: string;
  total_cost_usd?: number;
  usage?: ClaudeUsage;
};

type Outcome = "noted" | "alreadyNoted" | "exhausted" | "gateSkipped" | "echoSkipped" | "skipped";

export function noteKey(queued: QueueFinding): string | null {
  return queued.trackId ?? queued.logId ?? null;
}

type Budget = { ledger: AttemptLedger; ledgerPath: string };

type Delivery = { charged: boolean; echoedPhrase?: string; outcome: Outcome };

const WORKER_REJECTION_CODES = [
  "voice_gate",
  "note_echoes_neighbours",
  "no_note",
  "note_too_short",
  "note_too_long",
] as const;

function isWorkerRejection(detail: string): boolean {
  return WORKER_REJECTION_CODES.some((code) => detail.includes(code));
}

type AuthoredNote = {
  model: string;
  note: string;

  promptVersion: number | null;
  tokens: number;
  usd: number | null;
};

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

export function buildAuthoringPrompt(
  finding: Finding,
  contextNote: string,
  neighbors: Neighbor[] = [],
  echoedPhrase?: string,
): string {
  const artists = finding.artists?.length ? finding.artists.join(", ") : "unknown";
  const title = finding.title ?? "unknown";
  const label = finding.label ?? "unknown";
  const year = finding.releaseDate ? finding.releaseDate.slice(0, 4) : "unknown";
  const galaxy = finding.galaxy?.name ?? "unplaced";
  const bpm = typeof finding.bpm === "number" ? `${Math.round(finding.bpm)}` : "unknown";
  const key = finding.key ?? "unknown";

  const noteBlock = contextNote
    ? [
        "CONTEXT NOTE (the gathered facts — your PRIMARY material; ground the note in these):",
        contextNote,
        "",
      ]
    : [
        "(No context note on file — author from the identity facts below alone; stay sparse and certain.)",
        "",
      ];

  const neighborBlock =
    neighbors.length > 0
      ? [
          "THE SONIC NEIGHBOURHOOD (the findings that sound nearest to this one, and the notes already standing on them):",
          ...neighbors.map(
            (neighbor) =>
              `  - ${neighbor.artists.join(", ")} — ${neighbor.title}: "${neighbor.note}"`,
          ),
          "",
          "USE THEM AS THE LIST OF WHAT IS ALREADY TAKEN.",
          "  - They tell you the REGISTER of this corner of the archive: how certain, how dry, how bodily.",
          "  - Every image, verb, body part, and closing move in them is SPENT. Do not reuse one. Not the shoulders, not the rewind, not the phrasing, not the sentence shape.",
          "  - The server REJECTS a note that lifts a run of words from any of them, and it rejects one that just reshuffles their words. A rejected note is not stored at all.",
          "  - If your line could be swapped with one of these and nobody would notice, it is the wrong line. Say what is true of THIS record and nothing else.",
          "",
        ]
      : [];

  const echoBlock = echoedPhrase
    ? [
        `YOUR LAST ATTEMPT WAS REJECTED: it echoed a neighbour ("${echoedPhrase}"). That move is spent. Come at this record from somewhere else entirely — a different sense, a different moment in the track, a different reason it stayed with you.`,
        "",
      ]
    : [];

  return [
    "You are Fluncle, writing the WRITTEN editorial note for one finding — the line that shows on its /log page.",
    "Load and apply the `copywriting-fluncle` skill — it is the full voice canon; let it govern the voice.",
    "",
    "This is the finding-note register: Fluncle's dry, confident 'why this is here', as if texting the crew.",
    "Ground every claim in the facts below. Never invent a track, artist, date, Log ID, label, or stat.",
    "",
    ...echoBlock,
    ...noteBlock,
    "THE FINDING (identity):",
    `  artists: ${artists}`,
    `  title: ${title}`,
    `  label: ${label}`,
    `  year: ${year}`,
    `  galaxy: ${galaxy}`,
    `  bpm: ${bpm}`,
    `  key: ${key}`,
    "",
    ...neighborBlock,
    "FORMAT + VOICE CONSTRAINTS (the server voice-gate re-scans and will reject a violation):",
    "  - ONE sentence. Short: aim for roughly 50 to 140 characters, never past the 280 cap. A semicolon is fine; a second sentence is not.",
    "  - Lead with the feel and your verdict: the sound, why it stays with you, not a file card.",
    "  - Stay light on facts. Naming the artist OR the title is fine if it helps, and the release year is welcome (it gives older finds a nice 'from the archives' read). Never the record label, and no more than one fact; the feeling carries the line.",
    "  - Dry confidence: the music brags, the copy doesn't. State it once, plainly.",
    "  - NEVER name earthly geography (no countries, cities, regions); the cosmos replaces the map.",
    "  - No exclamation marks. No em dashes in the prose. Sentence case.",
    "  - No banned identity words (per the skill's voice canon — no 'signal', 'transmission', etc).",
    "  - Say 'I', never 'we' as a company.",
    "",
    "Output ONLY the note text. No preamble, no headings, no quotes around it, no explanation — just the line.",
  ].join("\n");
}

function promptVariables(
  finding: Finding,
  contextNote: string,
  neighbors: Neighbor[],
  echoedPhrase?: string,
): Record<string, string | undefined> {
  return {
    artists: finding.artists?.length ? finding.artists.join(", ") : "unknown",
    bpm: typeof finding.bpm === "number" ? `${Math.round(finding.bpm)}` : "unknown",
    contextNote,
    echoedPhrase,
    galaxy: finding.galaxy?.name ?? "unplaced",
    key: finding.key ?? "unknown",
    label: finding.label ?? "unknown",
    neighbours: neighbors
      .map(
        (neighbor) => `  - ${neighbor.artists.join(", ")} — ${neighbor.title}: "${neighbor.note}"`,
      )
      .join("\n"),
    noContextNote: contextNote ? "" : "yes",
    title: finding.title ?? "unknown",
    year: finding.releaseDate ? finding.releaseDate.slice(0, 4) : "unknown",
  };
}

async function authorNote(
  finding: Finding,
  contextNote: string,
  neighbors: Neighbor[],
  echoedPhrase?: string,
): Promise<AuthoredNote | null> {
  const { prompt, promptVersion } = await resolveSweepPrompt({
    fallback: () => buildAuthoringPrompt(finding, contextNote, neighbors, echoedPhrase),
    slug: "note_author",
    variables: promptVariables(finding, contextNote, neighbors, echoedPhrase),
  });

  if (promptVersion === null) {
    log("the prompt registry was unreachable — authoring from the baked-in default");
  }

  const args = [
    "-p",
    "--model",
    NOTE_CLAUDE_MODEL,
    "--allowedTools",
    "Read,Glob,Grep",
    "--output-format",
    "json",
  ];

  if (NOTE_CLAUDE_EFFORT) {
    args.push("--effort", NOTE_CLAUDE_EFFORT);
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

    log(`claude -p returned is_error (${reply.subtype ?? "?"}) — leaving finding queued`);

    return null;
  }

  const note = typeof reply.result === "string" ? reply.result.trim() : "";

  if (!note) {
    log("claude -p returned an empty note — leaving finding queued");

    return null;
  }

  return { note, promptVersion, ...parseAuthoringSpend(reply, NOTE_CLAUDE_MODEL) };
}

function deliverNote(
  id: string,
  note: string,
  promptVersion: number | null,
  dryRun = false,
): Delivery {
  const dir = mkdtempSync(join(tmpdir(), "note-sweep-"));
  const notePath = join(dir, "note.txt");

  try {
    writeFileSync(notePath, note, "utf8");

    const { code, stderr, stdout } = run(fluncleBin(), [
      "admin",
      "tracks",
      "note",
      id,
      "--script-file",
      notePath,

      ...(promptVersion === null ? [] : ["--prompt-version", String(promptVersion)]),
      ...(dryRun ? ["--dry-run"] : []),
      "--json",
    ]);

    if (code !== 0) {
      const combined = `${stdout}\n${stderr}`;
      const detail = combined.toLowerCase();

      if (detail.includes("note_echoes_neighbours")) {
        const echoedPhrase = readEchoedPhrase(combined);

        log(
          `${id}: the echo gate rejected the note${
            echoedPhrase ? ` (it lifted "${echoedPhrase}")` : ""
          }`,
        );

        return { charged: true, echoedPhrase, outcome: "echoSkipped" };
      }

      if (
        isWorkerRejection(detail) ||
        detail.includes("403") ||
        detail.includes("422") ||
        detail.includes("forbidden")
      ) {
        const charged = isWorkerRejection(detail);

        log(
          charged
            ? `${id}: voice gate / length rejected the note — skipping (stays queued)`
            : `${id}: the note POST was refused without a gate verdict — skipping (stays queued, no attempt spent)`,
        );

        return { charged, outcome: "gateSkipped" };
      }

      log(`${id}: note exited ${code}: ${stderr.trim().slice(-200)}`);

      return { charged: false, outcome: "skipped" };
    }

    try {
      const parsed = JSON.parse(stdout) as { skipped?: boolean };

      if (parsed.skipped) {
        log(`${id}: a note is already on file — operator note stands, no-op`);

        return { charged: false, outcome: "alreadyNoted" };
      }
    } catch {}

    log(`${id}: note ${dryRun ? "cleared both gates (dry run, nothing stored)" : "authored"}`);

    return { charged: false, outcome: "noted" };
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

export function readEchoedPhrase(output: string): string | undefined {
  const match = /it lifts \\?"([^"\\]+)\\?"/.exec(output);

  return match?.[1];
}

function readNeighbors(id: string): Neighbor[] {
  if (!NEIGHBORS_ENABLED) {
    return [];
  }

  try {
    const result = fluncleJson<SimilarResponse>([
      "tracks",
      "similar",
      id,
      "--limit",
      String(NEIGHBOR_LIMIT),
    ]);

    return (result.findings ?? []).flatMap((finding) => {
      const note = finding.note?.trim();

      return note && finding.logId && finding.title
        ? [{ artists: finding.artists ?? [], logId: finding.logId, note, title: finding.title }]
        : [];
    });
  } catch (error) {
    log(
      `${id}: could not read the sonic neighbourhood (${
        error instanceof Error ? error.message : String(error)
      }) — authoring without it`,
    );

    return [];
  }
}

function readContextNote(id: string): string {
  try {
    const result = fluncleJson<{ contextNote?: string }>(["admin", "tracks", "context", id]);

    return result.contextNote?.trim() ?? "";
  } catch (error) {
    log(
      `${id}: could not read context note (${
        error instanceof Error ? error.message : String(error)
      }) — authoring from identity metadata only`,
    );

    return "";
  }
}

type NoteResult = { cost: BoxCostEvent | null; outcome: Outcome };

function logExhausted(id: string): void {
  log(
    `${id}: EXHAUSTED — ${MAX_NOTE_ATTEMPTS} drafts were refused by the gates, giving up on this finding; it stays note-less (delete its line from ${attemptLedgerPath(STATE_DIR)} to re-arm)`,
  );
}

function settleBudget(
  id: string,
  outcome: Outcome,
  charged: boolean,
  budget?: Budget,
): NoteResult | null {
  if (!budget) {
    return null;
  }

  if (outcome === "noted" || outcome === "alreadyNoted") {
    clearAttempts(budget.ledger, id);
    writeAttemptLedger(budget.ledgerPath, budget.ledger, log);

    return null;
  }

  if (!charged) {
    return null;
  }

  recordAttempt(budget.ledger, id, Math.floor(Date.now() / 1000));
  writeAttemptLedger(budget.ledgerPath, budget.ledger, log);

  if (!planAttempt(budget.ledger, id, MAX_NOTE_ATTEMPTS).exhausted) {
    return null;
  }

  logExhausted(id);

  return { cost: null, outcome: "exhausted" };
}

async function noteOneWithMode(
  queued: QueueFinding,
  dryRun: boolean,
  budget?: Budget,
): Promise<NoteResult> {
  const id = queued.trackId ?? queued.logId;

  if (!id) {
    log("queue item without a trackId/logId — skipping");

    return { cost: null, outcome: "skipped" };
  }

  if (budget && planAttempt(budget.ledger, id, MAX_NOTE_ATTEMPTS).exhausted) {
    logExhausted(id);

    return { cost: null, outcome: "exhausted" };
  }

  const response = fluncleJson<TrackGetResponse>(["tracks", "get", id]);
  const finding = response.track;

  if (!finding || !finding.title || !finding.artists?.length) {
    log(`${id}: missing finding metadata — skipping`);

    return { cost: null, outcome: "skipped" };
  }

  if (!dryRun && finding.note?.trim()) {
    log(`${id}: a note is already on file — skipping the authoring spend`);

    return { cost: null, outcome: "alreadyNoted" };
  }

  const contextNote = readContextNote(id);

  const neighbors = readNeighbors(id);

  if (neighbors.length > 0) {
    log(`${id}: ${neighbors.length} noted neighbour(s) in the sonic neighbourhood`);
  }

  let authored: AuthoredNote | null = null;
  let delivery: Delivery = { charged: false, outcome: "skipped" };
  let echoedPhrase: string | undefined;

  for (let attempt = 0; attempt <= ECHO_RETRIES; attempt += 1) {
    authored = await authorNote(finding, contextNote, neighbors, echoedPhrase);

    if (!authored) {
      return { cost: null, outcome: "skipped" };
    }

    delivery = deliverNote(id, authored.note, authored.promptVersion, dryRun);

    if (delivery.outcome !== "echoSkipped") {
      break;
    }

    echoedPhrase = delivery.echoedPhrase;

    if (attempt < ECHO_RETRIES) {
      log(`${id}: re-authoring once, routing around the echo`);
    } else {
      log(
        `${id}: still echoing its neighbourhood — left note-less, and HELD for the operator's eye (see /admin)`,
      );
    }
  }

  const outcome = delivery.outcome;

  const settled = settleBudget(id, outcome, delivery.charged, budget);

  if (settled) {
    return settled;
  }

  const cost: BoxCostEvent | null =
    outcome === "noted" && !dryRun && authored
      ? {
          costBasis: "subsidized",
          logId: finding.logId ?? null,
          model: authored.model,
          occurredAt: new Date().toISOString(),
          quantity: authored.tokens,
          source: "measured",
          step: "note",
          trackId: finding.trackId ?? null,
          unitType: "tokens",
          usd: authored.usd,
          vendor: "anthropic",
        }
      : null;

  if (dryRun && authored) {
    console.error(
      `\n── ${finding.logId ?? id} — ${finding.artists?.join(", ")} — ${finding.title}`,
    );
    console.error(`   neighbours: ${neighbors.map((n) => n.logId).join(", ") || "(none)"}`);
    console.error(`   NOTE: ${authored.note}`);
    console.error(
      `   prompt: ${
        authored.promptVersion === null
          ? "the baked-in default (the registry was unreachable)"
          : authored.promptVersion === 0
            ? "the registry default (v0)"
            : `override v${authored.promptVersion}`
      }`,
    );
    console.error(`   verdict: ${outcome}\n`);
  }

  return { cost, outcome };
}

export function noteOne(
  queued: QueueFinding,
  dryRun = false,
  budget?: Budget,
): Promise<NoteResult> {
  return noteOneWithMode(queued, dryRun, budget);
}

function pingClaudeAuthFailure(detail: string): void {
  if (!DISCORD_ALERT_WEBHOOK) {
    return;
  }

  try {
    const body = JSON.stringify({
      content: "Fluncle note-sweep: claude auth failed, re-auth needed.",
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
  const argv = process.argv.slice(2);
  const dryRunIds = argv.includes("--dry-run") ? argv.filter((arg) => !arg.startsWith("-")) : [];

  if (dryRunIds.length > 0) {
    log(
      `DRY RUN over ${dryRunIds.length} finding(s), neighbours ${NEIGHBORS_ENABLED ? "ON" : "OFF"} — nothing will be stored`,
    );

    const outcomes: Record<string, string> = {};
    let failed = 0;

    for (const id of dryRunIds) {
      try {
        const { outcome } = await noteOne({ logId: id }, true);
        outcomes[id] = outcome;
      } catch (error) {
        outcomes[id] = "failed";
        failed += 1;
        log(`error on ${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    console.log(
      JSON.stringify({
        checked: dryRunIds.length,
        dryRun: true,
        errors: 0,
        failed,
        neighbors: NEIGHBORS_ENABLED,
        ok: true,
        outcomes,
        produced: 0,
      }),
    );

    return;
  }

  let response: { tracks?: QueueFinding[] };

  try {
    response = fluncleJson<{ tracks?: QueueFinding[] }>([
      "admin",
      "tracks",
      "note",
      "--queue",
      "--limit",
      String(QUEUE_LIMIT),
    ]);
  } catch (error) {
    if (!isDueWorkRepairPending(error)) {
      throw error;
    }

    log(error.message);
    console.log(JSON.stringify(dueWorkRepairPendingSummary({ checked: 0, failed: 0 })));

    return;
  }

  const queue = response.tracks ?? [];

  const summary = {
    alreadyNoted: 0,
    checked: 0,

    echoSkipped: 0,
    errors: 0,

    exhausted: 0,
    failed: 0,
    gateSkipped: 0,
    noted: 0,
    produced: 0,
    queueRemaining: queue.length,
  };

  if (queue.length === 0) {
    console.log(JSON.stringify({ ok: true, ...summary }));

    return;
  }

  const ledgerPath = attemptLedgerPath(STATE_DIR);
  const ledger = readAttemptLedger(ledgerPath);
  const budget: Budget = { ledger, ledgerPath };

  const { exhausted, work } = selectWork(queue, ledger, noteKey, BATCH_CAP, MAX_NOTE_ATTEMPTS);

  summary.exhausted = exhausted.length;

  if (exhausted.length > 0) {
    log(
      exhaustedRecapLine(
        "finding",
        exhausted.flatMap((row) => {
          const key = noteKey(row);

          return key ? [key] : [];
        }),
        MAX_NOTE_ATTEMPTS,
      ),
    );
  }

  const costs: BoxCostEvent[] = [];

  for (const queued of work) {
    summary.checked += 1;

    try {
      const { cost, outcome } = await noteOne(queued, false, budget);

      if (cost) {
        costs.push(cost);
      }

      if (outcome === "noted") {
        summary.noted += 1;
        summary.produced += 1;
      } else if (outcome === "alreadyNoted") {
        summary.alreadyNoted += 1;
      } else if (outcome === "gateSkipped") {
        summary.gateSkipped += 1;
      } else if (outcome === "echoSkipped") {
        summary.echoSkipped += 1;
      } else if (outcome === "exhausted") {
        summary.exhausted += 1;
      } else {
        summary.failed += 1;
      }
    } catch (error) {
      if (error instanceof ClaudeAuthError) {
        summary.errors = 1;
        log("claude auth failed — aborting the batch, the queue is untouched");
        pingClaudeAuthFailure(error.message);
        console.log(
          JSON.stringify({
            ok: false,
            reason: "claude_auth",
            ...summary,
            queueRemaining: remainingQueueDepth(
              queue.length,
              summary.noted + summary.alreadyNoted,
              summary.exhausted,
            ),
          }),
        );
        process.exit(1);
      }

      summary.failed += 1;
      log(
        `error on ${queued.trackId ?? queued.logId ?? "?"}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  summary.queueRemaining = remainingQueueDepth(
    queue.length,
    summary.noted + summary.alreadyNoted,
    summary.exhausted,
  );

  const costWriteFailures = (await emitCost(costs)).failed;
  console.log(JSON.stringify({ costWriteFailures, ok: true, ...summary }));
}

if (import.meta.main) {
  main().catch((error) => {
    log(`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    console.log(JSON.stringify({ errors: 1, ok: false, reason: "sweep_error" }));
    process.exit(1);
  });
}
