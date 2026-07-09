#!/usr/bin/env bun
// observe-sweep.ts — the bun orchestrator behind the `--no-agent` observation cron
// (`fluncle-observation`).
//
// LIVE. Version-controlled source; the repo is canonical and the box is a
// deploy target (fluncle-hermes-operator skill). Invoked by the bash wrapper
// (observe-sweep.sh) the cron runner execs every ~60m — see that file's header for
// the `host-timer` wire-up and ../cron/README.md for the full cron model.
//
// THE HYBRID MODEL. Unlike the pure-trigger sweeps (enrich/context/backfill), this
// one has ONE agentic step in the middle. Everything around it is deterministic:
//
//   1. QUEUE (deterministic): `fluncle admin tracks observe --queue --json` → findings
//      that HAVE a context note but NO observation yet (`hasContext=true AND
//      hasObservation=false`, oldest first). Empty → fast no-op, exit.
//   2. per finding (bounded batch, BATCH_CAP small — observation costs Cartesia
//      credits + subscription quota):
//      a. GATHER (deterministic): `fluncle tracks get <id> --json` → the finding's
//         identity metadata (artists, title, label, release year, galaxy, vibe),
//         AND `fluncle admin tracks context <id> --json` → the stored `context_note`
//         (the firecrawl facts the context sweep distilled). The note is the PRIMARY
//         authoring fuel — `admin tracks context` returns it (`skipped: true`, no
//         re-fetch) for a finding that already has one, which every queue item does
//         (`hasContext=true`). A blank/unreadable note degrades to identity-only.
//      b. AUTHOR (the ONE agentic step): build the authoring prompt (the voice/format
//         doctrine ported from the old agent cron's jobs.json prompt, with the
//         finding's data interpolated inline) and run `claude -p` — Claude Code,
//         SUBSCRIPTION auth, NOT OpenRouter — with READ-ONLY tools (`Read,Glob,Grep`)
//         so it can load the installed `copywriting-fluncle` skill for the voice.
//         The JSON envelope's `.result` field is the script.
//      c. DELIVER (deterministic): write the script to a temp file, then
//         `fluncle admin tracks observe <id> --script-file <tmp> --json` → the Worker
//         RE-SCANS (the voice gate), renders Cartesia, stores. The SCRIPT posts it,
//         never claude. A gate 403/422 → log which finding failed, skip it (stays
//         queued), continue. The temp file is cleaned up either way.
//
// AUTH-FAILURE PING. If `claude -p` fails with an AUTH error (a re-auth/login
// signature in its output, distinct from a normal model hiccup), we STOP the batch
// (no point spending more), leave the queue intact (no data lost — the whole point),
// and emit a LOUD `{ ok:false, reason:"claude_auth" }` summary line plus, if
// DISCORD_ALERT_WEBHOOK is set, a best-effort Discord ping. The detection is narrow
// so a transient model error doesn't false-alarm.
//
// stdout: ONE JSON summary line (the cron run output). Diagnostics → stderr.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BoxCostEvent, emitCost, parseAuthoringSpend } from "./cost-emit";

// ---------------------------------------------------------------------------
// Config — a SMALL bounded batch: each observation burns Cartesia credits AND
// claude subscription quota, so keep ticks cheap. The queue is the durable
// worklist; anything not reached this tick is picked up on the next (~60m later).
// ---------------------------------------------------------------------------

// One finding per tick: the Hermes cron runner kills a `--no-agent` job at 120s, and a
// single `claude -p` authoring (skill-read + Sonnet) + Cartesia render already sits
// near that budget — two blew it. The queue drains across hourly ticks (find volume is
// low). Raise only once a HEALTHY run measures comfortably under 120s per finding.
const BATCH_CAP = 1;
const QUEUE_LIMIT = 50; // hard ceiling on the queue read (we only act on BATCH_CAP)

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";

// The authoring model. Env-configurable; default the spike-proven Sonnet alias.
const OBSERVE_CLAUDE_MODEL = process.env.OBSERVE_CLAUDE_MODEL ?? "claude-sonnet-4-6";
// Optional reasoning effort, passed through to `claude -p --effort` when set.
const OBSERVE_CLAUDE_EFFORT = process.env.OBSERVE_CLAUDE_EFFORT;
// Optional Discord webhook for the claude-auth-failed alert (best-effort).
const DISCORD_ALERT_WEBHOOK = process.env.DISCORD_ALERT_WEBHOOK;

const log = (message: string) => console.error(`[observe-sweep] ${message}`);

// ---------------------------------------------------------------------------
// Types — only the fields we consume from each surface.
// ---------------------------------------------------------------------------

type QueueFinding = {
  logId?: string;
  trackId?: string;
};

// The raw `track get` finding (a TrackListItem): the metadata the authoring step
// grounds the script in. Every field optional — we narrow before use.
type Finding = {
  artists?: string[];
  galaxy?: { key?: string; name?: string };
  label?: string;
  logId?: string;
  releaseDate?: string;
  title?: string;
  trackId?: string;
  vibeX?: number;
  vibeY?: number;
};

// A `track get` can resolve to a finding OR a mixtape; we only ever queue findings.
type TrackGetResponse = { mixtape?: unknown; track?: Finding };

// The `claude -p --output-format json` envelope. We take `.result` as the script;
// `is_error`/`subtype` distinguish a clean run from an error. `usage` /
// `total_cost_usd` / `modelUsage` carry the authoring spend — read after the parse
// and emitted as one `subsidized` anthropic row (COST-01 §5), zero new claude flags.
type ClaudeUsage = {
  input_tokens?: number;
  output_tokens?: number;
};

type ClaudeEnvelope = {
  is_error?: boolean;
  modelUsage?: Record<string, unknown>;
  result?: string;
  subtype?: string;
  total_cost_usd?: number;
  usage?: ClaudeUsage;
};

type Outcome = "rendered" | "gateSkipped" | "skipped";

// The authored script plus its MEASURED authoring spend (the COST-01 §5 `observe`
// row): the total_cost_usd the CLI computed, the model, and the token count. `usd` is
// null only if the envelope carried no `total_cost_usd` (then the row is unpriced,
// never $0).
type AuthoredScript = {
  model: string;
  script: string;
  tokens: number;
  usd: number | null;
};

// A narrow sentinel the loop throws to abort the batch on a claude auth failure.
class ClaudeAuthError extends Error {}

// ---------------------------------------------------------------------------
// Shell helpers — synchronous, fail-loud where it matters.
// ---------------------------------------------------------------------------

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
  const { code, stderr, stdout } = run(FLUNCLE_BIN, [...args, "--json"]);

  if (code !== 0) {
    throw new Error(`fluncle ${args.join(" ")} exited ${code}: ${stderr.trim()}`);
  }

  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error(`fluncle ${args.join(" ")} did not return JSON: ${stdout.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// claude-auth detection — narrow on purpose: only an explicit re-auth/login
// signature counts, so a transient model error (rate limit, overload, a 5xx)
// does NOT trip the loud auth alert. Matched against the combined stdout+stderr
// of a non-zero `claude -p` run.
// ---------------------------------------------------------------------------

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
  "credit balance is too low", // subscription/quota exhausted — same "stop now" class
];

function looksLikeAuthFailure(text: string): boolean {
  const haystack = text.toLowerCase();

  return AUTH_SIGNATURES.some((signature) => haystack.includes(signature));
}

// ---------------------------------------------------------------------------
// The authoring prompt — the voice/format doctrine ported from the old agent
// cron's jobs.json prompt, with this finding's facts interpolated inline. The
// model loads the `copywriting-fluncle` skill for the full voice canon; we only
// restate the hard, gate-enforced constraints here so the output is gate-safe.
// ---------------------------------------------------------------------------

function buildAuthoringPrompt(finding: Finding, contextNote: string): string {
  const artists = finding.artists?.length ? finding.artists.join(", ") : "unknown";
  const title = finding.title ?? "unknown";
  const label = finding.label ?? "unknown";
  const year = finding.releaseDate ? finding.releaseDate.slice(0, 4) : "unknown";
  const galaxy = finding.galaxy?.name ?? "unplaced";
  const vibe =
    finding.vibeX !== undefined && finding.vibeY !== undefined
      ? `x=${finding.vibeX}, y=${finding.vibeY}`
      : "unplaced";

  // The stored context note (the firecrawl facts the context sweep distilled) is
  // the PRIMARY fuel — it carries release context, scene, and label history the bare
  // metadata can't. The metadata below is supporting identity. When the note is
  // absent (best-effort read failed), author from identity alone — sparse + certain.
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

  return [
    "You are Fluncle, writing the SPOKEN recovered-audio observation for one finding.",
    "Load and apply the `copywriting-fluncle` skill — it is the full voice canon; let it govern the voice.",
    "",
    "This is the recovered-audio register: a short spoken observation, as if Fluncle is talking over the track to the crew.",
    "Ground every claim in the facts below. Never invent a track, artist, date, Log ID, label, or stat.",
    "",
    ...noteBlock,
    "THE FINDING (identity):",
    `  artists: ${artists}`,
    `  title: ${title}`,
    `  label: ${label}`,
    `  year: ${year}`,
    `  galaxy: ${galaxy}`,
    `  vibe coordinates: ${vibe}`,
    "",
    "FORMAT + VOICE CONSTRAINTS (the server voice-gate re-scans and will reject a violation):",
    "  - Target 20–45 seconds spoken (roughly 50–110 words).",
    "  - Lead with the body — the sound, the feel — then turn to the crew.",
    "  - NEVER name earthly geography (no countries, cities, regions); the cosmos replaces the map.",
    "  - Use only SPARSE `<break>` tags (dense breaks get vocalised as thinking sounds). A couple at most.",
    "  - No exclamation marks. No em dashes in the prose. Sentence case.",
    "  - No banned identity words (per the skill's voice canon).",
    "",
    "Output ONLY the spoken script text. No preamble, no headings, no quotes around it, no explanation — just the words to be spoken.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Author one script via `claude -p` (subscription auth, read-only tools). Throws
// ClaudeAuthError on an auth/quota failure (abort the batch); returns null on any
// other failure (leave the finding queued); returns the script string on success.
// ---------------------------------------------------------------------------

function authorScript(finding: Finding, contextNote: string): AuthoredScript | null {
  const prompt = buildAuthoringPrompt(finding, contextNote);
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

  const { code, stderr, stdout } = run(CLAUDE_BIN, args, prompt);

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

  let envelope: ClaudeEnvelope;

  try {
    envelope = JSON.parse(stdout) as ClaudeEnvelope;
  } catch {
    log(`claude -p did not return JSON: ${stdout.slice(0, 200)}`);

    return null;
  }

  // An `is_error` envelope can still carry an auth signature (e.g. an auth error
  // surfaced as a clean JSON result rather than a non-zero exit) — check it too.
  if (envelope.is_error) {
    const detail = `${envelope.subtype ?? ""} ${envelope.result ?? ""}`;

    if (looksLikeAuthFailure(detail)) {
      throw new ClaudeAuthError(detail.trim().slice(-300));
    }

    log(`claude -p returned is_error (${envelope.subtype ?? "?"}) — leaving finding queued`);

    return null;
  }

  const script = typeof envelope.result === "string" ? envelope.result.trim() : "";

  if (!script) {
    log("claude -p returned an empty script — leaving finding queued");

    return null;
  }

  // The measured authoring spend (shared parse — the CLI's own total_cost_usd is
  // authoritative, the token count is the informational quantity, the model comes off
  // modelUsage else the one we asked for).
  return { script, ...parseAuthoringSpend(envelope, OBSERVE_CLAUDE_MODEL) };
}

// ---------------------------------------------------------------------------
// Deliver one script: write it to a temp file, post via the CLI (the Worker
// voice-gates + renders + stores), clean up. A gate rejection (403/422) is a
// `gateSkipped` outcome — the finding stays queued for a future author pass.
// ---------------------------------------------------------------------------

function deliverScript(id: string, script: string): Outcome {
  const dir = mkdtempSync(join(tmpdir(), "observe-sweep-"));
  const scriptPath = join(dir, "observation.txt");

  try {
    writeFileSync(scriptPath, script, "utf8");

    const { code, stderr, stdout } = run(FLUNCLE_BIN, [
      "admin",
      "tracks",
      "observe",
      id,
      "--script-file",
      scriptPath,
      "--json",
    ]);

    if (code !== 0) {
      const detail = `${stdout}\n${stderr}`.toLowerCase();

      // The voice gate rejects with a 403/422 + a voice_gate/forbidden signature.
      // Treat that as a skip (the finding stays queued), not a hard error.
      if (
        detail.includes("voice_gate") ||
        detail.includes("403") ||
        detail.includes("422") ||
        detail.includes("forbidden")
      ) {
        log(`${id}: voice gate rejected the script — skipping (stays queued)`);

        return "gateSkipped";
      }

      log(`${id}: observe exited ${code}: ${stderr.trim().slice(-200)}`);

      return "skipped";
    }

    log(`${id}: observation rendered`);

    return "rendered";
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Read the finding's stored context note — the firecrawl facts the context sweep
// distilled, which are the observation's PRIMARY authoring fuel. `admin tracks
// context <id>` returns the stored note (`skipped: true`, NO re-fetch) for a
// finding that already has one — and every queue item does (`hasContext=true`), so
// this is a cheap read with no side effect. Best-effort: any failure (or a blank
// note) degrades to identity-only authoring rather than blocking the finding.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Per-finding: gather → author → deliver.
// ---------------------------------------------------------------------------

// The outcome plus the cost row to emit — non-null ONLY when an observation was
// actually authored AND rendered (so a gate-skip / failure never records spend).
type ObserveResult = { cost: BoxCostEvent | null; outcome: Outcome };

function observeOne(queued: QueueFinding): ObserveResult {
  const id = queued.trackId ?? queued.logId;

  if (!id) {
    log("queue item without a trackId/logId — skipping");

    return { cost: null, outcome: "skipped" };
  }

  // (a) Gather the finding's identity metadata. `track get` is the SINGULAR public
  // read; it returns the raw finding (galaxy + vibe intact). A mixtape arm can't
  // appear here (the queue is findings), but guard anyway.
  const response = fluncleJson<TrackGetResponse>(["tracks", "get", id]);
  const finding = response.track;

  if (!finding || !finding.title || !finding.artists?.length) {
    log(`${id}: missing finding metadata — skipping`);

    return { cost: null, outcome: "skipped" };
  }

  // (b) Read the stored context note — the PRIMARY authoring fuel (the firecrawl
  // facts the context sweep produced). Best-effort: degrades to identity-only.
  const contextNote = readContextNote(id);

  // (c) Author the script (the one agentic step). Throws ClaudeAuthError to abort
  // the whole batch; returns null to leave THIS finding queued.
  const authored = authorScript(finding, contextNote);

  if (!authored) {
    return { cost: null, outcome: "skipped" };
  }

  // (d) Deliver: the CLI posts it; the Worker re-scans + renders + stores.
  const outcome = deliverScript(id, authored.script);

  // (e) Record the authoring spend ONLY when the observation actually rendered. A
  // gate-skip / failure spent the tokens too, but attributing an "observe" cost to a
  // finding with no observation would misread — the ledger tracks DELIVERED work. The
  // token spend on a rejected author is accepted lossiness.
  const cost: BoxCostEvent | null =
    outcome === "rendered"
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

// ---------------------------------------------------------------------------
// The claude-auth alert — loud summary line is the floor; the Discord ping is a
// best-effort extra when DISCORD_ALERT_WEBHOOK is set. Never throws.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Main — drain a bounded batch off the observe queue.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // `observe --queue --json` returns `{ ok: true, tracks: [...] }`, not a bare array.
  const response = fluncleJson<{ tracks?: QueueFinding[] }>([
    "admin",
    "tracks",
    "observe",
    "--queue",
    "--limit",
    String(QUEUE_LIMIT),
  ]);
  const queue = response.tracks ?? [];

  const summary = { failed: 0, gateSkipped: 0, queueRemaining: queue.length, rendered: 0 };

  if (queue.length === 0) {
    console.log(JSON.stringify({ ok: true, ...summary }));

    return; // fast no-op
  }

  // The tick's authoring-spend rows, POSTed once at the end (best-effort, after the
  // observations are already durable — a dropped POST only understates the ledger).
  const costs: BoxCostEvent[] = [];

  for (const queued of queue.slice(0, BATCH_CAP)) {
    try {
      const { cost, outcome } = observeOne(queued);

      if (cost) {
        costs.push(cost);
      }

      if (outcome === "rendered") {
        summary.rendered += 1;
      } else if (outcome === "gateSkipped") {
        summary.gateSkipped += 1;
      } else {
        summary.failed += 1;
      }
    } catch (error) {
      if (error instanceof ClaudeAuthError) {
        // Auth failure: STOP the batch, leave the queue intact, alert loudly.
        log("claude auth failed — aborting the batch, the queue is untouched");
        pingClaudeAuthFailure(error.message);
        console.log(
          JSON.stringify({
            ok: false,
            reason: "claude_auth",
            ...summary,
            queueRemaining: Math.max(0, queue.length - summary.rendered),
          }),
        );
        process.exit(1);
      }

      // One finding's failure must not abort the sweep — log it and move on; it
      // stays in the queue for the next tick.
      summary.failed += 1;
      log(
        `error on ${queued.trackId ?? queued.logId ?? "?"}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // queueRemaining is the queue depth AT READ TIME minus what we rendered this tick
  // (gate-skips + failures stay queued); the next tick re-reads the live queue.
  summary.queueRemaining = Math.max(0, queue.length - summary.rendered);

  console.log(JSON.stringify({ ok: true, ...summary }));

  // Record the tick's authoring spend, best-effort, AFTER the summary is printed (the
  // cron parses the summary as its last stdout line; emitCost only logs to stderr).
  // Cannot throw; a hard 2.5s cap keeps it well inside the runner budget.
  await emitCost(costs);
}

main().catch((error) => {
  log(`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  console.log(JSON.stringify({ ok: false, reason: "sweep_error" }));
  process.exit(1);
});
