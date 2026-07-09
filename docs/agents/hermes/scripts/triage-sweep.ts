#!/usr/bin/env bun
// triage-sweep.ts — the bun orchestrator behind the `--no-agent` submission-triage
// cron (`fluncle-triage`).
//
// Version-controlled source; the repo is canonical and the box is a deploy target
// (fluncle-hermes-operator skill). Invoked by the bash wrapper (triage-sweep.sh) a
// rave-02 HOST systemd timer `docker exec`s — see that file's header and
// ../triage-timer/README.md for the wire-up. Box install is OPERATOR-GATED (the repo
// half ships here; the timer is enabled by hand once).
//
// THE HYBRID MODEL (the submission sibling of note-sweep). A pending crew submission
// arrives at the operator's attention queue unassessed; this sweep pre-chews it so it
// lands with a draft verdict. Everything is deterministic except ONE agentic step:
//
//   1. QUEUE (deterministic): `fluncle admin submissions --json` → the pending
//      review queue, then FILTER to the ones with no `triageVerdict` yet. Empty →
//      fast no-op, exit.
//   2. per submission (bounded batch, BATCH_CAP small — authoring spends subscription
//      quota):
//      a. DEDUPE (deterministic): a submission's `spotifyTrackId` is the archive's
//         `track_id` (approveSubmission keys off exactly that), so
//         `fluncle admin tracks get <spotifyTrackId> --json` resolving a finding means
//         the banger is ALREADY LOGGED. A `not_found` means it is new.
//      b. ASSESS (deterministic + pure): `assessSubmission(...)` scores a cheap DnB
//         plausibility from the metadata keywords + the dedupe result. Pure, unit-tested
//         (triage-sweep.test.ts).
//      c. AUTHOR (the ONE agentic step): build the prompt (the verdict register, with
//         the assessment interpolated) and run `claude -p` — Claude Code, SUBSCRIPTION
//         auth, NOT OpenRouter — with READ-ONLY tools so it can load the installed
//         `copywriting-fluncle` skill for the voice. `.result` is the one-line verdict.
//      d. DELIVER (deterministic): write the verdict to a temp file, then
//         `fluncle admin submissions triage <id> --verdict-file <tmp> --json` → the
//         Worker length-gates it (advisory only, no public voice gate) + stores it onto
//         the PENDING submission. Approve/reject authority NEVER moves — the sweep only
//         does legwork.
//
// AUTH-FAILURE PING. Identical to note-sweep: a `claude -p` AUTH error stops the batch,
// leaves the queue intact, emits a LOUD `{ ok:false, reason:"claude_auth" }` summary
// line, and (if DISCORD_ALERT_WEBHOOK is set) a best-effort Discord ping.
//
// stdout: ONE JSON summary line (the cron run output). Diagnostics → stderr.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Config — a SMALL bounded batch: each verdict burns claude subscription quota, so
// keep ticks cheap. The queue is the durable worklist; anything not reached this tick
// is picked up on the next.
// ---------------------------------------------------------------------------

const BATCH_CAP = 3; // triage is cheaper than note authoring (short verdict, small prompt).
const QUEUE_LIMIT = 100; // ceiling on the queue read (we only act on BATCH_CAP).

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";

// The authoring model. Env-configurable; default the note-sweep-proven Sonnet alias.
const TRIAGE_CLAUDE_MODEL = process.env.TRIAGE_CLAUDE_MODEL ?? "claude-sonnet-4-6";
// Optional reasoning effort, passed through to `claude -p --effort` when set.
const TRIAGE_CLAUDE_EFFORT = process.env.TRIAGE_CLAUDE_EFFORT;
// Optional Discord webhook for the claude-auth-failed alert (best-effort).
const DISCORD_ALERT_WEBHOOK = process.env.DISCORD_ALERT_WEBHOOK;

const log = (message: string) => console.error(`[triage-sweep] ${message}`);

// ---------------------------------------------------------------------------
// Types — only the fields we consume from each surface.
// ---------------------------------------------------------------------------

type PendingSubmission = {
  album?: string;
  artists?: string[];
  id?: string;
  spotifyTrackId?: string;
  title?: string;
  triageVerdict?: string;
};

// The `admin submissions --json` envelope.
type SubmissionsResponse = { submissions?: PendingSubmission[] };

// A `track get` can resolve to a finding OR a mixtape; either presence means the
// spotify id already maps to something in the archive → already logged.
type TrackGetResponse = { mixtape?: unknown; track?: unknown };

type ClaudeEnvelope = {
  is_error?: boolean;
  result?: string;
  subtype?: string;
};

type Outcome = "triaged" | "gateSkipped" | "skipped";

// A narrow sentinel the loop throws to abort the batch on a claude auth failure.
class ClaudeAuthError extends Error {}

// ---------------------------------------------------------------------------
// THE PURE HEURISTIC — the cheap DnB plausibility read from a submission's metadata
// plus its dedupe result. Pure + exported so triage-sweep.test.ts can pin it without
// a network or a claude spawn. The verdict phrasing (claude) reads this; the decision
// stays the operator's.
// ---------------------------------------------------------------------------

export type Plausibility = "likely" | "unclear" | "unlikely";

export type SubmissionAssessment = {
  /** The banger's spotify id already maps to a finding/mixtape — "already logged". */
  archived: boolean;
  /** The cheap metadata read: does this look like Fluncle's lane (drum & bass)? */
  plausibility: Plausibility;
  /** The human-readable signals that drove the score (fuel for the phrasing step). */
  signals: string[];
};

// DnB-positive keywords that commonly ride in a title/album/version tag. Lowercase,
// matched as substrings (so "vip" catches "Mr Right On VIP"). Deliberately small +
// high-precision — a cheap prior, not a genre classifier.
const DNB_POSITIVE = [
  "drum & bass",
  "drum and bass",
  "drum n bass",
  "dnb",
  "d&b",
  "jungle",
  "neurofunk",
  "liquid funk",
  "jump up",
  "breakbeat",
  "amen",
  "halftime",
  "rollers",
  "roller",
  "174",
];

// Signals that a submission is plainly NOT the lane (a different genre named in the
// text). Weak on their own; they only tip an otherwise-blank read to "unlikely".
const OFF_LANE = [
  "acoustic",
  "orchestral",
  "piano version",
  "lo-fi",
  "lofi",
  "country",
  "reggaeton",
];

function hits(haystack: string, needles: string[]): string[] {
  const lower = haystack.toLowerCase();

  return needles.filter((needle) => lower.includes(needle));
}

/**
 * Score a submission's DnB plausibility from its metadata + dedupe result. Pure.
 *
 *   - archived (spotify id already in the archive)         → the dominant fact; the
 *                                                             verdict is "already logged"
 *                                                             regardless of plausibility.
 *   - a known archive artist (a prior Fluncle find)        → strong "our lane" prior.
 *   - a DnB-positive keyword in the title/album            → "likely".
 *   - only an off-lane keyword, nothing positive           → "unlikely".
 *   - nothing either way                                   → "unclear" (the honest default —
 *                                                             most DnB carries no genre tag).
 */
export function assessSubmission(input: {
  album?: string;
  archived: boolean;
  artists: string[];
  /** Lowercased artist names already in the archive — a strong same-lane prior (optional). */
  knownArtists?: string[];
  title: string;
}): SubmissionAssessment {
  const { album = "", archived, artists, knownArtists = [], title } = input;
  const text = `${title} ${album}`;
  const signals: string[] = [];

  const positives = hits(text, DNB_POSITIVE);
  for (const signal of positives) {
    signals.push(`title/album names "${signal}"`);
  }

  const known = new Set(knownArtists.map((name) => name.toLowerCase()));
  const knownHit = artists.find((artist) => known.has(artist.toLowerCase()));
  if (knownHit) {
    signals.push(`${knownHit} is already in the archive`);
  }

  const offLane = hits(text, OFF_LANE);
  for (const signal of offLane) {
    signals.push(`title/album names "${signal}" (off-lane)`);
  }

  let plausibility: Plausibility;
  if (knownHit || positives.length > 0) {
    plausibility = "likely";
  } else if (offLane.length > 0) {
    plausibility = "unlikely";
  } else {
    plausibility = "unclear";
  }

  if (archived) {
    signals.unshift("spotify id already maps to a finding in the archive");
  }

  return { archived, plausibility, signals };
}

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
// claude-auth detection — narrow on purpose (shared with note-sweep): only an explicit
// re-auth/login/quota signature counts, so a transient model error does not false-alarm.
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
// The authoring prompt — the verdict register (a short operator-internal one-liner,
// NOT a public /log note), with this submission's assessment interpolated. The model
// loads `copywriting-fluncle` for the voice; the hard constraint is that the line reads
// as one of three verdicts: "looks like a find", "already logged", or "not our lane".
// ---------------------------------------------------------------------------

export function buildTriagePrompt(
  submission: { album?: string; artists: string[]; title: string },
  assessment: SubmissionAssessment,
): string {
  const artists = submission.artists.length ? submission.artists.join(", ") : "unknown";
  const lean = assessment.archived
    ? "ALREADY LOGGED — the spotify id already maps to a finding in the archive."
    : assessment.plausibility === "likely"
      ? "LOOKS LIKE A FIND — the metadata leans drum & bass / Fluncle's lane."
      : assessment.plausibility === "unlikely"
        ? "PROBABLY NOT OUR LANE — the metadata names a non-DnB genre."
        : "UNCLEAR — the metadata carries no genre tell (most DnB doesn't).";

  return [
    "You are Fluncle, pre-chewing one crew submission for the operator's review queue.",
    "Load and apply the `copywriting-fluncle` skill — it is the full voice canon.",
    "",
    "Write ONE short internal verdict line (a heads-up for the operator, never shown publicly):",
    "the register is dry, certain, and lands as one of three reads —",
    '  "looks like a find" / "already logged" / "not our lane".',
    "",
    "THE SUBMISSION:",
    `  artists: ${artists}`,
    `  title: ${submission.title}`,
    `  album: ${submission.album ?? "unknown"}`,
    "",
    "THE DETERMINISTIC ASSESSMENT (ground your verdict in this — never contradict it):",
    `  lean: ${lean}`,
    `  signals: ${assessment.signals.length ? assessment.signals.join("; ") : "none"}`,
    "",
    "CONSTRAINTS (the server length-gates the line; keep it tight):",
    "  - ONE line, roughly 20 to 140 characters. No second sentence.",
    "  - Advisory, not a decision: you never approve or reject — you flag.",
    "  - Dry confidence. No exclamation marks. No em dashes. Sentence case.",
    "  - If ALREADY LOGGED, say so plainly (the operator will likely reject a dupe).",
    "  - Name the artist only if it sharpens the read; never invent a fact.",
    "",
    "Output ONLY the verdict line. No preamble, no quotes, no explanation.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Author one verdict via `claude -p` (subscription auth, read-only tools). Throws
// ClaudeAuthError on an auth/quota failure (abort the batch); returns null on any other
// failure (leave the submission un-triaged); returns the verdict string on success.
// ---------------------------------------------------------------------------

function authorVerdict(
  submission: { album?: string; artists: string[]; title: string },
  assessment: SubmissionAssessment,
): string | null {
  const prompt = buildTriagePrompt(submission, assessment);
  const args = [
    "-p",
    "--model",
    TRIAGE_CLAUDE_MODEL,
    "--allowedTools",
    "Read,Glob,Grep",
    "--output-format",
    "json",
  ];

  if (TRIAGE_CLAUDE_EFFORT) {
    args.push("--effort", TRIAGE_CLAUDE_EFFORT);
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

    log(`claude -p returned is_error (${envelope.subtype ?? "?"}) — leaving submission un-triaged`);

    return null;
  }

  const verdict = typeof envelope.result === "string" ? envelope.result.trim() : "";

  if (!verdict) {
    log("claude -p returned an empty verdict — leaving submission un-triaged");

    return null;
  }

  return verdict;
}

// ---------------------------------------------------------------------------
// Dedupe: is the submission's spotify id already a finding in the archive? A submission's
// `spotifyTrackId` IS the archive's `track_id`, so `admin tracks get` resolving it means
// already logged. A `not_found` (non-zero exit) is a clean "new" — swallowed here.
// ---------------------------------------------------------------------------

function isArchived(spotifyTrackId: string): boolean {
  const { code, stdout } = run(FLUNCLE_BIN, ["admin", "tracks", "get", spotifyTrackId, "--json"]);

  if (code !== 0) {
    return false; // not_found / any lookup miss ⇒ treat as new.
  }

  try {
    const parsed = JSON.parse(stdout) as TrackGetResponse;

    return Boolean(parsed.track || parsed.mixtape);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Deliver one verdict: write it to a temp file, post via the CLI (the Worker
// length-gates + stores onto the PENDING submission), clean up. A gate rejection
// (400/422) is a `gateSkipped`; a 409 (already reviewed) is a `skipped` no-op.
// ---------------------------------------------------------------------------

function deliverVerdict(id: string, verdict: string): Outcome {
  const dir = mkdtempSync(join(tmpdir(), "triage-sweep-"));
  const verdictPath = join(dir, "verdict.txt");

  try {
    writeFileSync(verdictPath, verdict, "utf8");

    const { code, stderr, stdout } = run(FLUNCLE_BIN, [
      "admin",
      "submissions",
      "triage",
      id,
      "--verdict-file",
      verdictPath,
      "--json",
    ]);

    if (code !== 0) {
      const detail = `${stdout}\n${stderr}`.toLowerCase();

      if (
        detail.includes("verdict_too_short") ||
        detail.includes("verdict_too_long") ||
        detail.includes("no_verdict") ||
        detail.includes("422") ||
        detail.includes("400")
      ) {
        log(`${id}: the length gate rejected the verdict — skipping (stays un-triaged)`);

        return "gateSkipped";
      }

      // A 409 means the submission was approved/rejected between the queue read and now
      // — a clean no-op (the operator already decided), not a failure.
      if (detail.includes("invalid_status") || detail.includes("409")) {
        log(`${id}: already reviewed — nothing to triage`);

        return "skipped";
      }

      log(`${id}: triage exited ${code}: ${stderr.trim().slice(-200)}`);

      return "skipped";
    }

    log(`${id}: verdict written`);

    return "triaged";
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Per-submission: dedupe → assess → author → deliver.
// ---------------------------------------------------------------------------

function triageOne(submission: PendingSubmission): Outcome {
  const id = submission.id;
  const spotifyTrackId = submission.spotifyTrackId;

  if (!id || !spotifyTrackId || !submission.title || !submission.artists?.length) {
    log("submission missing id/spotifyTrackId/title/artists — skipping");

    return "skipped";
  }

  // (a) DEDUPE against the archive by spotify id (= track_id).
  const archived = isArchived(spotifyTrackId);

  // (b) ASSESS — the cheap, pure DnB plausibility read.
  const assessment = assessSubmission({
    ...(submission.album ? { album: submission.album } : {}),
    archived,
    artists: submission.artists,
    title: submission.title,
  });

  // (c) AUTHOR the one-line verdict (the one agentic step). Throws ClaudeAuthError to
  // abort the whole batch; returns null to leave THIS submission un-triaged.
  const verdict = authorVerdict(
    {
      ...(submission.album ? { album: submission.album } : {}),
      artists: submission.artists,
      title: submission.title,
    },
    assessment,
  );

  if (!verdict) {
    return "skipped";
  }

  // (d) DELIVER: the CLI posts it; the Worker length-gates + stores onto the pending row.
  return deliverVerdict(id, verdict);
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
      content: "Fluncle triage-sweep: claude auth failed, re-auth needed.",
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
// Main — drain a bounded batch off the un-triaged pending submissions.
// ---------------------------------------------------------------------------

function main(): void {
  // `admin submissions --json` returns `{ ok: true, submissions: [...] }`.
  const response = fluncleJson<SubmissionsResponse>(["admin", "submissions"]);
  const pending = (response.submissions ?? []).slice(0, QUEUE_LIMIT);
  // Only the ones the sweep hasn't voiced yet (fill-empty-first; the sweep may refresh
  // its own prior verdict on a later manual re-run, but the cron acts on blanks).
  const queue = pending.filter((submission) => !submission.triageVerdict?.trim());

  const summary = {
    gateSkipped: 0,
    queueRemaining: queue.length,
    skipped: 0,
    triaged: 0,
  };

  if (queue.length === 0) {
    console.log(JSON.stringify({ ok: true, ...summary }));

    return; // fast no-op
  }

  for (const submission of queue.slice(0, BATCH_CAP)) {
    try {
      const outcome = triageOne(submission);

      if (outcome === "triaged") {
        summary.triaged += 1;
      } else if (outcome === "gateSkipped") {
        summary.gateSkipped += 1;
      } else {
        summary.skipped += 1;
      }
    } catch (error) {
      if (error instanceof ClaudeAuthError) {
        log("claude auth failed — aborting the batch, the queue is untouched");
        pingClaudeAuthFailure(error.message);
        console.log(
          JSON.stringify({
            ok: false,
            reason: "claude_auth",
            ...summary,
            queueRemaining: Math.max(0, queue.length - summary.triaged),
          }),
        );
        process.exit(1);
      }

      // One submission's failure must not abort the sweep — log it and move on; it
      // stays un-triaged for the next tick.
      summary.skipped += 1;
      log(
        `error on ${submission.id ?? "?"}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  summary.queueRemaining = Math.max(0, queue.length - summary.triaged);

  console.log(JSON.stringify({ ok: true, ...summary }));
}

// `import.meta.main` guards the entrypoint so the test can import the pure helpers
// (assessSubmission, buildTriagePrompt) without spawning fluncle/claude.
if (import.meta.main) {
  try {
    main();
  } catch (error) {
    log(`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    console.log(JSON.stringify({ ok: false, reason: "sweep_error" }));
    process.exit(1);
  }
}
