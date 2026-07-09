#!/usr/bin/env bun
// newsletter-sweep.ts — the bun orchestrator behind the `--no-agent` weekly
// newsletter cron (`fluncle-newsletter`).
//
// LIVE. Version-controlled source; the repo is canonical and the box is a deploy
// target (fluncle-hermes-operator skill). Invoked by the bash wrapper
// (newsletter-sweep.sh) the cron runner execs Fridays 15:00 Amsterdam — see that
// file's header for the `host-timer` wire-up and ../cron/README.md.
//
// WHY THIS REPLACED THE AGENT LOOP. The newsletter used to be an AGENT cron (a
// model-driven conversation that authored + persisted + offered the Send button). On
// 2026-06-27 a single triggered run flailed for 83 model calls / ~$9.61 of OpenRouter
// credit (it hand-rolled the shell for the CLI call, fumbled quoting, and — once the
// new empty-edition guard started rejecting its hollow drafts — retried into a storm
// with no iteration cap). This sweep moves the newsletter onto the SAME hybrid
// `--no-agent` pattern as note/observe: everything deterministic except ONE bounded
// `claude -p` authoring call. One call, not 83; a hard ceiling on cost; and the
// authoring runs on the Claude SUBSCRIPTION (CLAUDE_CODE_OAUTH_TOKEN), not OpenRouter,
// so it burns zero per-token credit.
//
// THE JOB, in order (mirrors the old doctrine, minus the agent):
//   1. MISS-RECOVERY (deterministic): `fluncle admin newsletter list --json`. If an
//      unsent draft already exists (status `draft`, no number), DO NOT author a new
//      one — re-offer THAT draft (re-emit the operator summary) and exit. Its finds
//      were never delivered; re-offering is correct.
//   2. WINDOW (deterministic): UNTIL = now (ISO). SINCE = the most recent SENT
//      edition's `windowUntil`, or now-7d if none. The window self-heals: only SENT
//      editions anchor it, so a skipped week widens the next window instead of
//      dropping finds.
//   3. FETCH (deterministic): `/api/tracks?since&until&limit=48` (paged via
//      nextCursor) for findings + `/api/mixtapes` filtered to the window. Public reads,
//      no auth. Findings are capped (FIND_CAP, newest-first) to keep the one authoring
//      call inside the cron runner's 120s budget; a cap hit is logged.
//   4. ZERO-FIND RULE (deterministic): no findings AND no mixtapes → author nothing,
//      exit. A missed Friday is quieter than a hollow one.
//   5. AUTHOR (the ONE agentic step): build the prompt (the voice + the verbatim
//      content shape, with the finds/mixtapes interpolated) and run `claude -p`
//      (subscription auth, READ-ONLY tools so it can load `copywriting-fluncle`).
//      Output is the structured `{subject, content}` JSON. We validate it carries at
//      least one finding or a mixtape (the same zero-find rule the server guard
//      enforces) before persisting — a hollow author result is dropped, never drafted.
//   6. PERSIST (deterministic): write `content` to a temp file, then
//      `fluncle admin newsletter draft --content-file … --subject … --window-since …
//      --window-until … --json` (admin tier — the agent token drafts; it can't send).
//   7. OFFER (deterministic): a one-line operator summary + the exact send command. It
//      reaches Discord TWO ways: stdout (captured by the host-timer /status marker +
//      journald) AND a direct best-effort POST to DISCORD_ALERT_WEBHOOK — the sweep
//      SELF-DELIVERS, so it no longer depends on the gateway's `--deliver discord` (retired
//      with the host-timer migration). The operator runs `fluncle admin newsletter send <id>`
//      (operator tier — silence is never consent for a send). The draft persists regardless;
//      next Friday's miss-recovery re-offers an un-sent one.
//
// stdout: the ONE operator-facing line (the summary + the send command); also self-POSTed to
// the ops-alert Discord webhook. All diagnostics + the machine summary → stderr.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BoxCostEvent, emitCost, parseAuthoringSpend } from "./cost-emit";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const SITE = process.env.FLUNCLE_SITE_URL ?? "https://www.fluncle.com";

// The authoring model + optional effort, env-overridable (defaults match note-sweep).
const NEWSLETTER_CLAUDE_MODEL = process.env.NEWSLETTER_CLAUDE_MODEL ?? "claude-sonnet-4-6";
const NEWSLETTER_CLAUDE_EFFORT = process.env.NEWSLETTER_CLAUDE_EFFORT;

// Cap the findings handed to the one authoring call so it stays inside the cron
// runner's 120s kill (a normal week is well under this; a huge self-healed backlog
// window is the only case that hits it — newest-first, the rest roll to next week).
const FIND_CAP = Number(process.env.NEWSLETTER_FIND_CAP ?? "50");
const PAGE_LIMIT = 48; // /api/tracks page size (matches the doctrine)
const PAGE_CAP = 12; // hard ceiling on pages fetched (backstop against a cursor loop)

const DISCORD_ALERT_WEBHOOK = process.env.DISCORD_ALERT_WEBHOOK;

// --dry-run: do everything EXCEPT persist + deliver — print what WOULD be drafted.
// Used to validate a run safely (one claude call, no draft, no Discord).
const DRY_RUN = process.argv.includes("--dry-run");

const log = (message: string) => console.error(`[newsletter-sweep] ${message}`);

// ---------------------------------------------------------------------------
// Types — only the fields we consume.
// ---------------------------------------------------------------------------

type Edition = {
  content?: { galaxies?: Array<{ findings?: unknown[] }>; mixtapeRef?: unknown };
  id?: string;
  number?: number | null;
  status?: string;
  subject?: string;
  windowUntil?: string | null;
};

type Finding = {
  galaxy?: { key?: string; name?: string };
  logId?: string;
  note?: string;
};

type Mixtape = {
  addedAt?: string;
  logId?: string;
  note?: string;
};

// The `claude -p --output-format json` envelope. `usage` / `total_cost_usd` /
// `modelUsage` carry the authoring spend — read after the parse and emitted as one
// `subsidized` anthropic row (COST-01 §5), zero new claude flags.
type ClaudeUsage = { input_tokens?: number; output_tokens?: number };

type ClaudeEnvelope = {
  is_error?: boolean;
  modelUsage?: Record<string, unknown>;
  result?: string;
  subtype?: string;
  total_cost_usd?: number;
  usage?: ClaudeUsage;
};

// The authored payload claude returns: a subject + the content shape the renders read.
type AuthoredContent = {
  galaxies?: Array<{ findings?: Array<{ logId?: string; why?: string }>; galaxy?: string }>;
  intro?: string;
  mixtapeRef?: string;
  tidbits?: Array<{ source?: string; text?: string }>;
};
type Authored = { content?: AuthoredContent; subject?: string };

// The authored edition plus its MEASURED authoring spend (the COST-01 §5 `newsletter`
// row): the total_cost_usd the CLI computed, the model, and the token count. `usd` is
// null only if the envelope carried no `total_cost_usd` (then the row is unpriced,
// never $0). The newsletter is a non-finding, so its ledger row is `global`-scoped.
type AuthoredEdition = Authored & {
  model: string;
  tokens: number;
  usd: number | null;
};

class ClaudeAuthError extends Error {}

// ---------------------------------------------------------------------------
// Shell + fetch helpers
// ---------------------------------------------------------------------------

function run(
  bin: string,
  args: string[],
  input?: string,
): { code: number; stderr: string; stdout: string } {
  const result = spawnSync(bin, args, { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });

  if (result.error) {
    throw new Error(`failed to spawn ${bin}: ${result.error.message}`);
  }

  return { code: result.status ?? 1, stderr: result.stderr ?? "", stdout: result.stdout ?? "" };
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

function curlJson<T>(url: string): T {
  const { code, stderr, stdout } = run("curl", ["-sS", "--max-time", "30", url]);

  if (code !== 0) {
    throw new Error(`curl ${url} exited ${code}: ${stderr.trim()}`);
  }

  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error(`curl ${url} did not return JSON: ${stdout.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// claude-auth detection — narrow, mirrors note-sweep: only an explicit re-auth /
// quota signature counts so a transient model hiccup doesn't false-alarm.
// ---------------------------------------------------------------------------

const AUTH_SIGNATURES = [
  "invalid api key",
  "authentication_error",
  "oauth token",
  "oauth_token",
  "please run /login",
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
// Window + fetch (all deterministic)
// ---------------------------------------------------------------------------

function listEditions(): Edition[] {
  const response = fluncleJson<{ editions?: Edition[] }>(["admin", "newsletter", "list"]);

  return response.editions ?? [];
}

/** The unsent draft to re-offer (miss-recovery), if any. */
function findUnsentDraft(editions: Edition[]): Edition | undefined {
  return editions.find(
    (e) => e.status === "draft" && (e.number === null || e.number === undefined),
  );
}

/** SINCE = the most recent SENT edition's windowUntil, else now-7d. */
function computeSince(editions: Edition[], nowIso: string): string {
  const sent = editions
    .filter((e) => e.status === "sent")
    .sort((a, b) => (b.number ?? 0) - (a.number ?? 0));
  const cutoff = sent[0]?.windowUntil;

  if (cutoff) {
    return cutoff;
  }

  const weekAgo = new Date(Date.parse(nowIso) - 7 * 24 * 60 * 60 * 1000);

  return weekAgo.toISOString();
}

function fetchFindings(since: string, until: string): Finding[] {
  const findings: Finding[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < PAGE_CAP; page += 1) {
    const params = new URLSearchParams({ limit: String(PAGE_LIMIT), since, until });

    if (cursor) {
      params.set("cursor", cursor);
    }

    const response = curlJson<{ nextCursor?: string; tracks?: Finding[] }>(
      `${SITE}/api/tracks?${params.toString()}`,
    );

    findings.push(...(response.tracks ?? []));

    if (!response.nextCursor || findings.length >= FIND_CAP) {
      break;
    }

    cursor = response.nextCursor;
  }

  if (findings.length > FIND_CAP) {
    log(`window has ${findings.length} findings — capping the edition at the newest ${FIND_CAP}`);

    return findings.slice(0, FIND_CAP);
  }

  return findings;
}

function fetchMixtapes(since: string, until: string): Mixtape[] {
  const response = curlJson<{ mixtapes?: Mixtape[] }>(`${SITE}/api/mixtapes`);
  const sinceMs = Date.parse(since);
  const untilMs = Date.parse(until);

  return (response.mixtapes ?? []).filter((m) => {
    if (!m.addedAt) {
      return false;
    }

    const at = Date.parse(m.addedAt);

    return at >= sinceMs && at <= untilMs;
  });
}

// ---------------------------------------------------------------------------
// The authoring prompt — the doctrine (verbatim content shape + voice rails) with
// this window's findings + mixtapes interpolated. The model loads the
// `copywriting-fluncle` skill for the full voice canon; we restate the hard,
// gate-relevant rules so the output is safe.
// ---------------------------------------------------------------------------

function buildAuthoringPrompt(findings: Finding[], mixtapes: Mixtape[]): string {
  const findingLines = findings.map((f) => {
    const note = f.note?.trim() ? f.note.trim() : "(no note — OMIT the why for this finding)";

    return `- logId=${f.logId ?? "?"} | note: ${note}`;
  });

  const mixtapeLines = mixtapes.map(
    (m) => `- logId=${m.logId ?? "?"} | note: ${m.note?.trim() || "(no note)"}`,
  );

  return [
    "You are Fluncle, authoring this week's newsletter edition — the uncle with the good records, writing a letter to the people on his list.",
    "Load and apply the `copywriting-fluncle` skill BEFORE you write a word — it is the full voice canon (Email register) and governs every line. Let it win over anything restated here.",
    "",
    "Output ONE JSON object and NOTHING else — no preamble, no markdown fences, no commentary. Emit EXACTLY this shape (field names verbatim):",
    "{",
    '  "subject": "<a short, dry, sentence-case subject specific to this week — no emoji, no exclamation>",',
    '  "content": {',
    '    "intro": "<1-3 sentences, the week in one breath, first person>",',
    '    "galaxies": [ { "galaxy": "", "findings": [ { "logId": "021.7.1A", "why": "<the why, from this finding\'s note; OMIT this field entirely if the finding has no note>" } ] } ],',
    '    "mixtapeRef": "<the mixtape\'s logId, ONLY if a mixtape is listed below; omit otherwise>",',
    '    "tidbits": [ { "text": "<a recent, concrete artist fact>", "source": "<the source URL>" } ]',
    "  }",
    "}",
    "",
    'SINGLE LIST: do NOT group or label by galaxy (placement is not shown in the newsletter). Emit EXACTLY ONE block with `galaxy` set to "" (an empty string), listing every finding in the order given below (newest-first). Never mention galaxies, the vibe map, or placement anywhere in your prose.',
    "",
    "THE WHY: each finding's note below is Fluncle's own words on why it made the cut — your PRIMARY material for that finding's `why`; quote or lightly adapt it. NEVER invent a reason for a finding with no note — OMIT its `why` entirely. Keep each `why` to one breath. A mixtape's note is its dream note.",
    "",
    "FINDING REFS: each finding is ONLY { logId, why } — never the artist, title, or URL (the render hydrates each logId to its live Artist — Title + links). `mixtapeRef` is present ONLY if a mixtape is listed below; never invent one. `tidbits` are optional and strict — only recent, concrete, source-linked artist facts you are sure of, at most 2-3, never fabricated; omit when you have none. `intro` is always present.",
    "",
    "VOICE (copywriting-fluncle is canon and overrides this): the Email register, a letter from a bruv; first person 'I', never 'we'; no exclamation marks; if a sentence reads written rather than said out loud to a mate, rewrite it. The 'Ahoy cosmonauts,' open and the 'Happy raving,' / 'Fluncle' close are added by the render — do NOT put them in `intro`.",
    "",
    `THIS WEEK'S FINDINGS (${findings.length}, newest-first):`,
    findingLines.length ? findingLines.join("\n") : "(none)",
    "",
    `THIS WEEK'S MIXTAPES (${mixtapes.length}):`,
    mixtapeLines.length ? mixtapeLines.join("\n") : "(none)",
    "",
    "Output ONLY the JSON object.",
  ].join("\n");
}

/** Pull a JSON object out of the model result (tolerate stray fences/preamble). */
function extractJson(result: string): string {
  const fenced = result.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : result;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");

  return start >= 0 && end > start ? body.slice(start, end + 1) : body;
}

// Counts the findings across all galaxy blocks. Typed to only what it reads (each
// block's `findings` length) so it accepts BOTH the authored `AuthoredContent` and the
// stored `Edition.content` (whose `findings` are `unknown[]`) — the miss-recovery path
// counts a persisted draft, the author path counts a fresh one.
function countFindings(content: { galaxies?: Array<{ findings?: unknown[] }> }): number {
  return (content.galaxies ?? []).reduce((sum, block) => sum + (block.findings?.length ?? 0), 0);
}

/**
 * Author the edition via one `claude -p` call (subscription auth, read-only tools).
 * Throws ClaudeAuthError on an auth/quota failure; returns null on any other failure
 * or a result that fails validation (so we never persist junk); returns {subject,
 * content} on success.
 */
function authorEdition(findings: Finding[], mixtapes: Mixtape[]): AuthoredEdition | null {
  const prompt = buildAuthoringPrompt(findings, mixtapes);
  // READ-ONLY tools so the authoring loads + applies the baked `copywriting-fluncle`
  // skill (the canonical voice — never inlined/forked). The skill read pushes a run to
  // ~2m12s, so the cron's script_timeout_seconds is raised to 300 in config.yaml (the
  // newsletter's voice quality is worth the extra minute; same pattern as note/observe).
  const args = [
    "-p",
    "--model",
    NEWSLETTER_CLAUDE_MODEL,
    "--allowedTools",
    "Read,Glob,Grep",
    "--output-format",
    "json",
  ];

  if (NEWSLETTER_CLAUDE_EFFORT) {
    args.push("--effort", NEWSLETTER_CLAUDE_EFFORT);
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
    log(`claude -p did not return JSON envelope: ${stdout.slice(0, 200)}`);

    return null;
  }

  if (envelope.is_error) {
    const detail = `${envelope.subtype ?? ""} ${envelope.result ?? ""}`;

    if (looksLikeAuthFailure(detail)) {
      throw new ClaudeAuthError(detail.trim().slice(-300));
    }

    log(`claude -p returned is_error (${envelope.subtype ?? "?"})`);

    return null;
  }

  const raw = typeof envelope.result === "string" ? envelope.result : "";
  let authored: Authored;

  try {
    authored = JSON.parse(extractJson(raw)) as Authored;
  } catch {
    log(`could not parse the authored JSON: ${raw.slice(0, 200)}`);

    return null;
  }

  const subject = authored.subject?.trim();
  const content = authored.content;

  if (!subject || !content) {
    log("authored result missing subject or content — dropping");

    return null;
  }

  // The same zero-find rule the server guard enforces — never persist a hollow author.
  if (countFindings(content) === 0 && !content.mixtapeRef?.trim()) {
    log("authored content has no findings and no mixtape — dropping (would be hollow)");

    return null;
  }

  // The measured authoring spend (shared parse — the CLI's own total_cost_usd is
  // authoritative, the token count is the informational quantity, the model comes off
  // modelUsage else the one we asked for).
  return { content, subject, ...parseAuthoringSpend(envelope, NEWSLETTER_CLAUDE_MODEL) };
}

// ---------------------------------------------------------------------------
// Persist (deterministic): write content to a temp file, draft via the CLI.
// ---------------------------------------------------------------------------

function persistDraft(authored: Authored, since: string, until: string): string | null {
  const dir = mkdtempSync(join(tmpdir(), "newsletter-sweep-"));
  const contentPath = join(dir, "content.json");

  try {
    writeFileSync(contentPath, JSON.stringify(authored.content), "utf8");

    const { code, stderr, stdout } = run(FLUNCLE_BIN, [
      "admin",
      "newsletter",
      "draft",
      "--content-file",
      contentPath,
      "--subject",
      authored.subject ?? "",
      "--window-since",
      since,
      "--window-until",
      until,
      "--json",
    ]);

    if (code !== 0) {
      log(`draft exited ${code}: ${stderr.trim().slice(-300) || stdout.trim().slice(-300)}`);

      return null;
    }

    try {
      const parsed = JSON.parse(stdout) as { edition?: { id?: string } };

      return parsed.edition?.id ?? null;
    } catch {
      log(`draft did not return JSON: ${stdout.slice(0, 200)}`);

      return null;
    }
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Auth-failure alert (best-effort Discord ping; loud stderr is the floor).
// ---------------------------------------------------------------------------

function pingClaudeAuthFailure(detail: string): void {
  log(`claude auth failure (tail): ${detail}`);

  if (!DISCORD_ALERT_WEBHOOK) {
    return;
  }

  try {
    run("curl", [
      "-sS",
      "-X",
      "POST",
      "-H",
      "Content-Type: application/json",
      "-d",
      JSON.stringify({ content: "Fluncle newsletter-sweep: claude auth failed, re-auth needed." }),
      "--max-time",
      "10",
      DISCORD_ALERT_WEBHOOK,
    ]);
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// The operator-facing line (stdout → Discord). The send is operator-tier, so we
// hand over the exact command rather than an (agent-only) interactive button.
// ---------------------------------------------------------------------------

function offerLine(subject: string, id: string, finds: number, mixes: number): string {
  return [
    `Drafted _${subject}_ — ${finds} track${finds === 1 ? "" : "s"} + ${mixes} mixtape${mixes === 1 ? "" : "s"}, send pending.`,
    `Review + send (operator): fluncle admin newsletter send ${id}`,
  ].join("\n");
}

// Self-deliver the operator offer line to Discord. The host-timer world has no gateway
// `--deliver discord`, so the sweep POSTs the line to the ops-alert webhook itself (the same
// DISCORD_ALERT_WEBHOOK pingClaudeAuthFailure uses, sourced from the 0600 secrets file by the
// .sh). Best-effort: the stdout line is the floor (it still lands in the /status marker +
// journald), so a missing webhook or a failed POST never fails the run.
function deliverOffer(line: string): void {
  if (!DISCORD_ALERT_WEBHOOK) {
    log("no DISCORD_ALERT_WEBHOOK — offer not posted to Discord (stdout marker is the floor)");

    return;
  }

  try {
    run("curl", [
      "-sS",
      "-X",
      "POST",
      "-H",
      "Content-Type: application/json",
      "-d",
      JSON.stringify({ content: line }),
      "--max-time",
      "10",
      DISCORD_ALERT_WEBHOOK,
    ]);
  } catch {
    // best-effort — stdout already carries the offer
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const nowIso = new Date().toISOString();
  const editions = listEditions();

  // 1. MISS-RECOVERY: an unsent draft already stands → re-offer it, author nothing.
  // (--dry-run skips this so a fresh authoring can be validated without disturbing it.)
  const existing = findUnsentDraft(editions);

  if (existing?.id && !DRY_RUN) {
    const finds = countFindings(existing.content ?? {});
    const mixes = existing.content?.mixtapeRef ? 1 : 0;
    log(`unsent draft ${existing.id} already exists — re-offering, not authoring`);
    const offer = offerLine(existing.subject ?? "(untitled)", existing.id, finds, mixes);
    console.log(offer);
    deliverOffer(offer);

    return;
  }

  // 2. WINDOW
  const since = computeSince(editions, nowIso);
  const until = nowIso;
  log(`window ${since} .. ${until}`);

  // 3. FETCH
  const findings = fetchFindings(since, until);
  const mixtapes = fetchMixtapes(since, until);
  log(`fetched ${findings.length} finding(s) + ${mixtapes.length} mixtape(s)`);

  // 4. ZERO-FIND RULE
  if (findings.length === 0 && mixtapes.length === 0) {
    log("no finds this window — skipping (a missed Friday is quieter than a hollow one)");
    console.error(JSON.stringify({ ok: true, reason: "no_finds", skipped: true }));

    return;
  }

  // 5. AUTHOR (the one agentic step)
  let authored: AuthoredEdition | null;

  try {
    authored = authorEdition(findings, mixtapes);
  } catch (error) {
    if (error instanceof ClaudeAuthError) {
      pingClaudeAuthFailure(error.message);
      console.error(JSON.stringify({ ok: false, reason: "claude_auth" }));
      process.exit(1);
    }

    throw error;
  }

  if (!authored?.content || !authored.subject) {
    log("authoring failed — no draft this run (the window re-opens next Friday)");
    console.error(JSON.stringify({ ok: false, reason: "author_failed" }));
    process.exit(1);
  }

  const finds = countFindings(authored.content);
  const mixes = authored.content.mixtapeRef ? 1 : 0;

  if (DRY_RUN) {
    log("DRY RUN — not persisting or delivering. Would draft:");
    console.error(
      JSON.stringify({ content: authored.content, subject: authored.subject }, null, 2),
    );
    console.log(
      `[dry-run] would draft _${authored.subject}_ — ${finds} tracks + ${mixes} mixtapes`,
    );

    return;
  }

  // 6. PERSIST
  const id = persistDraft(authored, since, until);

  if (!id) {
    log("persist failed — no draft this run");
    console.error(JSON.stringify({ ok: false, reason: "persist_failed" }));
    process.exit(1);
  }

  log(`drafted edition ${id} (${finds} finds + ${mixes} mixtapes) — send pending`);

  // 7. OFFER — stdout (→ the host-timer /status marker + journald) AND a direct self-POST to
  // the ops-alert Discord webhook (no gateway --deliver discord under a host timer); the
  // operator runs the send.
  const offer = offerLine(authored.subject, id, finds, mixes);
  console.log(offer);
  deliverOffer(offer);

  // 8. COST — record the one authoring spend, best-effort, only now that the draft is
  // durable. The newsletter is a non-finding, so the row is `global`-scoped (logId +
  // trackId null); occurredAt is the window's `until` (this run). Cannot throw; a hard
  // 2.5s cap keeps it well inside the runner budget. A dropped POST only understates.
  const cost: BoxCostEvent = {
    costBasis: "subsidized",
    logId: null,
    model: authored.model,
    occurredAt: nowIso,
    quantity: authored.tokens,
    source: "measured",
    step: "newsletter",
    trackId: null,
    unitType: "tokens",
    usd: authored.usd,
    vendor: "anthropic",
  };
  await emitCost([cost]);
}

main().catch((error) => {
  log(`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  console.error(JSON.stringify({ ok: false, reason: "sweep_error" }));
  process.exit(1);
});
