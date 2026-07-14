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
//         identity metadata (artists, title, label, release year, galaxy),
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
import { resolveSweepPrompt } from "./prompt-fetch";

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

// The sonic neighbourhood the observation is authored against — the same six the note layer
// and `/log`'s "more like this" use. The Worker's echo gate reads the SAME neighbours, so the
// script is judged against exactly the scripts it was shown (one definition of "the
// neighbourhood" on both sides of the wire).
const NEIGHBOR_LIMIT = 6;

// The re-author budget when the Worker's echo gate rejects a script for echoing its
// neighbourhood. ONE retry: the second attempt is handed the move it spent, so it knows exactly
// what to route around. A second echo means the model has nothing fresh for this finding — leave
// it unvoiced (silence beats a generic read) and let the next tick try with a cold context.
const ECHO_RETRIES = 1;

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";

// The vibe-neighbour layer's kill switch (and the A/B control): OBSERVE_NEIGHBORS=0 authors from
// the context note + identity alone, exactly as the sweep did before the layer.
const NEIGHBORS_ENABLED = process.env.OBSERVE_NEIGHBORS !== "0";

// The agent-tier API the neighbourhood read rides (the same seam prompt-fetch.ts + cost-emit.ts
// use — the box runs a PINNED CLI, so a NEW read verb does not exist there until a release + a
// pin bump; a raw HTTP GET with the agent token is the only way to reach something new).
const FLUNCLE_API_BASE_URL = (
  process.env.FLUNCLE_API_BASE_URL ?? "https://www.fluncle.com"
).replace(/\/+$/, "");
const FLUNCLE_API_TOKEN = process.env.FLUNCLE_API_TOKEN ?? "";
const NEIGHBOURS_TIMEOUT_MS = 2500;

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
};

// A `track get` can resolve to a finding OR a mixtape; we only ever queue findings.
type TrackGetResponse = { mixtape?: unknown; track?: Finding };

// One member of the finding's sonic neighbourhood: a nearby finding's Log ID and the
// observation script already standing on it. The register to hear, and the moves that are SPENT
// (the openers, closers, and body reactions the new read must route around).
export type Neighbor = { logId: string; script: string };

// `GET /api/admin/tracks/{id}/observation-neighbours` → the lean neighbourhood read.
type NeighboursResponse = { neighbours?: Neighbor[] };

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

type Outcome = "rendered" | "gateSkipped" | "echoSkipped" | "skipped";

// What the Worker made of a delivered script. `echoedMove` carries the phrase the echo gate
// caught, so the re-author pass can hand the model its own echo back as the thing to avoid.
type Delivery = { echoedMove?: string; outcome: Outcome };

// The authored script plus its MEASURED authoring spend (the COST-01 §5 `observe`
// row): the total_cost_usd the CLI computed, the model, and the token count. `usd` is
// null only if the envelope carried no `total_cost_usd` (then the row is unpriced,
// never $0).
type AuthoredScript = {
  model: string;
  // PROVENANCE — the prompt version this observation was authored under: N = the
  // operator's live override, 0 = the registry's baked default, NULL = the registry was
  // unreachable and the inlined `buildAuthoringPrompt` below wrote it. Rides out to the
  // Worker on `--prompt-version`, so an observation authored during an outage is legible
  // as such forever rather than credited to a version that never saw it.
  promptVersion: number | null;
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
//
// THIS IS THE FLOOR, NOT DEAD CODE. The live prompt comes from the registry over the
// API (see `authorScript`); this builder is what runs when that fetch fails for ANY
// reason, and it is what makes "the prompt store is down" a boring event instead of a
// stopped pipeline. Keep it in lockstep with the `observation_script` default body in
// apps/web/src/lib/server/prompts.ts.
// ---------------------------------------------------------------------------

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

  // The re-author pass: the model's own echo, handed back as the thing to route around.
  const echoBlock = echoedMove
    ? [
        `YOUR LAST ATTEMPT WAS REJECTED: it echoed a neighbour's read ("${echoedMove}"). That move is spent. Arrive at this record from somewhere else entirely — a different body reaction, a different moment in the track, a different way of turning to the crew.`,
        "",
      ]
    : [];

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

  // THE VIBE-NEIGHBOUR LAYER. The observations already standing on the findings that sound
  // nearest to this one — the register of this corner of the archive, and a list of what is
  // already taken. The Worker enforces the exclusion mechanically (it re-reads these same
  // scripts and rejects a lift), so this is not a style suggestion.
  const neighborBlock =
    neighbors.length > 0
      ? [
          "THE SONIC NEIGHBOURHOOD (the observations already standing on the findings that sound nearest to this one):",
          ...neighbors.map((neighbor) => `  - ${neighbor.logId}: "${neighbor.script}"`),
          "",
          "READ THEM TWICE, THEN USE THEM AS A LIST OF WHAT IS ALREADY TAKEN.",
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
    '  - The turn to the crew is required, but it is ONE move with many shapes. VARY THE ADDRESS: rotate the kin name you land on (junglist, raver, fam, cosmonaut) and vary the phrasing, and let some reads make the turn with no sign-off tag at all. Never default to "hope it… enjoy, cosmonauts" — that exact close is worn through. Drop "hope" as a reflex; say what the tune does, not what you hope it does.',
    "  - NEVER name earthly geography (no countries, cities, regions); the cosmos replaces the map.",
    "  - Use only SPARSE `<break>` tags (dense breaks get vocalised as thinking sounds). A couple at most.",
    "  - No exclamation marks. No em dashes in the prose. Sentence case.",
    "  - No banned identity words (per the skill's voice canon).",
    "",
    "Output ONLY the spoken script text. No preamble, no headings, no quotes around it, no explanation — just the words to be spoken.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// THE PROMPT VARIABLES — the facts `buildAuthoringPrompt` used to interpolate in TS,
// handed to the REGISTRY template instead. The prose all lives in the template now (so
// the operator can tune every rail), and the sweep supplies only the data.
//
// `noContextNote` is the inverse flag the template's `{{#if noContextNote}}` arm reads:
// the renderer has no `else`, on purpose (two constructs, nothing more), so a two-armed
// branch is expressed as two flags. These names MUST match the `variables` array of the
// `observation_script` registry entry exactly, or the template renders holes.
// ---------------------------------------------------------------------------

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
    // Pre-joined — the renderer has no loops, so a list is just a string. Same format the
    // fallback builder's neighbour block uses, so the two render identically (the drift guard).
    neighbours: neighbors
      .map((neighbor) => `  - ${neighbor.logId}: "${neighbor.script}"`)
      .join("\n"),
    noContextNote: contextNote ? "" : "yes",
    title: finding.title ?? "unknown",
    year: finding.releaseDate ? finding.releaseDate.slice(0, 4) : "unknown",
  };
}

// ---------------------------------------------------------------------------
// Author one script via `claude -p` (subscription auth, read-only tools). Throws
// ClaudeAuthError on an auth/quota failure (abort the batch); returns null on any
// other failure (leave the finding queued); returns the script + its provenance on
// success.
//
// THE PROMPT comes from the REGISTRY over the agent-tier API (`get_prompt`), so the
// operator can retune the spoken voice from /admin with no deploy and no rebake. If that
// fetch fails for any reason, `resolveSweepPrompt` falls back to `buildAuthoringPrompt`
// above and the sweep authors EXACTLY as it did before the registry existed. A prompt
// store that blinks must never be able to stop the pipeline.
// ---------------------------------------------------------------------------

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
  return { promptVersion, script, ...parseAuthoringSpend(envelope, OBSERVE_CLAUDE_MODEL) };
}

// ---------------------------------------------------------------------------
// Deliver one script: write it to a temp file, post via the CLI (the Worker
// voice-gates + ECHO-gates + renders + stores), clean up. A voice-gate rejection is a
// `gateSkipped` outcome; the ECHO gate is distinct because it is RECOVERABLE — the
// model gets one more pass, told exactly which move it spent. Both leave the finding queued.
// ---------------------------------------------------------------------------

function deliverScript(id: string, script: string, promptVersion: number | null): Delivery {
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
      // PROVENANCE. Omitted entirely when the registry was unreachable, so the column
      // stays NULL and the artifact is honest about having been written by the baked-in
      // fallback rather than by a version it never saw.
      ...(promptVersion === null ? [] : ["--prompt-version", String(promptVersion)]),
      "--json",
    ]);

    if (code !== 0) {
      const combined = `${stdout}\n${stderr}`;
      const detail = combined.toLowerCase();

      // The ECHO gate: the script read like its sonic neighbours, so the Worker refused to
      // render it (before spending a cent). Distinct from the voice gate because it is
      // RECOVERABLE — the model gets one more pass, told exactly which move it spent.
      if (detail.includes("observation_echoes_neighbours")) {
        const echoedMove = readEchoedMove(combined);

        log(
          `${id}: the echo gate rejected the observation${
            echoedMove ? ` (it lifted "${echoedMove}")` : ""
          }`,
        );

        return { echoedMove, outcome: "echoSkipped" };
      }

      // The voice gate rejects with a 403/422 + a voice_gate/forbidden signature.
      // Treat that as a skip (the finding stays queued), not a hard error.
      if (
        detail.includes("voice_gate") ||
        detail.includes("403") ||
        detail.includes("422") ||
        detail.includes("forbidden")
      ) {
        log(`${id}: voice gate rejected the script — skipping (stays queued)`);

        return { outcome: "gateSkipped" };
      }

      log(`${id}: observe exited ${code}: ${stderr.trim().slice(-200)}`);

      return { outcome: "skipped" };
    }

    log(`${id}: observation rendered`);

    return { outcome: "rendered" };
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

/**
 * Pull the lifted phrase out of the Worker's `observation_echoes_neighbours` message (it
 * quotes it: `it lifts "…" straight from 012.1.0A`), so the re-author pass can name the spent
 * move back to the model. Best-effort — a miss just means a less pointed retry. Tolerates both
 * the raw and the JSON-escaped quoting (the note-sweep's `readEchoedPhrase` precedent).
 */
export function readEchoedMove(output: string): string | undefined {
  const match = /it lifts \\?"([^"\\]+)\\?"/.exec(output);

  return match?.[1];
}

// ---------------------------------------------------------------------------
// The SONIC NEIGHBOURHOOD — the vibe-neighbour layer's fuel. A raw HTTP GET to the agent-tier
// `list_observation_neighbours` endpoint (the box runs a pinned CLI, so a new read verb does not
// exist there — this is the prompt-fetch.ts / cost-emit.ts seam). Best-effort: no token, a
// non-2xx, a timeout, or a malformed body all come back `[]` and the observation is authored
// (and gated) exactly as before the layer. OBSERVE_NEIGHBORS=0 turns it off outright.
// ---------------------------------------------------------------------------

async function readNeighbours(id: string): Promise<Neighbor[]> {
  if (!NEIGHBORS_ENABLED) {
    return [];
  }

  if (!FLUNCLE_API_TOKEN) {
    log(`${id}: no FLUNCLE_API_TOKEN — authoring without the sonic neighbourhood`);

    return [];
  }

  try {
    const url = `${FLUNCLE_API_BASE_URL}/api/admin/tracks/${encodeURIComponent(
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

async function observeOne(queued: QueueFinding): Promise<ObserveResult> {
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

  // (b) Read the stored context note — the PRIMARY authoring fuel (the firecrawl
  // facts the context sweep produced). Best-effort: degrades to identity-only.
  const contextNote = readContextNote(id);

  // (c) Read the SONIC NEIGHBOURHOOD — the observations already standing on the findings that
  // sound nearest to this one (the vibe-neighbour layer). The register to hear, and the moves
  // that are spent. Empty when the finding has no embedding, or OBSERVE_NEIGHBORS=0.
  const neighbors = await readNeighbours(id);

  if (neighbors.length > 0) {
    log(`${id}: ${neighbors.length} neighbour observation(s) in the sonic neighbourhood`);
  }

  // (d) Author → deliver, with ONE re-author if the Worker's echo gate says the read is too
  // close to its neighbours. The retry is handed the move it echoed, so the second pass knows
  // exactly what is spent. Two echoes and we stop: the finding stays unvoiced and queued,
  // because an observation that reads like every other one in its region is worth less than none.
  let authored: AuthoredScript | null = null;
  let delivery: Delivery = { outcome: "skipped" };
  let echoedMove: string | undefined;

  for (let attempt = 0; attempt <= ECHO_RETRIES; attempt += 1) {
    // Throws ClaudeAuthError to abort the whole batch; returns null to leave THIS finding queued.
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

  // (e) Record the authoring spend ONLY when the observation actually rendered. A
  // gate-skip / failure spent the tokens too, but attributing an "observe" cost to a
  // finding with no observation would misread — the ledger tracks DELIVERED work. The
  // token spend on a rejected author is accepted lossiness.
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

  const summary = {
    // The read echoed its sonic neighbourhood twice over and was left unrendered — the
    // anti-sameness rail firing. A finding here stays queued for a later, colder pass.
    echoSkipped: 0,
    failed: 0,
    gateSkipped: 0,
    queueRemaining: queue.length,
    rendered: 0,
  };

  if (queue.length === 0) {
    console.log(JSON.stringify({ ok: true, ...summary }));

    return; // fast no-op
  }

  // The tick's authoring-spend rows, POSTed once at the end (best-effort, after the
  // observations are already durable — a dropped POST only understates the ledger).
  const costs: BoxCostEvent[] = [];

  for (const queued of queue.slice(0, BATCH_CAP)) {
    try {
      const { cost, outcome } = await observeOne(queued);

      if (cost) {
        costs.push(cost);
      }

      if (outcome === "rendered") {
        summary.rendered += 1;
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

// `import.meta.main` so the pure helper (the fallback authoring prompt) can be imported
// by a unit test without the sweep firing (the note-sweep / triage-sweep pattern).
if (import.meta.main) {
  main().catch((error) => {
    log(`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    console.log(JSON.stringify({ ok: false, reason: "sweep_error" }));
    process.exit(1);
  });
}
