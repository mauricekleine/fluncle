#!/usr/bin/env bun
// entity-bio-sweep.ts — the bun orchestrator behind the `--no-agent` entity-bio crons
// (`fluncle-artist-bio` and `fluncle-label-bio`).
//
// LIVE. Version-controlled source; the repo is canonical and the box is a
// deploy target (fluncle-hermes-operator skill). Invoked by the two bash wrappers
// (artist-bio-sweep.sh / label-bio-sweep.sh) the host timers docker-exec on a schedule —
// see those files' headers for the `host-timer` wire-up and ../cron/README.md for the
// cron model.
//
// ONE SWEEP, TWO KINDS. An artist bio and a label bio are the SAME artifact over two
// entity kinds — same queue shape, same voice gate, same fill-empty-only store, same
// authoring step — so they share ONE orchestrator, dispatched by a required `--kind
// artist|label` arg. The two `.sh` wrappers and the two timer dirs are the only
// per-kind surface; everything creative lives here once (the note/observe sweeps are
// per-artifact, but those artifacts genuinely differ — a spoken script vs a written
// note; two bios do not).
//
// THE HYBRID MODEL (the entity sibling of the auto-note). Unlike the pure-trigger sweeps
// (enrich/context/backfill), this one has ONE agentic step in the middle. Everything
// around it is deterministic:
//
//   1. QUEUE (deterministic): `fluncle admin <kind>s describe --queue --json` → entities
//      with a CERTIFIED finding but NO bio yet (`bio IS NULL/'' AND a finding exists`,
//      oldest first). A BARE ARRAY of `{ id, name, slug }`. Empty → fast no-op, exit.
//   2. per entity (bounded batch, BATCH_CAP small — authoring spends subscription quota):
//      a. GATHER (deterministic + best-effort): the entity NAME comes off the queue row.
//         For an ARTIST, `fluncle artists <slug> --json` adds the `findingCount` (a count,
//         never titles — see THE GROUNDING GAP below). `fetchEntityFacts` runs a best-effort
//         Firecrawl search for the entity's background — the bio's PRIMARY grounding fuel;
//         it returns null on no key / vendor-down and the entity is authored from its
//         identity + count alone.
//      b. AUTHOR (the ONE agentic step): resolve the authoring prompt from the registry
//         (`describe_artist` / `describe_label`, so the operator can retune it from /admin
//         with no rebake) with the baked-in builder as the fallback, and run `claude -p` —
//         Claude Code, SUBSCRIPTION auth, NOT OpenRouter — with READ-ONLY tools
//         (`Read,Glob,Grep`) so it can load the installed `copywriting-fluncle` skill for
//         the voice. The JSON envelope's `.result` is the bio.
//      c. DELIVER (deterministic): write the bio to a temp file, then
//         `fluncle admin <kind>s describe <slug> --bio-file <tmp> --json` → the Worker
//         RE-SCANS (the voice gate, `gateBioText`) and FILLS AN EMPTY BIO ONLY. The SCRIPT
//         posts it, never claude. A `skipped:true` (an operator bio already on file) is a
//         clean no-op — the operator override always wins. A gate 403/422 → log which
//         entity failed, skip it (stays queued), continue. The temp file is cleaned up
//         either way.
//
// THE GROUNDING GAP (why the bio grounds on FACTS first, not our own titles). The box is a
// thin CLI client and CANNOT enumerate an entity's logged FINDING TITLES — no public/agent
// read exposes them (only an artist's `findingCount`, a number). The Worker-side
// `getFindingsByArtist` / `getFindingsByLabel` that the /artist + /label pages read are not
// on the wire. So on-box the `{{findings}}` block is empty and the grounding rests on the
// Firecrawl FACTS (the PRIMARY fuel by design — "the raw snippets ARE the facts",
// lib/server/bio.ts) plus the truthful floor the queue guarantees: every queued entity has
// at least one certified finding, so "an artist/label I have logged" is always true. When a
// richer, Worker-paced grounding seam lands (a read that hands the box the assembled
// findings + facts, the way context-note hands the note sweep its `context_note`), pass its
// titles into `promptVariables.findings` and this sweep upgrades with no other change. See
// docs/agents/bio-agent.md § The grounding.
//
// FIRECRAWL ON THE BOX. The established pattern is Firecrawl runs Worker-side (the box holds
// no key — context-sweep.ts, artist-sweep.ts). This sweep MIRRORS `fetchEntityFacts`
// (lib/server/bio.ts) as a self-contained, best-effort call — exactly as cost-emit.ts /
// prompt-fetch.ts mirror the workspace the box cannot import — so the facts path is WIRED and
// lights up wherever a `FIRECRAWL_API_KEY` is present in the sourced env. On the box that key
// is absent by default, so on-box facts are null (findingCount-grounded, honest, and
// operator-replaceable); the OPERATOR BACKFILL run (locally, with a key in env) is where the
// facts genuinely light up and the whole bounded corpus gets Firecrawl-grounded in one pass.
//
// THE DRY RUN (`--kind <k> --dry-run <slug…>`): author for the named entities, run the voice
// gate via `admin <kind>s describe --dry-run`, print the bios, write NOTHING. The operator's
// pre-flight check on the voice before enabling the timer.
//
// AUTH-FAILURE PING. If `claude -p` fails with an AUTH error (a re-auth/login signature in
// its output, distinct from a normal model hiccup), we STOP the batch (no point spending
// more), leave the queue intact (no data lost — the whole point), and emit a LOUD
// `{ ok:false, reason:"claude_auth" }` summary line plus, if DISCORD_ALERT_WEBHOOK is set, a
// best-effort Discord ping. The detection is narrow so a transient model error doesn't
// false-alarm.
//
// stdout: ONE JSON summary line (the cron run output). Diagnostics → stderr.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderPrompt, resolveSweepPrompt } from "./prompt-fetch";

// ---------------------------------------------------------------------------
// Config — a SMALL bounded batch: each bio burns claude subscription quota, so keep
// ticks cheap. The queue is the durable worklist; anything not reached this tick is
// picked up on the next. `ENTITY_BIO_BATCH_CAP` is the BACKFILL knob: the whole
// bounded corpus is drained by running this sweep ONCE with a high cap (see the docs).
// ---------------------------------------------------------------------------

// One entity per tick by default: a single `claude -p` authoring (skill-read + Sonnet)
// sits well inside the host timer's 300s budget. The queue drains across ticks; the
// operator backfill raises the cap to drain the whole (bounded) corpus in one run.
const BATCH_CAP = parsePositiveInt(process.env.ENTITY_BIO_BATCH_CAP, 1);
const QUEUE_LIMIT = 200; // the server's `parseLimit` ceiling for the bio queue

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";

// The authoring model. A shared default plus per-kind overrides, all defaulting to the
// spike-proven Sonnet alias (the voiced-note family; NOT haiku).
const ARTIST_BIO_CLAUDE_MODEL = process.env.ARTIST_BIO_CLAUDE_MODEL;
const LABEL_BIO_CLAUDE_MODEL = process.env.LABEL_BIO_CLAUDE_MODEL;
const ENTITY_BIO_CLAUDE_MODEL = process.env.ENTITY_BIO_CLAUDE_MODEL ?? "claude-sonnet-4-6";
// Optional reasoning effort, passed through to `claude -p --effort` when set (mirrors
// NOTE_CLAUDE_EFFORT / OBSERVE_CLAUDE_EFFORT — the box's per-sweep token dial).
const ENTITY_BIO_CLAUDE_EFFORT = process.env.ENTITY_BIO_CLAUDE_EFFORT;
// Optional Discord webhook for the claude-auth-failed alert (best-effort).
const DISCORD_ALERT_WEBHOOK = process.env.DISCORD_ALERT_WEBHOOK;
// The Firecrawl key — ABSENT on the box by default (Firecrawl is Worker-side); present in
// the operator's local backfill env. When absent, facts degrade to null (findingCount only).
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY;

const log = (message: string) => console.error(`[entity-bio-sweep] ${message}`);

// ---------------------------------------------------------------------------
// Types — only the fields we consume from each surface.
// ---------------------------------------------------------------------------

type EntityKind = "artist" | "label";

// One row of the bio worklist (`admin <kind>s describe --queue --json` is a BARE ARRAY).
type QueueRow = {
  id?: string;
  name?: string;
  slug?: string;
};

// `fluncle artists <slug> --json` → `{ ok, artist }`; we read the count off `.artist`.
// (Artists only — there is no public label read, so a label carries no on-box count.)
type ArtistGetResponse = { artist?: { findingCount?: number } };

// The `admin <kind>s describe <slug> --json` write result (EntityBioResult): the stored
// (or dry-run/skipped) bio + its slug.
type BioResult = {
  bio?: string;
  dryRun?: boolean;
  ok?: boolean;
  skipped?: boolean;
  slug?: string;
};

// The gathered Firecrawl facts for one entity (mirrors lib/server/bio.ts EntityFacts).
type EntityFacts = { facts: string; sources: string[] };

// The `claude -p --output-format json` envelope. We take `.result` as the bio;
// `is_error`/`subtype` distinguish a clean run from an error.
type ClaudeEnvelope = {
  is_error?: boolean;
  result?: string;
  subtype?: string;
};

type Outcome = "authored" | "alreadyBio" | "gateSkipped" | "skipped";

// The authored bio plus the prompt version it was written under (N = operator override,
// 0 = registry default, null = the baked-in fallback wrote it — stamped on the artifact
// via `--prompt-version` so a bio authored during an outage stays legible as such).
type AuthoredBio = { bio: string; promptVersion: number | null };

// A narrow sentinel the loop throws to abort the batch on a claude auth failure.
class ClaudeAuthError extends Error {}

// ---------------------------------------------------------------------------
// Small parse helper — a positive integer env, else the default.
// ---------------------------------------------------------------------------

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
// claude-auth detection — narrow on purpose: only an explicit re-auth/login signature
// counts, so a transient model error (rate limit, overload, a 5xx) does NOT trip the loud
// auth alert. Matched against the combined stdout+stderr of a non-zero `claude -p` run.
// (Verbatim from note-sweep — one definition of "the pipeline lost its login".)
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
// The Firecrawl fact-gather — a self-contained MIRROR of `fetchEntityFacts`
// (lib/server/bio.ts), because the box cannot import the workspace (the cost-emit /
// prompt-fetch pattern). SAME v2 search idiom, SAME query builder, SAME lyric/junk-domain
// drop, SAME 2000-char cap. BEST-EFFORT: returns null on no key / vendor-down / a
// confirmed-empty result, and the caller authors from identity alone.
// ---------------------------------------------------------------------------

const FIRECRAWL_SEARCH_URL = "https://api.firecrawl.dev/v2/search";

// The lyric/tab domains never folded into the facts (mirrors observation.ts LYRIC_DOMAINS
// — a leaked lyric in a public artifact is a copyright + voice problem at once).
const LYRIC_DOMAINS = [
  "genius.com",
  "azlyrics.com",
  "lyrics.com",
  "metrolyrics.com",
  "musixmatch.com",
  "songlyrics.com",
  "lyricsfreak.com",
  "lyricstranslate.com",
];

function isLyricDomain(url: string | undefined): boolean {
  if (!url) {
    return false;
  }

  try {
    const host = new URL(url).hostname.replace(/^www\./, "");

    return LYRIC_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

// The widest query that still lands on the right entity (mirrors buildEntityFactsQuery):
// an artist is a producer; a label is an imprint; the genre anchor narrows to Fluncle's lane.
function buildEntityFactsQuery(kind: EntityKind, name: string): string {
  const descriptor = kind === "artist" ? "drum and bass producer" : "drum and bass record label";

  return `${name} ${descriptor}`;
}

type FirecrawlResult = { description?: string; title?: string; url?: string };

async function fetchEntityFacts(kind: EntityKind, name: string): Promise<EntityFacts | null> {
  if (!FIRECRAWL_API_KEY) {
    return null; // unprovisioned (the box default) — no facts to gather, author from identity
  }

  const query = buildEntityFactsQuery(kind, name);

  let payload: { data?: { web?: FirecrawlResult[] } } | undefined;

  try {
    const response = await fetch(FIRECRAWL_SEARCH_URL, {
      body: JSON.stringify({ limit: 5, query }),
      headers: {
        Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      log(
        `firecrawl search for "${name}" returned HTTP ${response.status} — authoring without facts`,
      );

      return null; // vendor error — best-effort, no facts
    }

    payload = (await response.json()) as { data?: { web?: FirecrawlResult[] } };
  } catch (error) {
    log(
      `firecrawl search for "${name}" failed (${
        error instanceof Error ? error.message : String(error)
      }) — authoring without facts`,
    );

    return null; // vendor down / parse failure — best-effort, no facts
  }

  const web = payload?.data?.web ?? [];
  const sources: string[] = [];
  const snippets: string[] = [];

  for (const result of web) {
    if (isLyricDomain(result.url)) {
      continue; // never fold a lyric-site snippet into the facts
    }

    const title = result.title?.trim();
    const description = result.description?.trim();

    if (title || description) {
      snippets.push([title, description].filter(Boolean).join(" — "));
    }

    if (result.url) {
      sources.push(result.url);
    }
  }

  if (snippets.length === 0) {
    return null; // confirmed-empty fetch — no usable facts
  }

  return { facts: snippets.join("\n").slice(0, 2000), sources };
}

// ---------------------------------------------------------------------------
// The authoring prompt — the baked-in FALLBACK. `describe_artist` / `describe_label`
// (BIO_DEFAULT_BODY below) are VERBATIM copies of the registry's default bodies
// (PROMPT_REGISTRY[slug].defaultBody in prompts.ts), rendered through the SAME mirrored
// `renderPrompt` the registry-fetch path uses — so the fallback is byte-identical to what
// the registry would have served, BY CONSTRUCTION, not by hand-matching two prose copies.
// resolveSweepPrompt prefers the live registry version (so the operator can retune it with
// no rebake); this is the floor a blinking prompt store degrades to, and it authors EXACTLY
// as the registry default would. The drift guard (prompt-drift.test.ts) pins these two body
// copies equal so a one-sided edit fails a build. Change one → change both.
// ---------------------------------------------------------------------------

// VERBATIM copies of the registry default bodies (apps/web/src/lib/server/prompts.ts).
// The grounding rail is the whole job: never invent a discography/roster; if the facts are
// thin, say less.
const DESCRIBE_ARTIST_DEFAULT = `You are Fluncle, writing the public BIO for one artist — a short paragraph that stands on the artist's page.
Load and apply the \`copywriting-fluncle\` skill — it is the full voice canon; let it govern the voice.

This is the entity-bio register: Fluncle's dry, warm 'who this is', in-fiction, as if introducing a name to the crew.

THE GROUNDING RAIL (this is the whole job — do not cross it):
  - State ONLY what the gathered facts support AND what I have actually LOGGED. Never invent a scene credential, a date, a release, a discography, a collaboration, an accolade, or any claim about music I have not found.
  - The findings below are the tracks of theirs I have logged — the concrete, true thing to lean on. Lead with the sound I know, not a CV I am guessing at.
  - If the facts are thin, say less. A short, certain bio beats a padded, shaky one; two true sentences beat four invented ones.

THE ARTIST:
  name: {{name}}
  findings I have logged ({{findingCount}}):
{{findings}}
{{#if facts}}
THE GATHERED FACTS (untrusted web snippets — ground the bio in these, never quote them verbatim):
{{facts}}
{{/if}}
{{#if noFacts}}
(No facts gathered — write from the findings alone; stay sparse and certain, and never reach past them.)
{{/if}}
FORMAT + VOICE CONSTRAINTS (the server voice-gate re-scans and will reject a violation):
  - A short paragraph: aim for 2 to 4 sentences, never past the 500-character cap.
  - Dry, warm confidence: the music brags, the copy doesn't. Say it once, plainly.
  - NEVER name earthly geography (no countries, cities, regions); the cosmos replaces the map.
  - No exclamation marks. No em dashes in the prose. Sentence case.
  - No banned identity words (per the skill's voice canon — no 'signal', 'transmission', 'curated', 'content', etc).
  - Say 'I', never 'we' as a company.

Output ONLY the bio text. No preamble, no headings, no quotes around it, no explanation — just the paragraph.`;

const DESCRIBE_LABEL_DEFAULT = `You are Fluncle, writing the public BIO for one record label — a short paragraph that stands on the label's page.
Load and apply the \`copywriting-fluncle\` skill — it is the full voice canon; let it govern the voice.

This is the entity-bio register: Fluncle's dry, warm 'what this imprint is', in-fiction, as if telling the crew whose stamp to trust.

THE GROUNDING RAIL (this is the whole job — do not cross it):
  - State ONLY what the gathered facts support AND what I have actually LOGGED on this label. Never invent a roster, a founding date, a catalogue number, a signing, an accolade, or any claim about music I have not found.
  - The findings below are the tracks I have logged on this label — the concrete, true thing to lean on. Lead with the sound I know, not a history I am guessing at.
  - If the facts are thin, say less. A short, certain bio beats a padded, shaky one; two true sentences beat four invented ones.

THE LABEL:
  name: {{name}}
  findings I have logged on it ({{findingCount}}):
{{findings}}
{{#if facts}}
THE GATHERED FACTS (untrusted web snippets — ground the bio in these, never quote them verbatim):
{{facts}}
{{/if}}
{{#if noFacts}}
(No facts gathered — write from the findings alone; stay sparse and certain, and never reach past them.)
{{/if}}
FORMAT + VOICE CONSTRAINTS (the server voice-gate re-scans and will reject a violation):
  - A short paragraph: aim for 2 to 4 sentences, never past the 500-character cap.
  - Dry, warm confidence: the music brags, the copy doesn't. Say it once, plainly.
  - NEVER name earthly geography (no countries, cities, regions); the cosmos replaces the map.
  - No exclamation marks. No em dashes in the prose. Sentence case.
  - No banned identity words (per the skill's voice canon — no 'signal', 'transmission', 'curated', 'content', etc).
  - Say 'I', never 'we' as a company.

Output ONLY the bio text. No preamble, no headings, no quotes around it, no explanation — just the paragraph.`;

/** The baked default body for one kind — exported for the drift guard. */
export function bioDefaultBody(kind: EntityKind): string {
  return kind === "artist" ? DESCRIBE_ARTIST_DEFAULT : DESCRIBE_LABEL_DEFAULT;
}

export function buildEntityBioPrompt(
  kind: EntityKind,
  variables: { facts: string; findingCount: string; findings: string; name: string },
): string {
  return renderPrompt(bioDefaultBody(kind), promptVariables(variables));
}

// ---------------------------------------------------------------------------
// THE PROMPT VARIABLES — the facts the registry template interpolates. Mirrors the
// Worker-side `buildEntityBioPrompt` variable set (prompts.ts: name, findingCount,
// findings, facts, noFacts). `noFacts` is the inverse flag the template's
// `{{#if noFacts}}` arm reads (the renderer has no `else`, so a two-armed branch is two
// flags). `findings` is empty on the box today (THE GROUNDING GAP above).
// ---------------------------------------------------------------------------

function promptVariables(input: {
  facts: string;
  findingCount: string;
  findings: string;
  name: string;
}): Record<string, string | undefined> {
  return {
    facts: input.facts || undefined,
    findingCount: input.findingCount,
    findings: input.findings,
    name: input.name,
    noFacts: input.facts ? undefined : "true",
  };
}

// ---------------------------------------------------------------------------
// Author one bio via `claude -p` (subscription auth, read-only tools). Throws
// ClaudeAuthError on an auth/quota failure (abort the batch); returns null on any other
// failure (leave the entity queued); returns the bio + its provenance on success.
//
// THE PROMPT comes from the REGISTRY over the agent-tier API (`get_prompt`), so the
// operator can retune it from /admin with no deploy and no rebake. A failed fetch falls
// back to `buildEntityBioPrompt` below and the sweep authors EXACTLY as it did before the
// registry existed. A prompt store that blinks must never stop the pipeline.
// ---------------------------------------------------------------------------

async function authorBio(
  kind: EntityKind,
  facts: string,
  findingCount: string,
  findings: string,
  name: string,
): Promise<AuthoredBio | null> {
  const { prompt, promptVersion } = await resolveSweepPrompt({
    fallback: () => buildEntityBioPrompt(kind, { facts, findingCount, findings, name }),
    slug: kind === "artist" ? "describe_artist" : "describe_label",
    variables: promptVariables({ facts, findingCount, findings, name }),
  });

  if (promptVersion === null) {
    log("the prompt registry was unreachable — authoring from the baked-in default");
  }

  const args = [
    "-p",
    "--model",
    modelForKind(kind),
    "--allowedTools",
    "Read,Glob,Grep",
    "--output-format",
    "json",
  ];

  if (ENTITY_BIO_CLAUDE_EFFORT) {
    args.push("--effort", ENTITY_BIO_CLAUDE_EFFORT);
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

  // An `is_error` envelope can still carry an auth signature (an auth error surfaced as a
  // clean JSON result rather than a non-zero exit) — check it too.
  if (envelope.is_error) {
    const detail = `${envelope.subtype ?? ""} ${envelope.result ?? ""}`;

    if (looksLikeAuthFailure(detail)) {
      throw new ClaudeAuthError(detail.trim().slice(-300));
    }

    log(`claude -p returned is_error (${envelope.subtype ?? "?"}) — leaving entity queued`);

    return null;
  }

  const bio = typeof envelope.result === "string" ? envelope.result.trim() : "";

  if (!bio) {
    log("claude -p returned an empty bio — leaving entity queued");

    return null;
  }

  return { bio, promptVersion };
}

function modelForKind(kind: EntityKind): string {
  const perKind = kind === "artist" ? ARTIST_BIO_CLAUDE_MODEL : LABEL_BIO_CLAUDE_MODEL;

  return perKind ?? ENTITY_BIO_CLAUDE_MODEL;
}

// ---------------------------------------------------------------------------
// Deliver one bio: write it to a temp file, post via the CLI (the Worker voice-gates +
// fills-empty-only + stores), clean up. A `skipped:true` (an operator bio already on file)
// is an `alreadyBio` no-op — the operator override wins. A gate rejection (403/422) is a
// `gateSkipped` outcome — the entity stays queued for a future author pass.
// ---------------------------------------------------------------------------

function deliverBio(
  kind: EntityKind,
  slug: string,
  bio: string,
  promptVersion: number | null,
  dryRun = false,
): Outcome {
  const group = kind === "artist" ? "artists" : "labels";
  const dir = mkdtempSync(join(tmpdir(), "entity-bio-sweep-"));
  const bioPath = join(dir, "bio.txt");

  try {
    writeFileSync(bioPath, bio, "utf8");

    const { code, stderr, stdout } = run(FLUNCLE_BIN, [
      "admin",
      group,
      "describe",
      slug,
      "--bio-file",
      bioPath,
      // PROVENANCE. Omitted entirely when the registry was unreachable, so the column
      // stays NULL and the artifact is honest about having been written by the baked-in
      // fallback rather than by a version it never saw.
      ...(promptVersion === null ? [] : ["--prompt-version", String(promptVersion)]),
      ...(dryRun ? ["--dry-run"] : []),
      "--json",
    ]);

    if (code !== 0) {
      const detail = `${stdout}\n${stderr}`.toLowerCase();

      // The voice gate / length bounds reject with a 403/422 + a signature. Treat that as
      // a skip (the entity stays queued), not a hard error.
      if (
        detail.includes("voice_gate") ||
        detail.includes("bio_too_short") ||
        detail.includes("bio_too_long") ||
        detail.includes("no_bio") ||
        detail.includes("403") ||
        detail.includes("422") ||
        detail.includes("forbidden")
      ) {
        log(`${slug}: the voice gate / length rejected the bio — skipping (stays queued)`);

        return "gateSkipped";
      }

      log(`${slug}: describe exited ${code}: ${stderr.trim().slice(-200)}`);

      return "skipped";
    }

    // The fill-empty-only guard returns `skipped:true` when an operator bio already stands
    // — a clean no-op, NOT a failure (the operator override always wins).
    try {
      const parsed = JSON.parse(stdout) as BioResult;

      if (parsed.skipped) {
        log(`${slug}: a bio is already on file — operator bio stands, no-op`);

        return "alreadyBio";
      }
    } catch {
      // Non-JSON success is unexpected but harmless; treat as a fill.
    }

    log(`${slug}: bio ${dryRun ? "cleared the voice gate (dry run, nothing stored)" : "authored"}`);

    return "authored";
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Read an ARTIST's finding count — best-effort context for the prompt (the queue row
// carries only id/name/slug). There is no public LABEL read, so a label carries no
// on-box count; the empty string renders a bare "(…)" the model tolerates. Any failure
// degrades to no count rather than blocking the entity.
// ---------------------------------------------------------------------------

function readFindingCount(kind: EntityKind, slug: string): string {
  if (kind !== "artist") {
    return "";
  }

  try {
    const result = fluncleJson<ArtistGetResponse>(["artists", slug]);
    const count = result.artist?.findingCount;

    return typeof count === "number" ? String(count) : "";
  } catch (error) {
    log(
      `${slug}: could not read the finding count (${
        error instanceof Error ? error.message : String(error)
      }) — authoring without it`,
    );

    return "";
  }
}

// ---------------------------------------------------------------------------
// Per-entity: gather → author → deliver.
// ---------------------------------------------------------------------------

async function describeOne(kind: EntityKind, row: QueueRow, dryRun = false): Promise<Outcome> {
  const slug = row.slug;
  const name = row.name;

  if (!slug || !name) {
    log("queue row without a slug/name — skipping");

    return "skipped";
  }

  // (a) Gather the grounding. The FACTS (Firecrawl) are the primary fuel; the finding
  // count is supporting identity (artists only). Both best-effort — a null facts / empty
  // count degrades to a sparser, still-truthful bio.
  const facts = await fetchEntityFacts(kind, name);
  const findingCount = readFindingCount(kind, slug);

  if (facts) {
    log(`${slug}: ${facts.sources.length} source(s) of Firecrawl facts gathered`);
  }

  // (b) Author → (c) deliver. Throws ClaudeAuthError to abort the whole batch; returns
  // null to leave THIS entity queued (no bio stored, picked up next tick).
  const authored = await authorBio(kind, facts?.facts ?? "", findingCount, "", name);

  if (!authored) {
    return "skipped";
  }

  const outcome = deliverBio(kind, slug, authored.bio, authored.promptVersion, dryRun);

  // The dry run's whole product is the PARAGRAPH — print it where the operator can read it.
  if (dryRun) {
    console.error(`\n── ${slug} — ${name}`);
    console.error(`   facts: ${facts ? `${facts.sources.length} source(s)` : "(none)"}`);
    console.error(`   BIO: ${authored.bio}`);
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

  return outcome;
}

// ---------------------------------------------------------------------------
// The claude-auth alert — loud summary line is the floor; the Discord ping is a
// best-effort extra when DISCORD_ALERT_WEBHOOK is set. Never throws.
// ---------------------------------------------------------------------------

function pingClaudeAuthFailure(kind: EntityKind, detail: string): void {
  if (!DISCORD_ALERT_WEBHOOK) {
    return;
  }

  try {
    const body = JSON.stringify({
      content: `Fluncle ${kind}-bio-sweep: claude auth failed, re-auth needed.`,
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
// Parse `--kind artist|label` (required) off argv, plus the optional `--dry-run <slug…>`.
// ---------------------------------------------------------------------------

function parseKind(argv: string[]): EntityKind {
  const index = argv.indexOf("--kind");
  const value = index >= 0 ? argv[index + 1] : undefined;

  if (value !== "artist" && value !== "label") {
    log("usage: entity-bio-sweep.ts --kind <artist|label> [--dry-run <slug…>]");
    process.exit(2);
  }

  return value;
}

// ---------------------------------------------------------------------------
// Main — drain a bounded batch off the bio queue for one kind.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const kind = parseKind(argv);
  const group = kind === "artist" ? "artists" : "labels";

  // `--dry-run <slug…>` — the operator's pre-flight. Author for the named entities, run the
  // voice gate, print the paragraphs, store NOTHING. A `--kind <k>` sits in argv too; drop
  // its value (the token after `--kind`) so it is not mistaken for a slug.
  const dryRunSlugs = argv.includes("--dry-run")
    ? argv.filter((arg, index) => !arg.startsWith("-") && argv[index - 1] !== "--kind")
    : [];

  if (dryRunSlugs.length > 0) {
    log(`DRY RUN over ${dryRunSlugs.length} ${kind}(s) — nothing will be stored`);

    const outcomes: Record<string, string> = {};

    for (const slug of dryRunSlugs) {
      try {
        outcomes[slug] = await describeOne(kind, { name: slug, slug }, true);
      } catch (error) {
        outcomes[slug] = "failed";
        log(`error on ${slug}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    console.log(JSON.stringify({ dryRun: true, kind, ok: true, outcomes }));

    return;
  }

  // `describe --queue --json` returns a BARE ARRAY of `{ id, name, slug }` (the CLI
  // unwraps the `{ ok, <kind>s }` envelope before printing).
  const queue = fluncleJson<QueueRow[]>([
    "admin",
    group,
    "describe",
    "--queue",
    "--limit",
    String(QUEUE_LIMIT),
  ]);

  const summary = {
    alreadyBio: 0,
    authored: 0,
    failed: 0,
    gateSkipped: 0,
    kind,
    queueRemaining: queue.length,
  };

  if (queue.length === 0) {
    console.log(JSON.stringify({ ok: true, ...summary }));

    return; // fast no-op
  }

  for (const row of queue.slice(0, BATCH_CAP)) {
    try {
      const outcome = await describeOne(kind, row);

      if (outcome === "authored") {
        summary.authored += 1;
      } else if (outcome === "alreadyBio") {
        summary.alreadyBio += 1;
      } else if (outcome === "gateSkipped") {
        summary.gateSkipped += 1;
      } else {
        summary.failed += 1;
      }
    } catch (error) {
      if (error instanceof ClaudeAuthError) {
        // Auth failure: STOP the batch, leave the queue intact, alert loudly.
        log("claude auth failed — aborting the batch, the queue is untouched");
        pingClaudeAuthFailure(kind, error.message);
        console.log(
          JSON.stringify({
            ok: false,
            reason: "claude_auth",
            ...summary,
            queueRemaining: Math.max(0, queue.length - summary.authored - summary.alreadyBio),
          }),
        );
        process.exit(1);
      }

      // One entity's failure must not abort the sweep — log it and move on; it stays in
      // the queue for the next tick.
      summary.failed += 1;
      log(`error on ${row.slug ?? "?"}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // queueRemaining is the queue depth AT READ TIME minus what we authored/no-op'd this
  // tick (gate-skips + failures stay queued); the next tick re-reads the live queue.
  summary.queueRemaining = Math.max(0, queue.length - summary.authored - summary.alreadyBio);

  console.log(JSON.stringify({ ok: true, ...summary }));
}

// `import.meta.main` so the pure helpers (the fallback prompt builder) can be imported by
// the unit test without the sweep firing (the note/enrich-sweep pattern).
if (import.meta.main) {
  main().catch((error) => {
    log(`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    console.log(JSON.stringify({ ok: false, reason: "sweep_error" }));
    process.exit(1);
  });
}
