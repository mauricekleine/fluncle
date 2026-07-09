#!/usr/bin/env bun
// logbook-sweep.ts — the bun orchestrator behind the `--no-agent` Logbook cron
// (`fluncle-logbook`), the nightly author of Fluncle's Logbook.
//
// Version-controlled source; the repo is canonical and the box is a deploy target
// (fluncle-hermes-operator skill). Invoked by the bash wrapper (logbook-sweep.sh)
// the host timer execs once a day — see that file's header for the wire-up and
// ../logbook-timer/README.md for the full runbook. Box activation is OPERATOR-GATED.
//
// THE HYBRID MODEL (the sibling of note-sweep / observe-sweep). One agentic step in
// the middle; everything around it is deterministic:
//
//   1. QUEUE + GATHER (deterministic): `fluncle admin logbook gaps --json` → the
//      SELF-HEALING WINDOW: every past sector-day (before today, ≥1 published finding,
//      no entry), OLDEST FIRST, each bundled with its findings' material (title,
//      artists, logId, the public note, the internal context_note, the observation
//      transcript, the poster URL). Empty → fast no-op, exit. This ONE call is both the
//      worklist AND the fuel, so there is no per-finding round-trip.
//   2. per DAY (bounded batch, BATCH_CAP=1 — authoring spends subscription quota, and
//      one long-form entry per tick keeps the run well inside the timer budget):
//      a. AUTHOR (the ONE agentic step): build the authoring prompt (the logbook voice
//         rails + the day's findings interpolated inline, each with its `[[logId]]`
//         figure token) and run `claude -p` — Claude Code, SUBSCRIPTION auth, NOT
//         OpenRouter — with READ-ONLY tools (`Read,Glob,Grep`) so it can load the
//         installed `copywriting-fluncle` skill for the voice. The model returns a
//         `TITLE: …` first line + a blank line + the body markdown.
//      b. DELIVER (deterministic): write the body to a temp file, then
//         `fluncle admin logbook create <sector> --title <title> --body-file <tmp>
//         --json` → the Worker VOICE-GATES the title + body and FILLS AN EMPTY SECTOR
//         ONLY. The SCRIPT posts it, never claude. A `skipped:true` (an entry already
//         stands — operator- or previously-agent-authored) is a clean no-op; the
//         operator override always wins. A gate 4xx → log which day failed, skip it
//         (it stays in the gap list), continue. The temp file is cleaned up either way.
//
// IMAGES: the box `claude -p` sweeps are TEXT-ONLY (the `--no-agent` runner grants
// Read/Glob/Grep, no multimodal image input), so each finding's poster is passed to the
// model as a URL in the prompt, NOT as an image the model sees. The model places the
// `[[logId]]` token; the PAGE renders the real poster. Revisit if the box gains image input.
//
// AUTH-FAILURE PING: identical to note-sweep — an auth/quota signature in a non-zero
// `claude -p` STOPS the batch, leaves the gap list intact (no data lost), emits a loud
// `{ ok:false, reason:"claude_auth" }` line + (if DISCORD_ALERT_WEBHOOK is set) a Discord ping.
//
// stdout: ONE JSON summary line (the cron run output). Diagnostics → stderr.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// One day per tick: a single long-form authoring pass sits comfortably inside the
// timer budget; the gap list drains across ticks (oldest first), so history
// backfills over successive nights. Raise only once a healthy run measures fast.
const BATCH_CAP = 1;
const GAP_LIMIT = 10; // hard ceiling on the gap read (we only act on BATCH_CAP)

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";

// The authoring model + optional reasoning effort. Env-configurable; default the
// spike-proven Sonnet alias (the note/observe-sweep precedent).
const LOGBOOK_CLAUDE_MODEL = process.env.LOGBOOK_CLAUDE_MODEL ?? "claude-sonnet-4-6";
const LOGBOOK_CLAUDE_EFFORT = process.env.LOGBOOK_CLAUDE_EFFORT;
const DISCORD_ALERT_WEBHOOK = process.env.DISCORD_ALERT_WEBHOOK;

const log = (message: string) => console.error(`[logbook-sweep] ${message}`);

// ---------------------------------------------------------------------------
// Types — only the fields we consume.
// ---------------------------------------------------------------------------

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

type ClaudeEnvelope = {
  is_error?: boolean;
  result?: string;
  subtype?: string;
};

type Outcome = "authored" | "alreadyAuthored" | "gateSkipped" | "skipped";

// A narrow sentinel the loop throws to abort the batch on a claude auth failure.
class ClaudeAuthError extends Error {}

// ---------------------------------------------------------------------------
// Shell helpers.
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
// claude-auth detection — narrow on purpose (shared shape with note-sweep).
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
  "credit balance is too low",
];

function looksLikeAuthFailure(text: string): boolean {
  const haystack = text.toLowerCase();

  return AUTH_SIGNATURES.some((signature) => haystack.includes(signature));
}

// ---------------------------------------------------------------------------
// The authoring prompt — the logbook voice rails + the day's findings inline. The
// model loads the `copywriting-fluncle` skill for the full voice canon; we restate
// only the hard, gate-enforced constraints + the token contract so the output is
// gate-safe and the figures land.
// ---------------------------------------------------------------------------

function buildAuthoringPrompt(gap: Gap): string {
  const sector = gap.sector ?? 0;
  const date = gap.date ? gap.date.slice(0, 10) : "unknown";
  const findings = gap.findings ?? [];

  const findingBlocks = findings.flatMap((finding, index) => {
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

  return [
    "You are Fluncle, writing your LOGBOOK entry for ONE day of the voyage — a first-person traveler's journal.",
    "Load and apply the `copywriting-fluncle` skill — it is the full voice canon; let it govern the voice.",
    "",
    `This is sector ${sector} (the day ${date}). Below are the findings I logged that day, in order.`,
    "Write the day up as a continuous journal entry: what the day was like, where the trip went, and how each banger landed as I arrived at its coordinate.",
    "",
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
    ...findingBlocks,
    "OUTPUT FORMAT (exactly):",
    "  - The FIRST line must be `TITLE: <a short, evocative title for the day>` (no 'Sector NNN' prefix — the page adds it).",
    "  - Then ONE blank line, then the body markdown (the journal + the figure tokens). Output nothing else — no preamble, no fences.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Author one day via `claude -p`. Throws ClaudeAuthError on an auth/quota failure
// (abort the batch); returns null on any other failure (leave the day queued);
// returns the parsed { title, body } on success.
// ---------------------------------------------------------------------------

function authorEntry(gap: Gap): { body: string; title: string } | null {
  const prompt = buildAuthoringPrompt(gap);
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

  if (envelope.is_error) {
    const detail = `${envelope.subtype ?? ""} ${envelope.result ?? ""}`;

    if (looksLikeAuthFailure(detail)) {
      throw new ClaudeAuthError(detail.trim().slice(-300));
    }

    log(`claude -p returned is_error (${envelope.subtype ?? "?"}) — leaving day queued`);

    return null;
  }

  const result = typeof envelope.result === "string" ? envelope.result.trim() : "";

  if (!result) {
    log("claude -p returned an empty entry — leaving day queued");

    return null;
  }

  return parseAuthoredEntry(result);
}

// Parse the `TITLE: …` first line + body. A missing TITLE line degrades to null
// (leave the day queued rather than store a title-less entry).
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

// ---------------------------------------------------------------------------
// Deliver one entry: write the body to a temp file, post via the CLI (the Worker
// voice-gates + fills-empty-only + stores), clean up.
// ---------------------------------------------------------------------------

function deliverEntry(sector: number, title: string, body: string): Outcome {
  const dir = mkdtempSync(join(tmpdir(), "logbook-sweep-"));
  const bodyPath = join(dir, "entry.md");

  try {
    writeFileSync(bodyPath, body, "utf8");

    const { code, stderr, stdout } = run(FLUNCLE_BIN, [
      "admin",
      "logbook",
      "create",
      String(sector),
      "--title",
      title,
      "--body-file",
      bodyPath,
      "--json",
    ]);

    if (code !== 0) {
      const detail = `${stdout}\n${stderr}`.toLowerCase();

      if (
        detail.includes("voice_gate") ||
        detail.includes("body_too_short") ||
        detail.includes("body_too_long") ||
        detail.includes("title_too_long") ||
        detail.includes("no_title") ||
        detail.includes("no_body") ||
        detail.includes("422") ||
        detail.includes("400")
      ) {
        log(
          `sector ${sector}: voice gate / validation rejected the entry — skipping (stays queued)`,
        );

        return "gateSkipped";
      }

      log(`sector ${sector}: create exited ${code}: ${stderr.trim().slice(-200)}`);

      return "skipped";
    }

    try {
      const parsed = JSON.parse(stdout) as { skipped?: boolean };

      if (parsed.skipped) {
        log(`sector ${sector}: an entry already stands — no-op`);

        return "alreadyAuthored";
      }
    } catch {
      // Non-JSON success is unexpected but harmless; treat as an authored fill.
    }

    log(`sector ${sector}: entry authored`);

    return "authored";
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Per-day: author → deliver.
// ---------------------------------------------------------------------------

function authorOne(gap: Gap): Outcome {
  const sector = gap.sector;

  if (typeof sector !== "number" || !gap.findings?.length) {
    log("gap without a sector / findings — skipping");

    return "skipped";
  }

  const authored = authorEntry(gap);

  if (!authored) {
    return "skipped";
  }

  return deliverEntry(sector, authored.title, authored.body);
}

// ---------------------------------------------------------------------------
// The claude-auth alert (shared shape with note-sweep). Never throws.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Main — drain a bounded batch off the gap list (oldest first).
// ---------------------------------------------------------------------------

function main(): void {
  const response = fluncleJson<{ gaps?: Gap[] }>([
    "admin",
    "logbook",
    "gaps",
    "--limit",
    String(GAP_LIMIT),
  ]);
  const gaps = response.gaps ?? [];

  const summary = {
    alreadyAuthored: 0,
    authored: 0,
    failed: 0,
    gapsRemaining: gaps.length,
    gateSkipped: 0,
  };

  if (gaps.length === 0) {
    console.log(JSON.stringify({ ok: true, ...summary }));

    return; // fast no-op
  }

  for (const gap of gaps.slice(0, BATCH_CAP)) {
    try {
      const outcome = authorOne(gap);

      if (outcome === "authored") {
        summary.authored += 1;
      } else if (outcome === "alreadyAuthored") {
        summary.alreadyAuthored += 1;
      } else if (outcome === "gateSkipped") {
        summary.gateSkipped += 1;
      } else {
        summary.failed += 1;
      }
    } catch (error) {
      if (error instanceof ClaudeAuthError) {
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

  // gapsRemaining = the gap depth at read time minus what we authored/no-op'd this
  // tick (gate-skips + failures stay queued); the next tick re-reads the live list.
  summary.gapsRemaining = Math.max(0, gaps.length - summary.authored - summary.alreadyAuthored);

  console.log(JSON.stringify({ ok: true, ...summary }));
}

try {
  main();
} catch (error) {
  log(`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  console.log(JSON.stringify({ ok: false, reason: "sweep_error" }));
  process.exit(1);
}
