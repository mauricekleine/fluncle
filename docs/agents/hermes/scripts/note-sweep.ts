#!/usr/bin/env bun
// note-sweep.ts — the bun orchestrator behind the `--no-agent` auto-note cron
// (`fluncle-note`).
//
// LIVE. Version-controlled source; the repo is canonical and the box is a
// deploy target (fluncle-hermes-operator skill). Invoked by the bash wrapper
// (note-sweep.sh) the cron runner execs every ~30m — see that file's header for the
// `host-timer` wire-up and ../cron/README.md for the full cron model.
//
// THE HYBRID MODEL (the written-note sibling of observe-sweep). Unlike the
// pure-trigger sweeps (enrich/context/backfill), this one has ONE agentic step in
// the middle. Everything around it is deterministic:
//
//   1. QUEUE (deterministic): `fluncle admin tracks note --queue --json` → findings
//      that HAVE a context note but NO editorial note yet (`hasContext=true AND
//      hasNote=false`, oldest first). Empty → fast no-op, exit.
//   2. per finding (bounded batch, BATCH_CAP small — authoring spends subscription
//      quota):
//      a. GATHER (deterministic): `fluncle tracks get <id> --json` → the finding's
//         identity metadata (artists, title, label, release year, galaxy, BPM, key),
//         `fluncle admin tracks context <id> --json` → the stored `context_note` (the
//         firecrawl facts the context sweep distilled), AND `fluncle tracks similar
//         <id> --json` → the finding's SONIC NEIGHBOURHOOD (the vibe-neighbour layer,
//         below). The context note is the PRIMARY authoring fuel — `admin tracks
//         context` returns it (`skipped: true`, no re-fetch) for a finding that already
//         has one, which every queue item does (`hasContext=true`). A blank/unreadable
//         note degrades to identity-only.
//      b. AUTHOR (the ONE agentic step): build the authoring prompt (the voice/format
//         doctrine for a one-line editorial note, with the finding's data interpolated
//         inline) and run `claude -p` — Claude Code, SUBSCRIPTION auth, NOT OpenRouter
//         — with READ-ONLY tools (`Read,Glob,Grep`) so it can load the installed
//         `copywriting-fluncle` skill for the voice. The JSON envelope's `.result` is
//         the note.
//      c. DELIVER (deterministic): write the note to a temp file, then
//         `fluncle admin tracks note <id> --script-file <tmp> --json` → the Worker
//         RE-SCANS (the voice gate AND the echo gate) and FILLS AN EMPTY NOTE ONLY. The
//         SCRIPT posts it, never claude. A `skipped:true` (an operator note already on
//         file) is a clean no-op — the operator override always wins. A gate 403/422 →
//         log which finding failed, skip it (stays queued), continue. The temp file is
//         cleaned up either way.
//
// THE VIBE-NEIGHBOUR LAYER (and its guardrail). The prompt carries the notes of the
// finding's nearest neighbours in EMBEDDING space — the MuQ audio embedding, which
// captures how a track FEELS rather than how it measures (a feature-twin can land in a
// different galaxy by feel, and its note would carry the wrong vibe). They go in as
// what the region ALREADY SOUNDS LIKE, and every one of them is a move that is now
// SPENT: the cluster INFORMS, it never TEMPLATES, because a note that reads like every
// other note in its galaxy is worse than none.
//
// That guardrail is MECHANICAL, not hoped for. The Worker re-reads the same neighbour
// notes and runs the ECHO GATE (apps/web/src/lib/server/note.ts): a lifted phrase or
// wholesale word overlap is a `note_echoes_neighbours` 422. On that rejection the sweep
// RE-AUTHORS ONCE, handing the model its own echo back as the thing to avoid. If the
// second line echoes too, the finding stays note-less and queued — the note is optional,
// and silence beats a generic line.
//
// A REJECTED NOTE IS HELD, NOT BINNED. The 422 is not the end of the line any more: before
// it answers, the Worker writes the rejected note to the `note_rejections` ledger with the
// neighbour it echoed, the lifted phrase, the score, and the thresholds in force, and it
// raises a row in the operator's /admin attention queue. He reads what the model wrote and
// rules — keep it, edit it, or bin it. Nothing about THIS script's behaviour changes (the
// note still isn't stored, the finding stays queued); what changes is that the work it threw
// away is now visible to the one person who can judge it. See docs/agents/note-agent.md.
//
// NOTE_NEIGHBORS=0 turns the layer off (the kill switch, and the A/B control).
//
// THE DRY RUN (`--dry-run <id…>`): author for the named findings, run both gates via
// `admin tracks note --dry-run`, print the notes + their measured echo, write NOTHING.
// It is the harness the layer was measured with, and it stays the way to re-measure it.
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
import { resolveSweepPrompt } from "./prompt-fetch";

// ---------------------------------------------------------------------------
// Config — a SMALL bounded batch: each note burns claude subscription quota, so
// keep ticks cheap. The queue is the durable worklist; anything not reached this
// tick is picked up on the next (~30m later).
// ---------------------------------------------------------------------------

// One finding per tick: the Hermes cron runner kills a `--no-agent` job at 120s, and
// a single `claude -p` authoring (skill-read + Sonnet) already sits well inside that
// budget but two could brush it. The queue drains across ticks (find volume is low).
// Raise only once a HEALTHY run measures comfortably under 120s per finding.
const BATCH_CAP = 1;
const QUEUE_LIMIT = 50; // hard ceiling on the queue read (we only act on BATCH_CAP)

// The sonic neighbourhood the note is authored against. Six is the same window the
// /log "more like this" row shows — wide enough to describe a region, tight enough that
// every one of them genuinely sounds like the finding. The Worker's echo gate reads the
// SAME six (one definition of "the neighbourhood" on both sides of the wire).
const NEIGHBOR_LIMIT = 6;

// The re-author budget when the Worker's echo gate rejects a note for echoing its
// neighbourhood. ONE retry: the second attempt is handed the echo it made, so it knows
// exactly which move is spent. A second echo means the model has nothing fresh for this
// finding — leave it note-less (silence beats a generic line) and let the next tick try
// with a cold context.
const ECHO_RETRIES = 1;

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";

// The vibe-neighbour layer's kill switch (and the A/B control): NOTE_NEIGHBORS=0 authors
// from the context note + identity alone, exactly as the sweep did before the layer.
const NEIGHBORS_ENABLED = process.env.NOTE_NEIGHBORS !== "0";

// The authoring model. Env-configurable; default the spike-proven Sonnet alias.
const NOTE_CLAUDE_MODEL = process.env.NOTE_CLAUDE_MODEL ?? "claude-sonnet-4-6";
// Optional reasoning effort, passed through to `claude -p --effort` when set.
const NOTE_CLAUDE_EFFORT = process.env.NOTE_CLAUDE_EFFORT;
// Optional Discord webhook for the claude-auth-failed alert (best-effort).
const DISCORD_ALERT_WEBHOOK = process.env.DISCORD_ALERT_WEBHOOK;

const log = (message: string) => console.error(`[note-sweep] ${message}`);

// ---------------------------------------------------------------------------
// Types — only the fields we consume from each surface.
// ---------------------------------------------------------------------------

type QueueFinding = {
  logId?: string;
  trackId?: string;
};

// The raw `track get` finding (a TrackListItem): the metadata the authoring step
// grounds the note in. Every field optional — we narrow before use.
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

// One member of the finding's sonic neighbourhood: a nearby finding and the note that
// already stands on it. The identity is what the note must NOT sound like.
export type Neighbor = {
  artists: string[];
  logId: string;
  note: string;
  title: string;
};

// `tracks similar --json` → the MuQ nearest neighbours (each a full TrackListItem).
type SimilarResponse = { findings?: Finding[] };

// A `track get` can resolve to a finding OR a mixtape; we only ever queue findings.
type TrackGetResponse = { mixtape?: unknown; track?: Finding };

// The `claude -p --output-format json` envelope. We take `.result` as the note;
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

type Outcome = "noted" | "alreadyNoted" | "gateSkipped" | "echoSkipped" | "skipped";

// What the Worker made of a delivered note. `echoed` carries the phrase the echo gate
// caught, so the re-author pass can hand the model its own echo back.
type Delivery = { echoedPhrase?: string; outcome: Outcome };

// The authored note plus its MEASURED authoring spend (the COST-01 §5 `note` row):
// the total_cost_usd the CLI computed, the model, and the token count. `usd` is null
// only if the envelope carried no `total_cost_usd` (then the row is unpriced, never $0).
type AuthoredNote = {
  model: string;
  note: string;
  // PROVENANCE — the prompt version this note was authored under: N = the operator's
  // live override, 0 = the registry's baked default, NULL = the registry was unreachable
  // and the inlined `buildAuthoringPrompt` below wrote it. Rides out to the Worker on
  // `--prompt-version` and lands on `findings.note_prompt_version`, which is what makes
  // "the notes got worse last week" a question with an answer.
  promptVersion: number | null;
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
// The authoring prompt — the voice/format doctrine for a one-line editorial note,
// with this finding's facts interpolated inline. The model loads the
// `copywriting-fluncle` skill for the full voice canon; we only restate the hard,
// gate-enforced constraints here so the output is gate-safe.
//
// THE NOTE IS PUBLIC. Unlike the spoken observation (internal until a surface plays
// it), this note lands straight on `/log/<id>` as Fluncle's editorial "why". The
// register is the finding note from VOICE.md: dry confidence, the Garnish Rule allows
// cosmos trim, the bodily reaction, the Selector's turn to the crew — in ONE LINE.
// ---------------------------------------------------------------------------

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

  // The stored context note (the firecrawl facts the context sweep distilled) is the
  // PRIMARY fuel — it carries release context, scene, and label history the bare
  // metadata can't, and the `Texture:` line gives sensory pointers. The metadata
  // below is supporting identity. When the note is absent (best-effort read failed),
  // author from identity alone — sparse + certain.
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

  // THE VIBE-NEIGHBOUR LAYER. These are the notes already standing on the findings that
  // sound nearest to this one. They are here for TWO reasons, and the second one is the
  // load-bearing half:
  //
  //   1. calibration — they are the register of this region of the archive, written in
  //      Fluncle's own hand. Hear how he talks about music that feels like this.
  //   2. EXCLUSION — every image, verb, and closing turn in them is now SPENT. A note
  //      that could be swapped with one of them says nothing about THIS finding, and a
  //      region of the archive that all reads the same is worth less than a region where
  //      half the findings say nothing at all.
  //
  // The Worker enforces (2) mechanically: it re-reads these same notes and rejects a
  // line that lifts a phrase from one of them. So this is not a style suggestion.
  const neighborBlock =
    neighbors.length > 0
      ? [
          "THE SONIC NEIGHBOURHOOD (the findings that sound nearest to this one, and the notes already standing on them):",
          ...neighbors.map(
            (neighbor) =>
              `  - ${neighbor.artists.join(", ")} — ${neighbor.title}: "${neighbor.note}"`,
          ),
          "",
          "READ THEM TWICE, THEN USE THEM AS A LIST OF WHAT IS ALREADY TAKEN.",
          "  - They tell you the REGISTER of this corner of the archive: how certain, how dry, how bodily.",
          "  - Every image, verb, body part, and closing move in them is SPENT. Do not reuse one. Not the shoulders, not the rewind, not the phrasing, not the sentence shape.",
          "  - The server REJECTS a note that lifts a run of words from any of them, and it rejects one that just reshuffles their words. A rejected note is not stored at all.",
          "  - If your line could be swapped with one of these and nobody would notice, it is the wrong line. Say what is true of THIS record and nothing else.",
          "",
        ]
      : [];

  // The re-author pass: the model's own echo, handed back as the thing to route around.
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

// ---------------------------------------------------------------------------
// THE PROMPT VARIABLES — the facts `buildAuthoringPrompt` used to interpolate in TS,
// handed to the REGISTRY template instead. The prose all lives in the template now (so
// the operator can tune every rail, including the anti-sameness ones), and the sweep
// supplies only the data.
//
// `noContextNote` is the inverse flag the template's `{{#if noContextNote}}` arm reads:
// the renderer has no `else`, on purpose (two constructs, nothing more), so a
// two-armed branch is expressed as two flags. `neighbours` arrives pre-joined — the
// renderer has no loops either, and a list is just a string.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Author one note via `claude -p` (subscription auth, read-only tools). Throws
// ClaudeAuthError on an auth/quota failure (abort the batch); returns null on any
// other failure (leave the finding queued); returns the note + its provenance on success.
//
// THE PROMPT comes from the REGISTRY over the agent-tier API (`get_prompt`), so the
// operator can retune it from /admin with no deploy and no rebake — which matters most
// for THIS prompt, whose neighbour block is the front line against every note in a galaxy
// reading the same. If that fetch fails for any reason, `resolveSweepPrompt` falls back to
// `buildAuthoringPrompt` below and the sweep authors EXACTLY as it did before the registry
// existed. A prompt store that blinks must never be able to stop the pipeline.
// ---------------------------------------------------------------------------

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

  const note = typeof envelope.result === "string" ? envelope.result.trim() : "";

  if (!note) {
    log("claude -p returned an empty note — leaving finding queued");

    return null;
  }

  // The measured authoring spend (shared parse — the CLI's own total_cost_usd is
  // authoritative, the token count is the informational quantity, the model comes off
  // modelUsage else the one we asked for).
  return { note, promptVersion, ...parseAuthoringSpend(envelope, NOTE_CLAUDE_MODEL) };
}

// ---------------------------------------------------------------------------
// Deliver one note: write it to a temp file, post via the CLI (the Worker
// voice-gates + fills-empty-only + stores), clean up. A `skipped:true` (an operator
// note already on file) is an `alreadyNoted` no-op — the operator override wins. A
// gate rejection (403/422) is a `gateSkipped` outcome — the finding stays queued for
// a future author pass.
// ---------------------------------------------------------------------------

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

    const { code, stderr, stdout } = run(FLUNCLE_BIN, [
      "admin",
      "tracks",
      "note",
      id,
      "--script-file",
      notePath,
      // PROVENANCE. Omitted entirely when the registry was unreachable, so the column
      // stays NULL and the artifact is honest about having been written by the baked-in
      // fallback rather than by a version it never saw.
      ...(promptVersion === null ? [] : ["--prompt-version", String(promptVersion)]),
      ...(dryRun ? ["--dry-run"] : []),
      "--json",
    ]);

    if (code !== 0) {
      const combined = `${stdout}\n${stderr}`;
      const detail = combined.toLowerCase();

      // The ECHO gate: the note read like its sonic neighbours, so the Worker refused
      // to store it. Distinct from the voice gate because it is RECOVERABLE — the model
      // gets one more pass, told exactly which move it spent.
      if (detail.includes("note_echoes_neighbours")) {
        const echoedPhrase = readEchoedPhrase(combined);

        log(
          `${id}: the echo gate rejected the note${
            echoedPhrase ? ` (it lifted "${echoedPhrase}")` : ""
          }`,
        );

        return { echoedPhrase, outcome: "echoSkipped" };
      }

      // The voice gate / length bounds reject with a 403/422 + a signature. Treat
      // that as a skip (the finding stays queued), not a hard error.
      if (
        detail.includes("voice_gate") ||
        detail.includes("note_too_short") ||
        detail.includes("note_too_long") ||
        detail.includes("403") ||
        detail.includes("422") ||
        detail.includes("forbidden")
      ) {
        log(`${id}: voice gate / length rejected the note — skipping (stays queued)`);

        return { outcome: "gateSkipped" };
      }

      log(`${id}: note exited ${code}: ${stderr.trim().slice(-200)}`);

      return { outcome: "skipped" };
    }

    // The fill-empty-only guard returns `skipped:true` when an operator note already
    // stands — a clean no-op, NOT a failure (the operator override always wins).
    try {
      const parsed = JSON.parse(stdout) as { skipped?: boolean };

      if (parsed.skipped) {
        log(`${id}: a note is already on file — operator note stands, no-op`);

        return { outcome: "alreadyNoted" };
      }
    } catch {
      // Non-JSON success is unexpected but harmless; treat as a fill.
    }

    log(`${id}: note ${dryRun ? "cleared both gates (dry run, nothing stored)" : "authored"}`);

    return { outcome: "noted" };
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

/**
 * Pull the lifted phrase out of the Worker's `note_echoes_neighbours` message (it
 * quotes it: `it lifts "…" straight from 012.1.0A`), so the re-author pass can name the
 * spent move back to the model. Best-effort — a miss just means a less pointed retry.
 */
export function readEchoedPhrase(output: string): string | undefined {
  // The quotes arrive raw from a human-readable error and BACKSLASH-ESCAPED from a JSON
  // one (`--json` prints the error envelope), so tolerate both.
  const match = /it lifts \\?"([^"\\]+)\\?"/.exec(output);

  return match?.[1];
}

// ---------------------------------------------------------------------------
// The SONIC NEIGHBOURHOOD — the vibe-neighbour layer's fuel. `tracks similar` is the
// public read over the MuQ embedding (an exact cosine scan, ranked in SQL); the Worker's
// echo gate reads the same neighbours, so the note is judged against exactly the notes
// it was shown. Best-effort: a finding with no embedding yet, or one whose neighbours
// carry no notes, comes back empty and the note is authored (and gated) as it was before
// the layer existed. NOTE_NEIGHBORS=0 turns it off outright.
// ---------------------------------------------------------------------------

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

      // Only a NOTED neighbour teaches anything: an un-noted one has no register to
      // read and no move to spend.
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

// ---------------------------------------------------------------------------
// Read the finding's stored context note — the firecrawl facts the context sweep
// distilled, which are the note's PRIMARY authoring fuel. `admin tracks context <id>`
// returns the stored note (`skipped: true`, NO re-fetch) for a finding that already
// has one — and every queue item does (`hasContext=true`), so this is a cheap read
// with no side effect. Best-effort: any failure (or a blank note) degrades to
// identity-only authoring rather than blocking the finding.
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

// The outcome plus the cost row to emit — non-null ONLY when a note was actually
// authored AND delivered (so a no-op / gate-skip / failure never records spend).
type NoteResult = { cost: BoxCostEvent | null; outcome: Outcome };

async function noteOne(queued: QueueFinding, dryRun = false): Promise<NoteResult> {
  const id = queued.trackId ?? queued.logId;

  if (!id) {
    log("queue item without a trackId/logId — skipping");

    return { cost: null, outcome: "skipped" };
  }

  // (a) Gather the finding's identity metadata. `track get` is the SINGULAR public
  // read; it returns the raw finding (galaxy intact). A mixtape arm can't
  // appear here (the queue is findings), but guard anyway.
  const response = fluncleJson<TrackGetResponse>(["tracks", "get", id]);
  const finding = response.track;

  if (!finding || !finding.title || !finding.artists?.length) {
    log(`${id}: missing finding metadata — skipping`);

    return { cost: null, outcome: "skipped" };
  }

  // The fill-empty-only guard lives server-side (the Worker is authoritative), but a
  // belt-and-suspenders client check avoids spending a `claude -p` authoring on a
  // finding that already carries a note (a race between the queue read and now). A DRY
  // RUN skips it: it stores nothing, so an already-noted finding is a legitimate
  // subject (that is how the layer is measured against the live archive).
  if (!dryRun && finding.note?.trim()) {
    log(`${id}: a note is already on file — skipping the authoring spend`);

    return { cost: null, outcome: "alreadyNoted" };
  }

  // (b) Read the stored context note — the PRIMARY authoring fuel (the firecrawl
  // facts the context sweep produced). Best-effort: degrades to identity-only.
  const contextNote = readContextNote(id);

  // (c) Read the SONIC NEIGHBOURHOOD — the notes already standing on the findings that
  // sound nearest to this one (the vibe-neighbour layer). The register to hear, and the
  // moves that are spent. Empty when the finding has no embedding, or NOTE_NEIGHBORS=0.
  const neighbors = readNeighbors(id);

  if (neighbors.length > 0) {
    log(`${id}: ${neighbors.length} noted neighbour(s) in the sonic neighbourhood`);
  }

  // (d) Author → deliver, with ONE re-author if the Worker's echo gate says the line
  // reads like its neighbours. The retry is handed the phrase it echoed, so the second
  // pass knows exactly which move is spent. Two echoes and we stop: the finding stays
  // note-less and queued, because a note that reads like every other note in its region
  // is worth less than no note at all.
  let authored: AuthoredNote | null = null;
  let delivery: Delivery = { outcome: "skipped" };
  let echoedPhrase: string | undefined;

  for (let attempt = 0; attempt <= ECHO_RETRIES; attempt += 1) {
    // Throws ClaudeAuthError to abort the whole batch; returns null to leave THIS
    // finding queued.
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

  // (e) Record the authoring spend ONLY when the note actually landed (`noted`). A
  // gate-skip / operator-note no-op / failure spent the tokens too, but attributing a
  // "note" cost to a finding that has no note would misread — the ledger tracks
  // DELIVERED work. The token spend on a rejected author is accepted lossiness. A DRY
  // RUN delivers nothing, so it records nothing.
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

  // The dry run's whole product is the LINE — print it where the operator can read it,
  // next to the neighbourhood it was written against.
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

// ---------------------------------------------------------------------------
// Main — drain a bounded batch off the note queue.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // `--dry-run <id…>` — the measurement harness. Author for the named findings, run both
  // gates, print the lines, store NOTHING. Pair it with NOTE_NEIGHBORS=0 for the control
  // arm: same findings, same fuel, no neighbourhood. That is how the layer was measured
  // (and how to re-measure it when the corpus grows).
  const argv = process.argv.slice(2);
  const dryRunIds = argv.includes("--dry-run") ? argv.filter((arg) => !arg.startsWith("-")) : [];

  if (dryRunIds.length > 0) {
    log(
      `DRY RUN over ${dryRunIds.length} finding(s), neighbours ${NEIGHBORS_ENABLED ? "ON" : "OFF"} — nothing will be stored`,
    );

    const outcomes: Record<string, string> = {};

    for (const id of dryRunIds) {
      try {
        const { outcome } = await noteOne({ logId: id }, true);
        outcomes[id] = outcome;
      } catch (error) {
        outcomes[id] = "failed";
        log(`error on ${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    console.log(JSON.stringify({ dryRun: true, neighbors: NEIGHBORS_ENABLED, ok: true, outcomes }));

    return;
  }

  // `note --queue --json` returns `{ ok: true, tracks: [...] }`, not a bare array.
  const response = fluncleJson<{ tracks?: QueueFinding[] }>([
    "admin",
    "tracks",
    "note",
    "--queue",
    "--limit",
    String(QUEUE_LIMIT),
  ]);
  const queue = response.tracks ?? [];

  const summary = {
    alreadyNoted: 0,
    // The note echoed its sonic neighbourhood twice over and was left unwritten — the
    // anti-sameness rail firing. A finding here stays queued for a later, colder pass.
    echoSkipped: 0,
    failed: 0,
    gateSkipped: 0,
    noted: 0,
    queueRemaining: queue.length,
  };

  if (queue.length === 0) {
    console.log(JSON.stringify({ ok: true, ...summary }));

    return; // fast no-op
  }

  // The tick's authoring-spend rows, POSTed once at the end (best-effort, after the
  // notes are already durable — a dropped POST only understates the ledger).
  const costs: BoxCostEvent[] = [];

  for (const queued of queue.slice(0, BATCH_CAP)) {
    try {
      const { cost, outcome } = await noteOne(queued);

      if (cost) {
        costs.push(cost);
      }

      if (outcome === "noted") {
        summary.noted += 1;
      } else if (outcome === "alreadyNoted") {
        summary.alreadyNoted += 1;
      } else if (outcome === "gateSkipped") {
        summary.gateSkipped += 1;
      } else if (outcome === "echoSkipped") {
        summary.echoSkipped += 1;
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
            queueRemaining: Math.max(0, queue.length - summary.noted - summary.alreadyNoted),
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

  // queueRemaining is the queue depth AT READ TIME minus what we noted/no-op'd this
  // tick (gate-skips + failures stay queued); the next tick re-reads the live queue.
  summary.queueRemaining = Math.max(0, queue.length - summary.noted - summary.alreadyNoted);

  console.log(JSON.stringify({ ok: true, ...summary }));

  // Record the tick's authoring spend, best-effort, AFTER the summary is printed (the
  // cron parses the summary as its last stdout line; emitCost only logs to stderr).
  // Cannot throw; a hard 2.5s cap keeps it well inside the runner budget.
  await emitCost(costs);
}

// `import.meta.main` so the pure helpers (the authoring prompt, the echo-phrase reader)
// can be imported by the unit test without the sweep firing (the enrich-sweep pattern).
if (import.meta.main) {
  main().catch((error) => {
    log(`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    console.log(JSON.stringify({ ok: false, reason: "sweep_error" }));
    process.exit(1);
  });
}
