#!/usr/bin/env bun
// entity-bio-sweep.ts — the bun orchestrator behind the `--no-agent` entity-bio crons
// (`fluncle-artist-bio`, `fluncle-label-bio`, and `fluncle-album-bio`).
//
// LIVE. Version-controlled source; the repo is canonical and the box is a
// deploy target (fluncle-hermes-operator skill). Invoked by the three bash wrappers
// (artist-bio-sweep.sh / label-bio-sweep.sh / album-bio-sweep.sh) the host timers docker-exec
// on a schedule — see those files' headers for the `host-timer` wire-up and ../cron/README.md
// for the cron model.
//
// ONE SWEEP, THREE KINDS. An artist bio, a label bio, and an album bio are the SAME artifact
// over three entity kinds — same queue shape, same voice gate, same fill-empty-only store, same
// authoring step — so they share ONE orchestrator, dispatched by a required `--kind
// artist|label|album` arg. The three `.sh` wrappers and the three timer dirs are the only
// per-kind surface; everything creative lives here once (the note/observe sweeps are
// per-artifact, but those artifacts genuinely differ — a spoken script vs a written
// note; the bios do not).
//
// THE HYBRID MODEL (the entity sibling of the auto-note). Unlike the pure-trigger sweeps
// (enrich/context/backfill), this one has ONE agentic step in the middle. Everything
// around it is deterministic:
//
//   1. QUEUE (deterministic): `fluncle admin <kind>s describe --queue --json` → entities
//      with a CERTIFIED finding but NO bio yet (`bio IS NULL/'' AND a finding exists`,
//      oldest first). A BARE ARRAY of `{ id, name, slug }`. Empty → fast no-op, exit.
//   2. per entity (bounded batch, BATCH_CAP small — authoring spends subscription quota):
//      a. DRAFT (deterministic, Worker-paced): `fluncle admin <kind>s draft-bio <slug> --json`
//         triggers the Worker READ (`draft_artist_bio` / `draft_label_bio`). The WORKER runs
//         the Firecrawl gather (with ITS key) + pulls the logged finding TITLES (with ITS DB)
//         and assembles the registered `describe_artist` / `describe_label` prompt, returning a
//         ready-to-author `{ found, name, findingCount, prompt, promptVersion, hasFacts }`. The
//         box holds NEITHER a Firecrawl key NOR a read of finding titles, so this Worker-side
//         gather is the ONLY grounded path — the exact shape context-note hands the note sweep.
//         `found:false` (an unresolved slug) or a failed call → skip (stays queued, retried).
//      b. AUTHOR (the ONE agentic step): run `claude -p` on the Worker-supplied `prompt` —
//         Claude Code, SUBSCRIPTION auth, NOT OpenRouter — with READ-ONLY tools
//         (`Read,Glob,Grep`) so it can load the installed `copywriting-fluncle` skill for
//         the voice. The JSON envelope's `.result` is the bio.
//      c. DELIVER (deterministic): write the bio to a temp file, then
//         `fluncle admin <kind>s describe <slug> --bio-file <tmp> --prompt-version <v> --json`
//         → the Worker RE-SCANS (the voice gate, `gateBioText`) and FILLS AN EMPTY BIO ONLY.
//         The SCRIPT posts it, never claude. A `skipped:true` (an operator bio already on file)
//         is a clean no-op — the operator override always wins. A gate 403/422 → log which
//         entity failed, skip it (stays queued), continue. The temp file is cleaned up either way.
//
// GROUNDING IS WORKER-PACED (the gap is CLOSED). The box is a thin CLI client and holds
// NEITHER a `FIRECRAWL_API_KEY` (by convention — the Worker owns it; context-sweep.ts) NOR a
// read that exposes an entity's finding TITLES (only a `findingCount`). So it cannot ground a
// bio on its own. The `draft_artist_bio` / `draft_label_bio` READ closes both gaps at once:
// the Worker runs Firecrawl with its key AND pulls the finding titles from its DB AND
// assembles the registered prompt, handing the box a ready-to-author prompt + its provenance
// version. This is the exact parity the context-note sweep already has — the box triggers a
// Worker read for its grounding, then authors — and it means the on-box crons produce GROUNDED
// bios, not just the manual backfill. See docs/agents/bio-agent.md § The grounding.
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
import { type BoxCostEvent, emitCost, parseAuthoringSpend } from "./cost-emit";

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
const ALBUM_BIO_CLAUDE_MODEL = process.env.ALBUM_BIO_CLAUDE_MODEL;
const ENTITY_BIO_CLAUDE_MODEL = process.env.ENTITY_BIO_CLAUDE_MODEL ?? "claude-sonnet-4-6";
// Optional reasoning effort, passed through to `claude -p --effort` when set (mirrors
// NOTE_CLAUDE_EFFORT / OBSERVE_CLAUDE_EFFORT — the box's per-sweep token dial).
const ENTITY_BIO_CLAUDE_EFFORT = process.env.ENTITY_BIO_CLAUDE_EFFORT;
// Optional Discord webhook for the claude-auth-failed alert (best-effort).
const DISCORD_ALERT_WEBHOOK = process.env.DISCORD_ALERT_WEBHOOK;

const log = (message: string) => console.error(`[entity-bio-sweep] ${message}`);

// ---------------------------------------------------------------------------
// Types — only the fields we consume from each surface.
// ---------------------------------------------------------------------------

type EntityKind = "artist" | "label" | "album";

// The CLI command GROUP for one kind (the `fluncle admin <group>` noun): plural of the kind.
function groupForKind(kind: EntityKind): "artists" | "labels" | "albums" {
  return kind === "artist" ? "artists" : kind === "label" ? "labels" : "albums";
}

// One row of the bio worklist (`admin <kind>s describe --queue --json` is a BARE ARRAY).
type QueueRow = {
  id?: string;
  name?: string;
  slug?: string;
};

// `fluncle admin <kind>s draft-bio <slug> --json` → the Worker's assembled grounding: a
// ready-to-author prompt (Firecrawl facts + finding titles baked in Worker-side) + its
// provenance version. `found:false` is an unresolved slug (a clean skip, never an error).
type BioDraft = {
  findingCount?: number;
  found?: boolean;
  hasFacts?: boolean;
  name?: string;
  prompt?: string;
  promptVersion?: number;
};

// The `admin <kind>s describe <slug> --json` write result (EntityBioResult): the stored
// (or dry-run/skipped) bio + its slug.
type BioResult = {
  bio?: string;
  dryRun?: boolean;
  ok?: boolean;
  skipped?: boolean;
  slug?: string;
};

// The `claude -p --output-format json` envelope. We take `.result` as the bio;
// `is_error`/`subtype` distinguish a clean run from an error. `usage` /
// `total_cost_usd` / `modelUsage` carry the authoring spend — read after the parse
// (via the shared `parseAuthoringSpend`) and emitted as one `subsidized` anthropic
// row (COST-01 §5), the note/observe pattern, zero new claude flags.
type ClaudeEnvelope = {
  is_error?: boolean;
  modelUsage?: Record<string, unknown>;
  result?: string;
  subtype?: string;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
};

type Outcome = "authored" | "alreadyBio" | "gateSkipped" | "skipped";

// The authored bio plus the prompt version it was written under (N = operator override,
// 0 = registry default, null = the baked-in fallback wrote it — stamped on the artifact
// via `--prompt-version` so a bio authored during an outage stays legible as such), and
// its MEASURED authoring spend (the COST-01 §5 `bio` row): the CLI's own total_cost_usd,
// the model, and the token count. `usd` is null only when the envelope carried no
// `total_cost_usd` (then the row is unpriced, never $0).
type AuthoredBio = {
  bio: string;
  model: string;
  promptVersion: number | null;
  tokens: number;
  usd: number | null;
};

// The per-entity result: the outcome plus the cost row to emit — non-null ONLY when a
// bio was actually authored AND stored this tick (a no-op / gate-skip / failure / dry-run
// records nothing). Mirrors note-sweep's NoteResult.
type DescribeResult = { cost: BoxCostEvent | null; outcome: Outcome };

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
// The Worker-paced grounding draft — trigger `fluncle admin <kind>s draft-bio <slug>` and
// let the WORKER do the gather it alone can: Firecrawl (its key) + the logged finding titles
// (its DB) → the assembled `describe_artist` / `describe_label` prompt + its provenance
// version. The box holds NEITHER the key NOR a titles read, so this is the ONLY grounded
// path (the exact shape context-note hands the note sweep). BEST-EFFORT: null on a failed
// call, and the entity stays queued for the next tick.
// ---------------------------------------------------------------------------

function fetchBioDraft(group: "artists" | "labels" | "albums", slug: string): BioDraft | null {
  try {
    return fluncleJson<BioDraft>(["admin", group, "draft-bio", slug]);
  } catch (error) {
    log(
      `${slug}: draft-bio failed (${
        error instanceof Error ? error.message : String(error)
      }) — skipping (stays queued)`,
    );

    return null;
  }
}

// The gate the sweep authors behind: a draft is authorable only when the Worker RESOLVED the
// entity (`found`), returned a non-empty prompt, AND has real material to ground on —
// Firecrawl facts OR at least one finding title. A null draft (the call failed) or a
// `found:false` (an unresolved slug) is a clean skip — never an author, never a store.
//
// THE GROUNDING RAIL. The Worker ALWAYS renders a non-empty prompt (the template has an
// "author from the finding titles" fallback), so `prompt` alone is not proof of material.
// Before #643 every queued entity carried ≥1 CERTIFIED finding, so the fallback always had
// real titles; now the queue also holds indexable findings-free CATALOGUE entities, and one
// can arrive with `hasFacts:false AND findingCount:0` — a prompt with NOTHING to ground on.
// Authoring that risks a confabulated bio on a public page (VOICE.md's every-claim-is-real
// rule), so we refuse: a groundless entity is a clean skip (stays queued, retried; if
// Firecrawl never yields facts it simply stays bio-less — the honest outcome, the page shows
// its tracklist). A certified entity is unaffected (findingCount ≥ 1 always).
export function isAuthorableDraft(draft: BioDraft | null): draft is BioDraft & { prompt: string } {
  return (
    draft != null &&
    draft.found === true &&
    typeof draft.prompt === "string" &&
    draft.prompt.trim().length > 0 &&
    (draft.hasFacts === true || (draft.findingCount ?? 0) > 0)
  );
}

// ---------------------------------------------------------------------------
// Author one bio via `claude -p` (subscription auth, read-only tools) on the WORKER-SUPPLIED
// prompt. Throws ClaudeAuthError on an auth/quota failure (abort the batch); returns null on
// any other failure (leave the entity queued); returns the bio + its provenance on success.
//
// THE PROMPT is assembled Worker-side (`draft_artist_bio` / `draft_label_bio`) — the Firecrawl
// facts + the finding titles + the registered `describe_*` template, resolved from the DB so
// the operator can retune it from /admin with no rebake. The box no longer holds a baked
// fallback prompt: if the Worker draft cannot be fetched, the entity is skipped (stays queued),
// never authored against a stale copy. `promptVersion` is the Worker's registry version
// (0 = baked default, N = override N), stamped on the stored bio as its provenance.
// ---------------------------------------------------------------------------

async function authorBio(
  kind: EntityKind,
  prompt: string,
  promptVersion: number,
): Promise<AuthoredBio | null> {
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

  // The measured authoring spend (shared parse — the CLI's own total_cost_usd is
  // authoritative, the token count is the informational quantity, the model comes off
  // modelUsage else the one we asked for).
  return { bio, promptVersion, ...parseAuthoringSpend(envelope, modelForKind(kind)) };
}

// ---------------------------------------------------------------------------
// The tick's authoring-spend row for one bio (COST-01 §5) — the `subsidized` anthropic
// `bio` row, SAME shape note-sweep emits for its `note` row (vendor/unitType/source/
// costBasis), just with `step: "bio"` and the ENTITY SLUG as the id scope (a bio is
// about an entity, not a finding — no logId/trackId; the slug rides in `logId` so
// costEventId scopes per entity, the way note scopes per finding).
//
// Non-null ONLY when a bio was actually authored+stored this tick: an `alreadyBio`
// operator no-op, a `gateSkipped` rejection, a `skipped` failure, or ANY dry run records
// nothing — the ledger tracks DELIVERED work (the token spend on a rejected author is
// accepted lossiness, exactly as in note-sweep). One place the decision + shape live so
// the sweep and its test can't drift.
// ---------------------------------------------------------------------------

export function bioCostEvent(input: {
  authored: AuthoredBio | null;
  dryRun: boolean;
  outcome: Outcome;
  slug: string;
}): BoxCostEvent | null {
  const { authored, dryRun, outcome, slug } = input;

  if (outcome !== "authored" || dryRun || !authored) {
    return null;
  }

  return {
    costBasis: "subsidized",
    logId: slug, // the entity slug is the id scope (a bio has no finding coordinate)
    model: authored.model,
    occurredAt: new Date().toISOString(),
    quantity: authored.tokens,
    source: "measured",
    step: "bio",
    trackId: null,
    unitType: "tokens",
    usd: authored.usd,
    vendor: "anthropic",
  };
}

function modelForKind(kind: EntityKind): string {
  const perKind =
    kind === "artist"
      ? ARTIST_BIO_CLAUDE_MODEL
      : kind === "label"
        ? LABEL_BIO_CLAUDE_MODEL
        : ALBUM_BIO_CLAUDE_MODEL;

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
  const group = groupForKind(kind);
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
// Per-entity: draft (Worker-paced grounding) → author → deliver.
// ---------------------------------------------------------------------------

async function describeOne(
  kind: EntityKind,
  row: QueueRow,
  dryRun = false,
): Promise<DescribeResult> {
  const slug = row.slug;

  if (!slug) {
    log("queue row without a slug — skipping");

    return { cost: null, outcome: "skipped" };
  }

  const group = groupForKind(kind);

  // (a) DRAFT the grounding Worker-side: the Worker runs Firecrawl (its key) + pulls the
  // logged finding titles (its DB) and assembles the registered prompt. A failed call or a
  // `found:false` (unresolved slug) is a clean skip — the entity stays queued, retried next
  // tick. The box never authors against a stale baked prompt.
  const draft = fetchBioDraft(group, slug);

  if (!isAuthorableDraft(draft)) {
    if (draft && !draft.found) {
      log(`${slug}: the Worker did not resolve the ${kind} — skipping (stays queued)`);
    }

    return { cost: null, outcome: "skipped" };
  }

  const name = draft.name ?? slug;

  if (draft.hasFacts) {
    log(`${slug}: authoring with Worker-gathered Firecrawl facts`);
  }

  // (b) Author → (c) deliver. Throws ClaudeAuthError to abort the whole batch; returns
  // null to leave THIS entity queued (no bio stored, picked up next tick).
  const authored = await authorBio(kind, draft.prompt, draft.promptVersion ?? 0);

  if (!authored) {
    return { cost: null, outcome: "skipped" };
  }

  const outcome = deliverBio(kind, slug, authored.bio, authored.promptVersion, dryRun);

  // The dry run's whole product is the PARAGRAPH — print it where the operator can read it.
  if (dryRun) {
    console.error(`\n── ${slug} — ${name}`);
    console.error(`   facts: ${draft.hasFacts ? "Worker-gathered" : "(none)"}`);
    console.error(`   BIO: ${authored.bio}`);
    console.error(
      `   prompt: ${
        authored.promptVersion === null
          ? "the baked-in default"
          : authored.promptVersion === 0
            ? "the registry default (v0)"
            : `override v${authored.promptVersion}`
      }`,
    );
    console.error(`   verdict: ${outcome}\n`);
  }

  // Record the authoring spend ONLY when the bio actually landed (`authored`, not a
  // dry-run) — a gate-skip / operator-bio no-op / failure spent tokens too, but the
  // ledger tracks DELIVERED work (bioCostEvent enforces this).
  return { cost: bioCostEvent({ authored, dryRun, outcome, slug }), outcome };
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
// Parse `--kind artist|label|album` (required) off argv, plus the optional `--dry-run <slug…>`.
// ---------------------------------------------------------------------------

function parseKind(argv: string[]): EntityKind {
  const index = argv.indexOf("--kind");
  const value = index >= 0 ? argv[index + 1] : undefined;

  if (value !== "artist" && value !== "label" && value !== "album") {
    log("usage: entity-bio-sweep.ts --kind <artist|label|album> [--dry-run <slug…>]");
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
  const group = groupForKind(kind);

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
        outcomes[slug] = (await describeOne(kind, { name: slug, slug }, true)).outcome;
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

  // The tick's authoring-spend rows, POSTed once at the end (best-effort, after the bios
  // are already durable — a dropped POST only understates the ledger).
  const costs: BoxCostEvent[] = [];

  for (const row of queue.slice(0, BATCH_CAP)) {
    try {
      const { cost, outcome } = await describeOne(kind, row);

      if (cost) {
        costs.push(cost);
      }

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

  // Record the tick's authoring spend, best-effort, AFTER the summary is printed (the
  // cron parses the summary as its last stdout line; emitCost only logs to stderr).
  // Cannot throw; a hard 2.5s cap keeps it well inside the runner budget.
  await emitCost(costs);
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
