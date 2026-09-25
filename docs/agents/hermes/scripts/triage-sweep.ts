#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSweepPrompt } from "./prompt-fetch";

const BATCH_CAP = 3;
const QUEUE_LIMIT = 100;

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";

process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";

const TRIAGE_CLAUDE_MODEL = process.env.TRIAGE_CLAUDE_MODEL ?? "claude-sonnet-5";

const TRIAGE_CLAUDE_EFFORT = process.env.TRIAGE_CLAUDE_EFFORT;

const DISCORD_ALERT_WEBHOOK = process.env.DISCORD_ALERT_WEBHOOK;

const log = (message: string) => console.error(`[triage-sweep] ${message}`);

type PendingSubmission = {
  album?: string;
  artists?: string[];
  id?: string;
  spotifyTrackId?: string;
  title?: string;
  triageVerdict?: string;
};

type SubmissionsResponse = { submissions?: PendingSubmission[] };

type TrackGetResponse = { mixtape?: unknown; track?: unknown };

type ClaudeReply = {
  is_error?: boolean;
  result?: string;
  subtype?: string;
};

export type TriageOutcome = "triaged" | "gateSkipped" | "alreadyReviewed" | "failed";

export type TriageSweepSummary = {
  alreadyReviewed: number;
  checked: number;
  errors: number;
  failed: number;
  gateSkipped: number;
  produced: number;
  queue_depth: number;
  queueRemaining: number;
  skipped: number;
  triaged: number;
};

export function createTriageSummary(untriaged: number): TriageSweepSummary {
  return {
    alreadyReviewed: 0,
    checked: 0,
    errors: 0,
    failed: 0,
    gateSkipped: 0,
    produced: 0,
    queueRemaining: untriaged,
    queue_depth: untriaged,
    skipped: 0,
    triaged: 0,
  };
}

export function recordTriageOutcome(summary: TriageSweepSummary, outcome: TriageOutcome): void {
  summary.checked += 1;

  if (outcome === "triaged") {
    summary.triaged += 1;
    summary.produced += 1;
    summary.queue_depth = Math.max(0, summary.queue_depth - 1);
  } else if (outcome === "gateSkipped") {
    summary.gateSkipped += 1;
  } else {
    summary.skipped += 1;

    if (outcome === "alreadyReviewed") {
      summary.alreadyReviewed += 1;
      summary.queue_depth = Math.max(0, summary.queue_depth - 1);
    } else {
      summary.failed += 1;
    }
  }

  summary.queueRemaining = summary.queue_depth;
}

export function buildTriageFatalSummary(): Record<string, unknown> {
  return {
    checked: null,
    errors: 1,
    failed: null,
    ok: false,
    produced: null,
    reason: "sweep_error",
  };
}

class ClaudeAuthError extends Error {}

export type Plausibility = "likely" | "unclear" | "unlikely";

export type SubmissionAssessment = {
  archived: boolean;

  plausibility: Plausibility;

  signals: string[];
};

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

export function assessSubmission(input: {
  album?: string;
  archived: boolean;
  artists: string[];

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

function leanLine(assessment: SubmissionAssessment): string {
  if (assessment.archived) {
    return "ALREADY LOGGED: the spotify id already maps to a finding in the archive.";
  }

  if (assessment.plausibility === "likely") {
    return "LOOKS LIKE A FIND: the metadata leans drum & bass / Fluncle's lane.";
  }

  if (assessment.plausibility === "unlikely") {
    return "PROBABLY NOT OUR LANE: the metadata names a non-DnB genre.";
  }

  return "UNCLEAR: the metadata carries no genre tell (most DnB doesn't).";
}

function promptVariables(
  submission: { album?: string; artists: string[]; title: string },
  assessment: SubmissionAssessment,
): Record<string, string | undefined> {
  return {
    album: submission.album ?? "unknown",
    artists: submission.artists.length ? submission.artists.join(", ") : "unknown",
    lean: leanLine(assessment),
    signals: assessment.signals.length ? assessment.signals.join("; ") : "none",
    title: submission.title,
  };
}

export function buildTriagePrompt(
  submission: { album?: string; artists: string[]; title: string },
  assessment: SubmissionAssessment,
): string {
  const artists = submission.artists.length ? submission.artists.join(", ") : "unknown";
  const lean = leanLine(assessment);

  return [
    "You are Fluncle, pre-chewing one crew submission for the operator's review queue.",
    "Load and apply the `copywriting-fluncle` skill: it is the full voice canon.",
    "",
    "Write ONE short internal verdict line (a heads-up for the operator, never shown publicly):",
    "the register is dry, certain, and lands as one of three reads:",
    '  "looks like a find" / "already logged" / "not our lane".',
    "",
    "THE SUBMISSION:",
    `  artists: ${artists}`,
    `  title: ${submission.title}`,
    `  album: ${submission.album ?? "unknown"}`,
    "",
    "THE DETERMINISTIC ASSESSMENT (ground your verdict in this, never contradict it):",
    `  lean: ${lean}`,
    `  signals: ${assessment.signals.length ? assessment.signals.join("; ") : "none"}`,
    "",
    "CONSTRAINTS (the server length-gates the line; keep it tight):",
    "  - ONE line, roughly 20 to 140 characters. No second sentence.",
    "  - Advisory, not a decision: you never approve or reject, you flag.",
    "  - Dry confidence. No exclamation marks. No em dashes. Sentence case.",
    "  - If ALREADY LOGGED, say so plainly (the operator will likely reject a dupe).",
    "  - Name the artist only if it sharpens the read; never invent a fact.",
    "",
    "Output ONLY the verdict line. No preamble, no quotes, no explanation.",
  ].join("\n");
}

type AuthoredVerdict = { promptVersion: number | null; verdict: string };

async function authorVerdict(
  submission: { album?: string; artists: string[]; title: string },
  assessment: SubmissionAssessment,
): Promise<AuthoredVerdict | null> {
  const { prompt, promptVersion } = await resolveSweepPrompt({
    fallback: () => buildTriagePrompt(submission, assessment),
    slug: "triage_verdict",
    variables: promptVariables(submission, assessment),
  });

  if (promptVersion === null) {
    log("the prompt registry was unreachable — authoring from the baked-in default");
  }

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

    log(`claude -p returned is_error (${reply.subtype ?? "?"}) — leaving submission un-triaged`);

    return null;
  }

  const verdict = typeof reply.result === "string" ? reply.result.trim() : "";

  if (!verdict) {
    log("claude -p returned an empty verdict — leaving submission un-triaged");

    return null;
  }

  return { promptVersion, verdict };
}

function isArchived(spotifyTrackId: string): boolean {
  const { code, stdout } = run(FLUNCLE_BIN, ["admin", "tracks", "get", spotifyTrackId, "--json"]);

  if (code !== 0) {
    return false;
  }

  try {
    const parsed = JSON.parse(stdout) as TrackGetResponse;

    return Boolean(parsed.track || parsed.mixtape);
  } catch {
    return false;
  }
}

export function classifyTriageDeliveryFailure(detail: string): Exclude<TriageOutcome, "triaged"> {
  const normalized = detail.toLowerCase();

  if (
    normalized.includes("verdict_too_short") ||
    normalized.includes("verdict_too_long") ||
    normalized.includes("no_verdict") ||
    normalized.includes("422") ||
    normalized.includes("400")
  ) {
    return "gateSkipped";
  }

  if (normalized.includes("invalid_status") || normalized.includes("409")) {
    return "alreadyReviewed";
  }

  return "failed";
}

function deliverVerdict(id: string, verdict: string, promptVersion: number | null): TriageOutcome {
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

      ...(promptVersion === null ? [] : ["--prompt-version", String(promptVersion)]),
      "--json",
    ]);

    if (code !== 0) {
      const detail = `${stdout}\n${stderr}`;
      const outcome = classifyTriageDeliveryFailure(detail);

      if (outcome === "gateSkipped") {
        log(`${id}: the length gate rejected the verdict — skipping (stays un-triaged)`);

        return "gateSkipped";
      }

      if (outcome === "alreadyReviewed") {
        log(`${id}: already reviewed — nothing to triage`);

        return "alreadyReviewed";
      }

      log(`${id}: triage exited ${code}: ${stderr.trim().slice(-200)}`);

      return "failed";
    }

    log(`${id}: verdict written`);

    return "triaged";
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

async function triageOne(submission: PendingSubmission): Promise<TriageOutcome> {
  const id = submission.id;
  const spotifyTrackId = submission.spotifyTrackId;

  if (!id || !spotifyTrackId || !submission.title || !submission.artists?.length) {
    log("submission missing id/spotifyTrackId/title/artists — skipping");

    return "failed";
  }

  const archived = isArchived(spotifyTrackId);

  const assessment = assessSubmission({
    ...(submission.album ? { album: submission.album } : {}),
    archived,
    artists: submission.artists,
    title: submission.title,
  });

  const authored = await authorVerdict(
    {
      ...(submission.album ? { album: submission.album } : {}),
      artists: submission.artists,
      title: submission.title,
    },
    assessment,
  );

  if (!authored) {
    return "failed";
  }

  return deliverVerdict(id, authored.verdict, authored.promptVersion);
}

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

async function main(): Promise<void> {
  const response = fluncleJson<SubmissionsResponse>(["admin", "submissions"]);
  const pending = response.submissions ?? [];

  const untriaged = pending.filter((submission) => !submission.triageVerdict?.trim());
  const queue = untriaged.slice(0, QUEUE_LIMIT);

  const summary = createTriageSummary(untriaged.length);

  if (queue.length === 0) {
    console.log(JSON.stringify({ ok: true, ...summary }));

    return;
  }

  for (const submission of queue.slice(0, BATCH_CAP)) {
    try {
      const outcome = await triageOne(submission);

      recordTriageOutcome(summary, outcome);
    } catch (error) {
      if (error instanceof ClaudeAuthError) {
        summary.checked += 1;
        summary.errors += 1;
        log("claude auth failed — aborting the batch, the queue is untouched");
        pingClaudeAuthFailure(error.message);
        console.log(
          JSON.stringify({
            ok: false,
            reason: "claude_auth",
            ...summary,
          }),
        );
        process.exit(1);
      }

      recordTriageOutcome(summary, "failed");
      log(
        `error on ${submission.id ?? "?"}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  console.log(JSON.stringify({ ok: true, ...summary }));
}

if (import.meta.main) {
  main().catch((error) => {
    log(`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    console.log(JSON.stringify(buildTriageFatalSummary()));
    process.exit(1);
  });
}
