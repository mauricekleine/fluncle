#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BoxCostEvent, emitCost, parseAuthoringSpend } from "./cost-emit";
import { resolveSweepPrompt } from "./prompt-fetch";

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";

process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";
const SITE = process.env.FLUNCLE_SITE_URL ?? "https://www.fluncle.com";

const NEWSLETTER_CLAUDE_MODEL = process.env.NEWSLETTER_CLAUDE_MODEL ?? "claude-sonnet-5";
const NEWSLETTER_CLAUDE_EFFORT = process.env.NEWSLETTER_CLAUDE_EFFORT;

const FIND_CAP = Number(process.env.NEWSLETTER_FIND_CAP ?? "50");
const PAGE_LIMIT = 48;
const PAGE_CAP = 12;

const PRIOR_EDITION_CAP = 4;
const PRIOR_WHY_CAP = 12;

const DISCORD_ALERT_WEBHOOK = process.env.DISCORD_ALERT_WEBHOOK;

const DRY_RUN = process.argv.includes("--dry-run");

const log = (message: string) => console.error(`[newsletter-sweep] ${message}`);

type Edition = {
  content?: { galaxies?: Array<{ findings?: Array<{ why?: unknown }> }>; mixtapeRef?: unknown };
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

type ClaudeUsage = { input_tokens?: number; output_tokens?: number };

type ClaudeReply = {
  is_error?: boolean;
  modelUsage?: Record<string, unknown>;
  result?: string;

  structured_output?: unknown;
  subtype?: string;
  total_cost_usd?: number;
  usage?: ClaudeUsage;
};

type AuthoredContent = {
  galaxies?: Array<{ findings?: Array<{ logId?: string; why?: string }>; galaxy?: string }>;
  intro?: string;
  mixtapeRef?: string;
  tidbits?: Array<{ source?: string; text?: string }>;
};
type Authored = { content?: AuthoredContent; subject?: string };

type AuthoredEdition = Authored & {
  model: string;

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

function listEditions(): Edition[] {
  const response = fluncleJson<{ editions?: Edition[] }>(["admin", "newsletter", "list"]);

  return response.editions ?? [];
}

function findUnsentDraft(editions: Edition[]): Edition | undefined {
  return editions.find(
    (e) => e.status === "draft" && (e.number === null || e.number === undefined),
  );
}

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

export function collectPriorWhys(editions: Edition[]): string[] {
  const sent = editions
    .filter((e) => e.status === "sent")
    .sort((a, b) => (b.number ?? 0) - (a.number ?? 0))
    .slice(0, PRIOR_EDITION_CAP);

  const whys: string[] = [];

  for (const edition of sent) {
    const galaxies = edition.content?.galaxies;

    if (!Array.isArray(galaxies)) {
      continue;
    }

    for (const block of galaxies) {
      const findings = block?.findings;

      if (!Array.isArray(findings)) {
        continue;
      }

      for (const finding of findings) {
        const why = typeof finding?.why === "string" ? finding.why.trim() : "";

        if (why) {
          whys.push(why);
        }
      }
    }
  }

  return whys.slice(0, PRIOR_WHY_CAP);
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
      `${SITE}/api/v1/findings?${params.toString()}`,
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
  const response = curlJson<{ mixtapes?: Mixtape[] }>(`${SITE}/api/v1/mixtapes`);
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

function findingBlock(findings: Finding[]): string {
  const lines = findings.map((f) => {
    const note = f.note?.trim() ? f.note.trim() : "(no note — OMIT the why for this finding)";

    return `- logId=${f.logId ?? "?"} | note: ${note}`;
  });

  return lines.length ? lines.join("\n") : "(none)";
}

function mixtapeBlock(mixtapes: Mixtape[]): string {
  const lines = mixtapes.map(
    (m) => `- logId=${m.logId ?? "?"} | note: ${m.note?.trim() || "(no note)"}`,
  );

  return lines.length ? lines.join("\n") : "(none)";
}

function priorWhysBlock(priorWhys: string[]): string {
  return priorWhys.map((why) => `- ${why}`).join("\n");
}

export function promptVariables(
  findings: Finding[],
  mixtapes: Mixtape[],
  priorWhys: string[] = [],
): Record<string, string | undefined> {
  return {
    findingCount: String(findings.length),
    findings: findingBlock(findings),
    mixtapeCount: String(mixtapes.length),
    mixtapes: mixtapeBlock(mixtapes),
    priorWhys: priorWhysBlock(priorWhys),
  };
}

export function buildAuthoringPrompt(
  findings: Finding[],
  mixtapes: Mixtape[],
  priorWhys: string[] = [],
): string {
  const priorBlock = priorWhys.length
    ? [
        "ALREADY SENT (the whys from recent editions — the list has already read every one; write past them, never echo a move):",
        priorWhysBlock(priorWhys),
        "",
      ]
    : [];

  return [
    "You are Fluncle, authoring this week's newsletter edition — the uncle with the good records, writing a letter to the people on his list.",
    "Load and apply the `copywriting-fluncle` skill BEFORE you write a word — it is the full voice canon (Email register) and governs every line. Let it win over anything restated here.",
    "",
    "Return the edition as one JSON object in this shape (the sweep validates it against the edition schema):",
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
    "THE WHY: each finding's note below is Fluncle's own words on why it made the cut — your PRIMARY material for that finding's `why`; quote or lightly adapt it. NEVER invent a reason for a finding with no note — OMIT its `why` entirely. Keep each `why` to one breath. A mixtape's note is its dream note. Within one edition, when several notes reach for the same move — the body-clock formula (\"knees went up before I'd clocked the drop\" / \"shoulders dropped and stayed down\") or any shared image — vary which part of each note you quote so no two whys rhyme, leaning each why on a different beat of its own note.",
    "",
    ...priorBlock,
    "FINDING REFS: each finding is ONLY { logId, why } — never the artist, title, or URL (the render hydrates each logId to its live Artist — Title + links). `mixtapeRef` is present ONLY if a mixtape is listed below; never invent one. `tidbits` are optional and strict — only recent, concrete, source-linked artist facts you are sure of, at most 2-3, never fabricated; omit when you have none. `intro` is always present.",
    "",
    "VOICE (copywriting-fluncle is canon and overrides this): the Email register, a letter from a bruv; first person 'I', never 'we'; no exclamation marks; if a sentence reads written rather than said out loud to a mate, rewrite it. The 'Ahoy cosmonauts,' open and the 'Happy raving,' / 'Fluncle' close are added by the render — do NOT put them in `intro`.",
    "",
    `THIS WEEK'S FINDINGS (${findings.length}, newest-first):`,
    findingBlock(findings),
    "",
    `THIS WEEK'S MIXTAPES (${mixtapes.length}):`,
    mixtapeBlock(mixtapes),
  ].join("\n");
}

const AUTHORED_SCHEMA = JSON.stringify({
  properties: {
    content: {
      properties: {
        galaxies: {
          items: {
            properties: {
              findings: {
                items: {
                  properties: { logId: { type: "string" }, why: { type: "string" } },
                  required: ["logId"],
                  type: "object",
                },
                type: "array",
              },
              galaxy: { type: "string" },
            },
            type: "object",
          },
          type: "array",
        },
        intro: { type: "string" },
        mixtapeRef: { type: "string" },
        tidbits: {
          items: {
            properties: { source: { type: "string" }, text: { type: "string" } },
            required: ["text", "source"],
            type: "object",
          },
          type: "array",
        },
      },
      required: ["intro", "galaxies"],
      type: "object",
    },
    subject: { type: "string" },
  },
  required: ["subject", "content"],
  type: "object",
});

function extractJson(result: string): string {
  const fenced = result.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : result;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");

  return start >= 0 && end > start ? body.slice(start, end + 1) : body;
}

function countFindings(content: { galaxies?: Array<{ findings?: unknown[] }> }): number {
  return (content.galaxies ?? []).reduce((sum, block) => sum + (block.findings?.length ?? 0), 0);
}

async function authorEdition(
  findings: Finding[],
  mixtapes: Mixtape[],
  priorWhys: string[],
): Promise<AuthoredEdition | null> {
  const { prompt, promptVersion } = await resolveSweepPrompt({
    fallback: () => buildAuthoringPrompt(findings, mixtapes, priorWhys),
    slug: "newsletter_edition",
    variables: promptVariables(findings, mixtapes, priorWhys),
  });

  if (promptVersion === null) {
    log("the prompt registry was unreachable — authoring from the baked-in default");
  }

  const args = [
    "-p",
    "--model",
    NEWSLETTER_CLAUDE_MODEL,
    "--allowedTools",
    "Read,Glob,Grep",
    "--output-format",
    "json",
    "--json-schema",
    AUTHORED_SCHEMA,
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

  let reply: ClaudeReply;

  try {
    reply = JSON.parse(stdout) as ClaudeReply;
  } catch {
    log(`claude -p did not return JSON reply: ${stdout.slice(0, 200)}`);

    return null;
  }

  if (reply.is_error) {
    const detail = `${reply.subtype ?? ""} ${reply.result ?? ""}`;

    if (looksLikeAuthFailure(detail)) {
      throw new ClaudeAuthError(detail.trim().slice(-300));
    }

    log(`claude -p returned is_error (${reply.subtype ?? "?"})`);

    return null;
  }

  const raw = typeof reply.result === "string" ? reply.result : "";
  let authored: Authored;

  if (reply.structured_output && typeof reply.structured_output === "object") {
    authored = reply.structured_output as Authored;
  } else {
    try {
      authored = JSON.parse(extractJson(raw)) as Authored;
    } catch {
      log(`could not parse the authored JSON: ${raw.slice(0, 200)}`);

      return null;
    }
  }

  const subject = authored.subject?.trim();
  const content = authored.content;

  if (!subject || !content) {
    log("authored result missing subject or content — dropping");

    return null;
  }

  if (countFindings(content) === 0 && !content.mixtapeRef?.trim()) {
    log("authored content has no findings and no mixtape — dropping (would be hollow)");

    return null;
  }

  return {
    content,
    promptVersion,
    subject,
    ...parseAuthoringSpend(reply, NEWSLETTER_CLAUDE_MODEL),
  };
}

function persistDraft(
  authored: Authored,
  since: string,
  until: string,
  promptVersion: number | null,
): string | null {
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

      ...(promptVersion === null ? [] : ["--prompt-version", String(promptVersion)]),
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
  } catch {}
}

function offerLine(subject: string, id: string, finds: number, mixes: number): string {
  return [
    `Drafted _${subject}_ — ${finds} track${finds === 1 ? "" : "s"} + ${mixes} mixtape${mixes === 1 ? "" : "s"}, send pending.`,
    `Review + send (operator): fluncle admin newsletter send ${id}`,
  ].join("\n");
}

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
  } catch {}
}

async function main(): Promise<void> {
  const nowIso = new Date().toISOString();
  const editions = listEditions();

  const existing = findUnsentDraft(editions);

  if (existing?.id && !DRY_RUN) {
    const finds = countFindings(existing.content ?? {});
    const mixes = existing.content?.mixtapeRef ? 1 : 0;
    log(`unsent draft ${existing.id} already exists — re-offering, not authoring`);
    const offer = offerLine(existing.subject ?? "(untitled)", existing.id, finds, mixes);
    console.log(offer);
    deliverOffer(offer);

    console.log(JSON.stringify({ edition: existing.id, ok: true, reason: "reoffered" }));

    return;
  }

  const since = computeSince(editions, nowIso);
  const until = nowIso;
  log(`window ${since} .. ${until}`);

  const findings = fetchFindings(since, until);
  const mixtapes = fetchMixtapes(since, until);
  log(`fetched ${findings.length} finding(s) + ${mixtapes.length} mixtape(s)`);

  if (findings.length === 0 && mixtapes.length === 0) {
    log("no finds this window — skipping (a missed Friday is quieter than a hollow one)");
    console.log(JSON.stringify({ ok: true, reason: "no_finds", skipped: true }));

    return;
  }

  const priorWhys = collectPriorWhys(editions);
  let authored: AuthoredEdition | null;

  try {
    authored = await authorEdition(findings, mixtapes, priorWhys);
  } catch (error) {
    if (error instanceof ClaudeAuthError) {
      pingClaudeAuthFailure(error.message);
      console.log(JSON.stringify({ ok: false, reason: "claude_auth" }));
      process.exit(1);
    }

    throw error;
  }

  if (!authored?.content || !authored.subject) {
    log("authoring failed — no draft this run (the window re-opens next Friday)");
    console.log(JSON.stringify({ ok: false, reason: "author_failed" }));
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
    console.log(JSON.stringify({ dryRun: true, finds, mixes, ok: true }));

    return;
  }

  const id = persistDraft(authored, since, until, authored.promptVersion);

  if (!id) {
    log("persist failed — no draft this run");
    console.log(JSON.stringify({ ok: false, reason: "persist_failed" }));
    process.exit(1);
  }

  log(
    `drafted edition ${id} (${finds} finds + ${mixes} mixtapes) — send pending; prompt ${
      authored.promptVersion === null
        ? "the baked-in default (the registry was unreachable)"
        : authored.promptVersion === 0
          ? "the registry default (v0)"
          : `override v${authored.promptVersion}`
    }`,
  );

  const offer = offerLine(authored.subject, id, finds, mixes);
  console.log(offer);
  deliverOffer(offer);

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
  const costWriteFailures = (await emitCost([cost])).failed;

  console.log(JSON.stringify({ costWriteFailures, edition: id, finds, mixes, ok: true }));
}

if (import.meta.main) {
  main().catch((error) => {
    log(`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    console.log(JSON.stringify({ ok: false, reason: "sweep_error" }));
    process.exit(1);
  });
}
