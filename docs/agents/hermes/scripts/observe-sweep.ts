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

export const MAX_OBSERVE_ATTEMPTS = 3;

const STATE_DIR = process.env.OBSERVE_STATE_DIR ?? defaultStateDir("observe-sweep");

const fluncleBin = (): string => process.env.FLUNCLE_BIN ?? "fluncle";
const claudeBin = (): string => process.env.CLAUDE_BIN ?? "claude";

process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";

const NEIGHBORS_ENABLED = process.env.OBSERVE_NEIGHBORS !== "0";

const FLUNCLE_API_BASE_URL = (
  process.env.FLUNCLE_API_BASE_URL ?? "https://www.fluncle.com"
).replace(/\/+$/, "");
const FLUNCLE_API_TOKEN = process.env.FLUNCLE_API_TOKEN ?? "";
const NEIGHBOURS_TIMEOUT_MS = 2500;

const OBSERVE_CLAUDE_MODEL = process.env.OBSERVE_CLAUDE_MODEL ?? "claude-sonnet-5";

const OBSERVE_CLAUDE_EFFORT = process.env.OBSERVE_CLAUDE_EFFORT;

const DISCORD_ALERT_WEBHOOK = process.env.DISCORD_ALERT_WEBHOOK;

const log = (message: string) => console.error(`[observe-sweep] ${message}`);

type QueueFinding = {
  logId?: string;
  trackId?: string;
};

type Finding = {
  artists?: string[];
  galaxy?: { key?: string; name?: string };
  label?: string;
  logId?: string;
  releaseDate?: string;
  title?: string;
  trackId?: string;
};

type TrackGetResponse = { mixtape?: unknown; track?: Finding };

export type Neighbor = { logId: string; script: string };

type NeighboursResponse = { neighbours?: Neighbor[] };

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

type Outcome = "rendered" | "exhausted" | "gateSkipped" | "echoSkipped" | "skipped";

export function observeKey(queued: QueueFinding): string | null {
  return queued.trackId ?? queued.logId ?? null;
}

export type ObserveSummary = {
  checked: number;
  echoSkipped: number;
  errors: number;
  exhausted: number;
  failed: number;
  gateSkipped: number;
  produced: number;
  queueRemaining: number;
  rendered: number;
};

export function createObserveSummary(queueRemaining: number): ObserveSummary {
  return {
    checked: 0,
    echoSkipped: 0,
    errors: 0,
    exhausted: 0,
    failed: 0,
    gateSkipped: 0,
    produced: 0,
    queueRemaining,
    rendered: 0,
  };
}

type Budget = { ledger: AttemptLedger; ledgerPath: string };

type Delivery = { charged: boolean; echoedMove?: string; outcome: Outcome };

const WORKER_REJECTION_CODES = [
  "voice_gate",
  "observation_echoes_neighbours",
  "no_script",
  "script_too_short",
  "script_too_long",
] as const;

function isWorkerRejection(detail: string): boolean {
  return WORKER_REJECTION_CODES.some((code) => detail.includes(code));
}

type AuthoredScript = {
  model: string;

  promptVersion: number | null;
  script: string;
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
  echoedMove?: string,
): string {
  const artists = finding.artists?.length ? finding.artists.join(", ") : "unknown";
  const title = finding.title ?? "unknown";
  const label = finding.label ?? "unknown";
  const year = finding.releaseDate ? finding.releaseDate.slice(0, 4) : "unknown";
  const galaxy = finding.galaxy?.name ?? "unplaced";

  const echoBlock = echoedMove
    ? [
        `YOUR LAST ATTEMPT WAS REJECTED: it echoed a neighbour's read ("${echoedMove}"). That move is spent. Arrive at this record from somewhere else entirely — a different body reaction, a different moment in the track, a different way of turning to the crew.`,
        "",
      ]
    : [];

  const noteBlock = contextNote
    ? [
        "CONTEXT NOTE (the gathered facts — your PRIMARY material; ground the prose in these):",
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
          "THE SONIC NEIGHBOURHOOD (the observations already standing on the findings that sound nearest to this one):",
          ...neighbors.map((neighbor) => `  - ${neighbor.logId}: "${neighbor.script}"`),
          "",
          "USE THEM AS THE LIST OF WHAT IS ALREADY TAKEN.",
          "  - They tell you the REGISTER of this corner of the archive: how certain, how dry, how bodily.",
          "  - Every body reaction, image, opener, and closing address in them is SPENT. Do not reuse one — not the same body part, not the same sign-off name, not the phrasing, not the sentence shape.",
          "  - The server REJECTS an observation that lifts a run of words from any of them, and one that just reshuffles their words. A rejected read is not rendered at all.",
          "  - If your read could be swapped with one of these and nobody would notice, it is the wrong read. Say what is true of THIS record's arrival and nothing else.",
          "",
        ]
      : [];

  return [
    "You are Fluncle, writing the SPOKEN recovered-audio observation for one finding.",
    "Load and apply the `copywriting-fluncle` skill — it is the full voice canon; let it govern the voice.",
    "",
    "This is the recovered-audio register: a short spoken observation, as if Fluncle is talking over the track to the crew.",
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
    "",
    ...neighborBlock,
    "FORMAT + VOICE CONSTRAINTS (the server voice-gate re-scans and will reject a violation):",
    "  - Target 20–45 seconds spoken (roughly 50–110 words).",
    '  - Lead with the body — the sound, the feel — then turn to the crew (the Selector\'s Rule). VARY THE OPENER: not every read starts on "I" or "this one" — sometimes the sound lands first, sometimes a moment in the track, sometimes the crew. Never reach for the same first move as a neighbour.',
    '  - The turn to the crew is required, but it is ONE move with many shapes. VARY THE ADDRESS: rotate the kin name you land on (junglist, raver, fam, cosmonaut) and vary the phrasing, and let some reads make the turn with no sign-off tag at all. Never default to "hope it… enjoy, cosmonauts" — that exact close is worn through. Drop "hope" as a reflex; say what the tune does, not what you hope it does. "Put it on when…" as the hand-off is worn through too, and so are "and you can hear…" and "about a minute in"; when the turn wants an instruction, find this record\'s own, or let the read end on the sound.',
    "  - NEVER name earthly geography (no countries, cities, regions); the cosmos replaces the map.",
    "  - Pace with punctuation (full stops, commas, line breaks), never `<break>` tags: the voice engine ignores them and the render strips them.",
    "  - No exclamation marks. No em dashes in the prose. Sentence case.",
    "  - No banned identity words (per the skill's voice canon).",
    "",
    "Output ONLY the spoken script text. No preamble, no headings, no quotes around it, no explanation — just the words to be spoken.",
  ].join("\n");
}

function promptVariables(
  finding: Finding,
  contextNote: string,
  neighbors: Neighbor[],
  echoedMove?: string,
): Record<string, string | undefined> {
  return {
    artists: finding.artists?.length ? finding.artists.join(", ") : "unknown",
    contextNote,
    echoedMove,
    galaxy: finding.galaxy?.name ?? "unplaced",
    label: finding.label ?? "unknown",

    neighbours: neighbors
      .map((neighbor) => `  - ${neighbor.logId}: "${neighbor.script}"`)
      .join("\n"),
    noContextNote: contextNote ? "" : "yes",
    title: finding.title ?? "unknown",
    year: finding.releaseDate ? finding.releaseDate.slice(0, 4) : "unknown",
  };
}

async function authorScript(
  finding: Finding,
  contextNote: string,
  neighbors: Neighbor[],
  echoedMove?: string,
): Promise<AuthoredScript | null> {
  const { prompt, promptVersion } = await resolveSweepPrompt({
    fallback: () => buildAuthoringPrompt(finding, contextNote, neighbors, echoedMove),
    slug: "observation_script",
    variables: promptVariables(finding, contextNote, neighbors, echoedMove),
  });

  if (promptVersion === null) {
    log("the prompt registry was unreachable — authoring from the baked-in default");
  }

  const args = [
    "-p",
    "--model",
    OBSERVE_CLAUDE_MODEL,
    "--allowedTools",
    "Read,Glob,Grep",
    "--output-format",
    "json",
  ];

  if (OBSERVE_CLAUDE_EFFORT) {
    args.push("--effort", OBSERVE_CLAUDE_EFFORT);
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

  const script = typeof reply.result === "string" ? reply.result.trim() : "";

  if (!script) {
    log("claude -p returned an empty script — leaving finding queued");

    return null;
  }

  return { promptVersion, script, ...parseAuthoringSpend(reply, OBSERVE_CLAUDE_MODEL) };
}

function deliverScript(id: string, script: string, promptVersion: number | null): Delivery {
  const dir = mkdtempSync(join(tmpdir(), "observe-sweep-"));
  const scriptPath = join(dir, "observation.txt");

  try {
    writeFileSync(scriptPath, script, "utf8");

    const { code, stderr, stdout } = run(fluncleBin(), [
      "admin",
      "tracks",
      "observe",
      id,
      "--script-file",
      scriptPath,

      ...(promptVersion === null ? [] : ["--prompt-version", String(promptVersion)]),
      "--json",
    ]);

    if (code !== 0) {
      const combined = `${stdout}\n${stderr}`;
      const detail = combined.toLowerCase();

      if (detail.includes("observation_echoes_neighbours")) {
        const echoedMove = readEchoedMove(combined);

        log(
          `${id}: the echo gate rejected the observation${
            echoedMove ? ` (it lifted "${echoedMove}")` : ""
          }`,
        );

        return { charged: true, echoedMove, outcome: "echoSkipped" };
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
            ? `${id}: voice gate rejected the script — skipping (stays queued)`
            : `${id}: the observe POST was refused without a gate verdict — skipping (stays queued, no attempt spent)`,
        );

        return { charged, outcome: "gateSkipped" };
      }

      log(`${id}: observe exited ${code}: ${stderr.trim().slice(-200)}`);

      return { charged: false, outcome: "skipped" };
    }

    log(`${id}: observation rendered`);

    return { charged: false, outcome: "rendered" };
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

export function readEchoedMove(output: string): string | undefined {
  const match = /it lifts \\?"([^"\\]+)\\?"/.exec(output);

  return match?.[1];
}

async function readNeighbours(id: string): Promise<Neighbor[]> {
  if (!NEIGHBORS_ENABLED) {
    return [];
  }

  if (!FLUNCLE_API_TOKEN) {
    log(`${id}: no FLUNCLE_API_TOKEN — authoring without the sonic neighbourhood`);

    return [];
  }

  try {
    const url = `${FLUNCLE_API_BASE_URL}/api/v1/admin/tracks/${encodeURIComponent(
      id,
    )}/observation-neighbours?limit=${NEIGHBOR_LIMIT}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${FLUNCLE_API_TOKEN}` },
      method: "GET",
      signal: AbortSignal.timeout(NEIGHBOURS_TIMEOUT_MS),
    });

    if (!response.ok) {
      log(`${id}: observation-neighbours returned HTTP ${response.status} — authoring without it`);

      return [];
    }

    const payload = (await response.json()) as NeighboursResponse;

    return (payload.neighbours ?? []).flatMap((neighbor) =>
      neighbor.logId && neighbor.script?.trim()
        ? [{ logId: neighbor.logId, script: neighbor.script.trim() }]
        : [],
    );
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

type ObserveResult = { cost: BoxCostEvent | null; outcome: Outcome };

function logExhausted(id: string): void {
  log(
    `${id}: EXHAUSTED — ${MAX_OBSERVE_ATTEMPTS} drafts were refused by the gates, giving up on this finding; it stays unvoiced (delete its line from ${attemptLedgerPath(STATE_DIR)} to re-arm)`,
  );
}

function settleBudget(
  id: string,
  outcome: Outcome,
  charged: boolean,
  budget?: Budget,
): ObserveResult | null {
  if (!budget) {
    return null;
  }

  if (outcome === "rendered") {
    clearAttempts(budget.ledger, id);
    writeAttemptLedger(budget.ledgerPath, budget.ledger, log);

    return null;
  }

  if (!charged) {
    return null;
  }

  recordAttempt(budget.ledger, id, Math.floor(Date.now() / 1000));
  writeAttemptLedger(budget.ledgerPath, budget.ledger, log);

  if (!planAttempt(budget.ledger, id, MAX_OBSERVE_ATTEMPTS).exhausted) {
    return null;
  }

  logExhausted(id);

  return { cost: null, outcome: "exhausted" };
}

export async function observeOne(queued: QueueFinding, budget?: Budget): Promise<ObserveResult> {
  const id = queued.trackId ?? queued.logId;

  if (!id) {
    log("queue item without a trackId/logId — skipping");

    return { cost: null, outcome: "skipped" };
  }

  if (budget && planAttempt(budget.ledger, id, MAX_OBSERVE_ATTEMPTS).exhausted) {
    logExhausted(id);

    return { cost: null, outcome: "exhausted" };
  }

  const response = fluncleJson<TrackGetResponse>(["tracks", "get", id]);
  const finding = response.track;

  if (!finding || !finding.title || !finding.artists?.length) {
    log(`${id}: missing finding metadata — skipping`);

    return { cost: null, outcome: "skipped" };
  }

  const contextNote = readContextNote(id);

  const neighbors = await readNeighbours(id);

  if (neighbors.length > 0) {
    log(`${id}: ${neighbors.length} neighbour observation(s) in the sonic neighbourhood`);
  }

  let authored: AuthoredScript | null = null;
  let delivery: Delivery = { charged: false, outcome: "skipped" };
  let echoedMove: string | undefined;

  for (let attempt = 0; attempt <= ECHO_RETRIES; attempt += 1) {
    authored = await authorScript(finding, contextNote, neighbors, echoedMove);

    if (!authored) {
      return { cost: null, outcome: "skipped" };
    }

    delivery = deliverScript(id, authored.script, authored.promptVersion);

    if (delivery.outcome !== "echoSkipped") {
      break;
    }

    echoedMove = delivery.echoedMove;

    if (attempt < ECHO_RETRIES) {
      log(`${id}: re-authoring once, routing around the echo`);
    } else {
      log(
        `${id}: still echoing its neighbourhood — left unvoiced, and HELD for the operator's eye (see /admin)`,
      );
    }
  }

  const outcome = delivery.outcome;

  const settled = settleBudget(id, outcome, delivery.charged, budget);

  if (settled) {
    return settled;
  }

  const cost: BoxCostEvent | null =
    outcome === "rendered" && authored
      ? {
          costBasis: "subsidized",
          logId: finding.logId ?? null,
          model: authored.model,
          occurredAt: new Date().toISOString(),
          quantity: authored.tokens,
          source: "measured",
          step: "observe",
          trackId: finding.trackId ?? null,
          unitType: "tokens",
          usd: authored.usd,
          vendor: "anthropic",
        }
      : null;

  return { cost, outcome };
}

function pingClaudeAuthFailure(detail: string): void {
  if (!DISCORD_ALERT_WEBHOOK) {
    return;
  }

  try {
    const body = JSON.stringify({
      content: "Fluncle observe-sweep: claude auth failed, re-auth needed.",
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
  let response: { tracks?: QueueFinding[] };

  try {
    response = fluncleJson<{ tracks?: QueueFinding[] }>([
      "admin",
      "tracks",
      "observe",
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

  const summary = createObserveSummary(queue.length);

  if (queue.length === 0) {
    console.log(JSON.stringify({ ok: true, ...summary }));

    return;
  }

  const ledgerPath = attemptLedgerPath(STATE_DIR);
  const ledger = readAttemptLedger(ledgerPath);
  const budget: Budget = { ledger, ledgerPath };

  const { exhausted, work } = selectWork(
    queue,
    ledger,
    observeKey,
    BATCH_CAP,
    MAX_OBSERVE_ATTEMPTS,
  );

  summary.exhausted = exhausted.length;

  if (exhausted.length > 0) {
    log(
      exhaustedRecapLine(
        "finding",
        exhausted.flatMap((row) => {
          const key = observeKey(row);

          return key ? [key] : [];
        }),
        MAX_OBSERVE_ATTEMPTS,
      ),
    );
  }

  const costs: BoxCostEvent[] = [];

  for (const queued of work) {
    summary.checked += 1;

    try {
      const { cost, outcome } = await observeOne(queued, budget);

      if (cost) {
        costs.push(cost);
      }

      if (outcome === "rendered") {
        summary.rendered += 1;
        summary.produced += 1;
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
            queueRemaining: remainingQueueDepth(queue.length, summary.rendered, summary.exhausted),
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

  summary.queueRemaining = remainingQueueDepth(queue.length, summary.rendered, summary.exhausted);

  const costWriteFailures = (await emitCost(costs)).failed;
  console.log(JSON.stringify({ costWriteFailures, ok: true, ...summary }));
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
