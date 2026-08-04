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
//         the voice. The JSON reply's `.result` is the bio.
//      c. DELIVER (deterministic): write the bio to a temp file, then
//         `fluncle admin <kind>s describe <slug> --bio-file <tmp> --prompt-version <v> --json`
//         → the Worker RE-SCANS (the voice gate, `gateBioText`) and FILLS AN EMPTY BIO ONLY.
//         The SCRIPT posts it, never claude. A `skipped:true` (an operator bio already on file)
//         is a clean no-op — the operator override always wins. A gate 403/422 → re-author once
//         more against the reason, up to the attempt budget below. The temp file is cleaned up
//         either way.
//
// THE ATTEMPT BUDGET (see `MAX_BIO_ATTEMPTS`). An entity is authored for AT MOST THREE TIMES,
// ever — the initial draft plus two rewrites — and the third draft LANDS (`--final-attempt`)
// rather than being discarded. Each rejection is fed BACK into the next pass as the thing to fix,
// the logbook sweep's shape, so a rewrite is aimed rather than blind. The count persists across
// ticks in a small on-box ledger, an exhausted entity is skipped without consuming the batch cap,
// and a bio that landed only because it was the final attempt is logged under its own
// `FINAL-ATTEMPT ACCEPTANCE` marker AND raises a `bio-review` row on the /admin attention queue
// (the Worker stamps the entity as it stores the bio). This replaced an unbounded loop:
// a gate rejection used to leave the entity queued with nothing counting, which re-authored three
// entities ~90 times each over two days.
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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

// ---------------------------------------------------------------------------
// THE ATTEMPT BUDGET — the end of the rewrite loop.
//
// The operator's ruling (2026-07-29): "two re-writes max and at most, the third one becomes the
// note." So an entity gets THREE authoring attempts, ever — the initial draft plus two rewrites —
// and the third draft LANDS (`--final-attempt`) instead of being discarded. A fourth authoring
// never happens.
//
// It is a hard constant, not an env knob: the number is a product decision, and a box env that
// could quietly raise it is exactly how a bounded loop becomes an unbounded one again.
//
// WHY THIS EXISTS. A gate rejection used to be a plain skip that left the entity queued, with no
// counter anywhere — so "retry" meant "forever". Three slugs were re-authored ~90 times each over
// two days (~270 model calls on three entities) because their rejections were UNSATISFIABLE: the
// gate scanned the whole bio, and a bio necessarily names its subject, so an artist called "Future
// Signal", a label called "Invaderz Transmissions", and an album called "Jungle Sound: The Bassline
// Strikes Back!" could not be written at all. That root cause is fixed at the source by the gate's
// name exemption (apps/web/src/lib/server/bio.ts `maskEntityName`), so those three now clear on
// attempt 1. This budget is the BACKSTOP that makes "keeps failing" bounded no matter the reason.
//
// THE THREE ATTEMPTS ARE NORMALLY SPENT IN ONE TICK, logbook-sweep style: a rejection is fed BACK
// into the next authoring pass as the thing to fix, so the rewrite is aimed rather than blind
// (re-authoring blind is the other half of why this never converged). The budget nonetheless
// PERSISTS across ticks — each tick is a fresh process, and a tick that dies mid-entity (timeout,
// container swap, a crash) must resume with what is left rather than refund three fresh calls.
// ---------------------------------------------------------------------------

export const MAX_BIO_ATTEMPTS = 3;

// The ledger's home. `$HOME` is the mounted, backed-up data root on the box (the same anchor
// render-conductor's poison ledger and the cron output markers hang off), so the count survives a
// tick, a container swap, and a rebake. `ENTITY_BIO_STATE_DIR` overrides it for tests.
const STATE_DIR =
  process.env.ENTITY_BIO_STATE_DIR ??
  join(process.env.HOME ?? "/opt/data/home", ".entity-bio-sweep");

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
// Headless `claude -p` kills backgrounded Bash ~5s after the final result; a sweep that
// backgrounds work and ends its turn loses it silently. Force it off for the spawned claude.
// Set here (not in the album/artist/label-bio-sweep.sh wrappers) so the shared path covers all three.
process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";

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

export type EntityKind = "artist" | "label" | "album";

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
  // `true` when `--final-attempt` stored a bio the voice scan refused. The Worker has already
  // stamped the entity (`bio_gate_bypassed_at` + the reasons), which raises a `bio-review` row on
  // the /admin attention queue — this field is the sweep's echo of that, not the review itself.
  gateBypassed?: boolean;
  ok?: boolean;
  skipped?: boolean;
  slug?: string;
  // The voice-gate reasons that were ACCEPTED, verbatim. Present only with `gateBypassed`.
  voiceViolations?: string[];
};

// The `claude -p --output-format json` reply. We take `.result` as the bio;
// `is_error`/`subtype` distinguish a clean run from an error. `usage` /
// `total_cost_usd` / `modelUsage` carry the authoring spend — read after the parse
// (via the shared `parseAuthoringSpend`) and emitted as one `subsidized` anthropic
// row (COST-01 §5), the note/observe pattern, zero new claude flags.
type ClaudeReply = {
  is_error?: boolean;
  modelUsage?: Record<string, unknown>;
  result?: string;
  subtype?: string;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
};

// `exhausted` is the ONE terminal outcome: the entity spent all `MAX_BIO_ATTEMPTS` and this sweep
// will never author for it again. Distinct from `gateSkipped` (a rejection with budget left).
export type BioOutcome = "authored" | "alreadyBio" | "exhausted" | "gateSkipped" | "skipped";

export type BioSweepSummary = {
  alreadyBio: number;
  authored: number;
  bypassedGate: number;
  checked: number;
  errors: number;
  exhausted: number;
  failed: number;
  gateSkipped: number;
  kind: EntityKind;
  produced: number;
};

/**
 * Canonical summary shared by all three wrappers. `queue_depth` is deliberately absent:
 * the queue API is capped at `QUEUE_LIMIT`, so its length is not a real backlog count.
 */
export function createBioSweepSummary(kind: EntityKind): BioSweepSummary {
  return {
    alreadyBio: 0,
    authored: 0,
    bypassedGate: 0,
    checked: 0,
    errors: 0,
    exhausted: 0,
    failed: 0,
    gateSkipped: 0,
    kind,
    produced: 0,
  };
}

/** Record one row actually passed to `describeOne`, preserving every domain counter. */
export function recordBioOutcome(
  summary: BioSweepSummary,
  outcome: BioOutcome,
  gateBypassed = false,
  stored = true,
): void {
  summary.checked += 1;

  if (gateBypassed) {
    summary.bypassedGate += 1;
  }

  if (outcome === "authored") {
    summary.authored += 1;

    if (stored) {
      summary.produced += 1;
    }
  } else if (outcome === "alreadyBio") {
    summary.alreadyBio += 1;
  } else if (outcome === "gateSkipped") {
    summary.gateSkipped += 1;
  } else if (outcome === "exhausted") {
    summary.exhausted += 1;
  } else {
    summary.failed += 1;
  }
}

export function buildBioFatalSummary(): Record<string, unknown> {
  return {
    checked: null,
    errors: 1,
    failed: null,
    ok: false,
    produced: null,
    reason: "sweep_error",
  };
}

// The authored bio plus the prompt version it was written under (N = operator override,
// 0 = registry default, null = the baked-in fallback wrote it — stamped on the artifact
// via `--prompt-version` so a bio authored during an outage stays legible as such), and
// its MEASURED authoring spend (the COST-01 §5 `bio` row): the CLI's own total_cost_usd,
// the model, and the token count. `usd` is null only when the reply carried no
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
type DescribeResult = {
  cost: BoxCostEvent | null;
  /** `true` when the bio landed only because it was the FINAL attempt. It feeds the tick's
   *  `bypassedGate` counter; the operator's REVIEW is the `bio-review` attention row the Worker
   *  raised when it stored the bio (apps/web/src/lib/server/bio-review.ts). */
  gateBypassed?: boolean;
  outcome: BioOutcome;
};

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
// The attempt ledger — a flat TSV of `kind:slug<TAB>attempts<TAB>lastAttemptEpoch`, one line per
// entity that has been authored for and not yet finished. The shape is render-conductor's poison
// ledger (`logId<TAB>count<TAB>lastFailEpoch`) because it is the same job: remember, across
// processes, how many times we have burned a budget on one item.
//
// An entry is DROPPED the moment a bio lands (or an operator bio is found), so the file holds only
// in-flight and exhausted entities — a handful of lines, never a corpus. Losing the file (a box
// rebuild) costs at most one fresh budget per stuck entity, and deleting a line is exactly how an
// operator re-arms an entity after the gate or the prompt changes.
// ---------------------------------------------------------------------------

export type AttemptRecord = { attempts: number; lastAttemptEpoch: number };
export type AttemptLedger = Map<string, AttemptRecord>;

/** The ledger key: kind-qualified, because the three kinds share one box home and slugs collide. */
export function attemptKey(kind: EntityKind, slug: string): string {
  return `${kind}:${slug}`;
}

/** Where the ledger lives (`ENTITY_BIO_STATE_DIR`-overridable, for tests and for an operator move). */
export function attemptLedgerPath(): string {
  return join(STATE_DIR, "attempts");
}

/** Parse the TSV. TOTAL: a malformed or truncated line is dropped, never thrown on — a corrupt
 *  ledger must degrade to "no memory", which costs one budget, not a dead cron. */
export function parseAttemptLedger(text: string): AttemptLedger {
  const ledger: AttemptLedger = new Map();

  for (const line of text.split("\n")) {
    const [key, attempts, epoch] = line.split("\t");
    const parsed = Number.parseInt(attempts ?? "", 10);

    if (!key || !Number.isFinite(parsed) || parsed <= 0) {
      continue;
    }

    const parsedEpoch = Number.parseInt(epoch ?? "", 10);

    ledger.set(key, {
      attempts: parsed,
      lastAttemptEpoch: Number.isFinite(parsedEpoch) ? parsedEpoch : 0,
    });
  }

  return ledger;
}

/** Serialise the ledger back to TSV, key-sorted so the file is stable and diffable by eye. */
export function formatAttemptLedger(ledger: AttemptLedger): string {
  return [...ledger.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, record]) => `${key}\t${record.attempts}\t${record.lastAttemptEpoch}`)
    .join("\n");
}

/**
 * What the budget says about one entity RIGHT NOW:
 *   - `spent`     — DRAFTS THE GATE HAS JUDGED AND REFUSED (persisted). Not "model calls made":
 *                   see `describeOne` for why only a gate rejection may spend the budget.
 *   - `exhausted` — the budget is gone; this entity must never be authored again.
 *   - `attempt`   — the 1-based number of the attempt we are about to make.
 *   - `final`     — this is the LAST attempt, so its draft is delivered with `--final-attempt`
 *                   and lands even if the voice scan refuses it.
 */
export function planAttempt(
  ledger: AttemptLedger,
  kind: EntityKind,
  slug: string,
): { attempt: number; exhausted: boolean; final: boolean; spent: number } {
  const spent = ledger.get(attemptKey(kind, slug))?.attempts ?? 0;
  const attempt = spent + 1;

  return {
    attempt,
    exhausted: spent >= MAX_BIO_ATTEMPTS,
    final: attempt >= MAX_BIO_ATTEMPTS,
    spent,
  };
}

/**
 * Burn one attempt. Called ONLY when the gate has judged a draft and REFUSED it — never on a
 * transport or model failure, which is no evidence about the draft at all (`describeOne`).
 */
export function recordAttempt(
  ledger: AttemptLedger,
  kind: EntityKind,
  slug: string,
  nowEpoch: number,
): AttemptLedger {
  const key = attemptKey(kind, slug);

  ledger.set(key, {
    attempts: (ledger.get(key)?.attempts ?? 0) + 1,
    lastAttemptEpoch: nowEpoch,
  });

  return ledger;
}

/** Forget an entity: its bio landed (or an operator's did), so the budget is no longer owed. */
export function clearAttempts(
  ledger: AttemptLedger,
  kind: EntityKind,
  slug: string,
): AttemptLedger {
  ledger.delete(attemptKey(kind, slug));

  return ledger;
}

/**
 * Split the queue into the rows this tick may work and the rows whose budget is gone.
 *
 * THE HEAD-OF-LINE RULE. The queue is oldest-first and BATCH_CAP is 1, so an exhausted entity at
 * the head would otherwise block every entity behind it forever — turning an infinite-retry loop
 * into a permanently-stalled sweep, which is worse. Exhausted rows are filtered out BEFORE the cap
 * is applied (render-conductor's poisoned-head window, same reasoning), so the budget only ever
 * costs the entity that spent it.
 */
export function selectBioWork(
  queue: readonly QueueRow[],
  ledger: AttemptLedger,
  kind: EntityKind,
  cap: number,
): { exhausted: QueueRow[]; work: QueueRow[] } {
  const exhausted: QueueRow[] = [];
  const workable: QueueRow[] = [];

  for (const row of queue) {
    if (row.slug && planAttempt(ledger, kind, row.slug).exhausted) {
      exhausted.push(row);
      continue;
    }

    workable.push(row);
  }

  return { exhausted, work: workable.slice(0, cap) };
}

/** Read the ledger off disk. A missing/unreadable file is an EMPTY ledger, never an error. */
function readAttemptLedger(path: string): AttemptLedger {
  try {
    return parseAttemptLedger(readFileSync(path, "utf8"));
  } catch {
    return new Map();
  }
}

/** Persist the ledger. Best-effort: a failed write costs one budget, it must never kill the tick. */
function writeAttemptLedger(path: string, ledger: AttemptLedger): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${formatAttemptLedger(ledger)}\n`, "utf8");
  } catch (error) {
    log(
      `could not persist the attempt ledger (${error instanceof Error ? error.message : String(error)}) — the budget may be re-spent next tick`,
    );
  }
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

/**
 * Pull the rejection reason out of the Worker's 4xx so the next authoring pass can be TOLD what
 * to fix. `gateBioText` throws `The bio fails the voice gate: <reasons>`; the length bounds throw
 * `The bio is too short/long (<n> < <m> chars)`. The CLI prints the message raw or JSON-escaped
 * depending on the path, so match both. Best-effort — a miss just means a less pointed rewrite.
 *
 * This is the logbook sweep's `readEchoedMove` in bio clothes, and it is half the fix: the old
 * sweep re-authored BLIND, so even a satisfiable rejection had no reason to converge.
 */
export function readBioRejection(output: string): string | undefined {
  const raw =
    /The bio fails the voice gate: ([^\n]+)/.exec(output)?.[1] ??
    /The bio is too (?:short|long) \([^)]*\)/.exec(output)?.[0];

  if (!raw) {
    return undefined;
  }

  return (
    raw
      // A JSON reply escapes the reason's own quotes; put them back before trimming the tail.
      .replace(/\\"/g, '"')
      // …then drop whatever the reply wrapped around it (`…"}` / `…","code":…`).
      .replace(/"\s*[,}].*$/, "")
      .trim()
  );
}

/**
 * The rejection feedback prepended to the Worker's prompt on a rewrite. Named the same way the
 * logbook sweep names its echo block: the model is handed the exact reason its last draft was
 * refused, plus the one instruction that matters — the FACTS do not change, only the wording.
 */
export function buildRewriteBlock(rejection: string | undefined, attempt: number): string {
  if (attempt <= 1) {
    return "";
  }

  const reason = rejection
    ? `it was refused because: ${rejection}`
    : "it was refused by the voice gate (no reason was recoverable)";

  return [
    `YOUR LAST DRAFT WAS REJECTED — ${reason}.`,
    "Write the paragraph again from the same facts, wording it so that reason no longer applies. Do not invent new facts to route around it, and do not pad the length; change the phrasing.",
    // Avoiding a token is the easy way out, and the easy way out is flat: an expository,
    // encyclopedia-voiced paragraph passes the scan and fails the Flat Copy Test. Say what the
    // rewrite must KEEP, not just what it must lose.
    "Keep the dossier register — dry, scene-literate, sentence case, plain facts; do not go generic to dodge the word.",
    "",
    "",
  ].join("\n");
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
//
// A REWRITE (attempt 2 or 3) prepends the rejection feedback (`buildRewriteBlock`) to that same
// Worker prompt — the box owns the retry framing, the Worker still owns the facts and the voice.
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

    // No draft was produced, so the entity's attempt budget is NOT spent — which makes this line
    // the only thing watching a model that keeps falling over. It says "retrying" on purpose, so
    // the /status strain detector scores it (see the strain-vocabulary contract on `describeOne`).
    log(
      `claude -p exited ${code} (not auth), no attempt spent — retrying next tick: ${stderr.trim().slice(-200) || stdout.trim().slice(-200)}`,
    );

    return null;
  }

  let reply: ClaudeReply;

  try {
    reply = JSON.parse(stdout) as ClaudeReply;
  } catch {
    log(
      `claude -p did not return JSON, no attempt spent — retrying next tick: ${stdout.slice(0, 200)}`,
    );

    return null;
  }

  // An `is_error` reply can still carry an auth signature (an auth error surfaced as a
  // clean JSON result rather than a non-zero exit) — check it too.
  if (reply.is_error) {
    const detail = `${reply.subtype ?? ""} ${reply.result ?? ""}`;

    if (looksLikeAuthFailure(detail)) {
      throw new ClaudeAuthError(detail.trim().slice(-300));
    }

    log(
      `claude -p returned is_error (${reply.subtype ?? "?"}), no attempt spent — retrying next tick`,
    );

    return null;
  }

  const bio = typeof reply.result === "string" ? reply.result.trim() : "";

  if (!bio) {
    log("claude -p returned an empty bio, no attempt spent — retrying next tick");

    return null;
  }

  // The measured authoring spend (shared parse — the CLI's own total_cost_usd is
  // authoritative, the token count is the informational quantity, the model comes off
  // modelUsage else the one we asked for).
  return { bio, promptVersion, ...parseAuthoringSpend(reply, modelForKind(kind)) };
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
  outcome: BioOutcome;
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
// `gateSkipped` outcome carrying the REASON, so the next attempt can be aimed at it.
//
// `finalAttempt` is the sweep's third and last pass over this entity: it adds `--final-attempt`,
// which tells the Worker to store the draft even when the voice scan refuses it. The Worker
// answers with `gateBypassed` + the accepted `voiceViolations` AND stamps the entity so the
// acceptance raises a `bio-review` row on the /admin attention queue — that queue row is the
// operator's review; this line is the tick's own record of it, so a bio that landed this way is
// never indistinguishable from one that cleared the gate in EITHER place.
// ---------------------------------------------------------------------------

type Delivery = { gateBypassed: boolean; outcome: BioOutcome; rejection?: string };

function deliverBio(input: {
  bio: string;
  dryRun?: boolean;
  finalAttempt?: boolean;
  kind: EntityKind;
  promptVersion: number | null;
  slug: string;
}): Delivery {
  const { bio, dryRun = false, finalAttempt = false, kind, promptVersion, slug } = input;
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
      ...(finalAttempt ? ["--final-attempt"] : []),
      "--json",
    ]);

    if (code !== 0) {
      const combined = `${stdout}\n${stderr}`;
      const detail = combined.toLowerCase();

      // The voice gate / length bounds reject with a 403/422 + a signature. Treat that as
      // a skip (the entity keeps whatever budget is left), not a hard error.
      if (
        detail.includes("voice_gate") ||
        detail.includes("bio_too_short") ||
        detail.includes("bio_too_long") ||
        detail.includes("no_bio") ||
        detail.includes("403") ||
        detail.includes("422") ||
        detail.includes("forbidden")
      ) {
        const rejection = readBioRejection(combined);

        // Deliberately OUTSIDE the strain vocabulary: this draft is about to be rewritten, and an
        // entity that rewrites and then lands is a healthy tick, not a degraded cron. The
        // TERMINAL outcomes (exhausted, transport failure) carry the distress wording instead.
        // See the strain-vocabulary contract above `describeOne`.
        log(
          `${slug}: draft did not clear the voice gate / length bounds${rejection ? ` (${rejection})` : ""}`,
        );

        return { gateBypassed: false, outcome: "gateSkipped", rejection };
      }

      log(`${slug}: describe exited ${code}: ${stderr.trim().slice(-200)}`);

      return { gateBypassed: false, outcome: "skipped" };
    }

    // The fill-empty-only guard returns `skipped:true` when an operator bio already stands
    // — a clean no-op, NOT a failure (the operator override always wins).
    let parsed: BioResult | undefined;

    try {
      parsed = JSON.parse(stdout) as BioResult;
    } catch {
      // Non-JSON success is unexpected but harmless; treat as a fill.
    }

    if (parsed?.skipped) {
      log(`${slug}: a bio is already on file — operator bio stands, no-op`);

      return { gateBypassed: false, outcome: "alreadyBio" };
    }

    // THE FINAL-ATTEMPT ACCEPTANCE, said out loud. This is the line an operator greps for to
    // find every bio that was stored despite the voice gate refusing it.
    if (parsed?.gateBypassed) {
      log(
        `${slug}: FINAL-ATTEMPT ACCEPTANCE — stored a bio the voice gate refused${
          dryRun ? " (dry run, nothing stored)" : ""
        }: ${(parsed.voiceViolations ?? []).join("; ") || "(no reasons reported)"} — REVIEW THIS ${kind.toUpperCase()}`,
      );

      return { gateBypassed: true, outcome: "authored" };
    }

    log(`${slug}: bio ${dryRun ? "cleared the voice gate (dry run, nothing stored)" : "authored"}`);

    return { gateBypassed: false, outcome: "authored" };
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Per-entity: draft (Worker-paced grounding) → author → deliver, up to the entity's REMAINING
// attempt budget, feeding each rejection back into the next pass (logbook-sweep's shape).
//
// THE ATTEMPT LIFECYCLE, in one place:
//   1. The budget is `MAX_BIO_ATTEMPTS` (3) per entity FOR ALL TIME, persisted in the ledger.
//   2. ONLY A GATE REJECTION SPENDS IT (see below).
//   3. A gate rejection with budget left → re-author, TOLD the reason (`buildRewriteBlock`).
//   4. The LAST attempt delivers with `--final-attempt`: its draft lands even if the voice scan
//      refuses it, and that acceptance is logged under its own marker.
//   5. A landed bio (or an operator bio) CLEARS the entity's ledger entry.
//   6. An entity that has spent all three is `exhausted` — never authored again, and filtered out
//      of the batch before the cap so it cannot block the queue behind it.
//
// WHAT MAY SPEND AN ATTEMPT — the distinction the whole budget rests on:
//
//   A GATE REJECTION is deterministic evidence that THIS DRAFT was bad. The Worker read the
//   paragraph and refused it. Spend the budget: three such refusals mean the model is not going
//   to get there, and the third draft is accepted rather than discarded.
//
//   A TRANSPORT OR MODEL FAILURE is no evidence about the draft at all — there IS no draft. A
//   `claude -p` that exits non-zero, returns `is_error`, or returns nothing says something about
//   the infrastructure, never about the entity. Spending the budget on it would let three flaky
//   model calls write an entity off permanently, and if the THIRD call is the flaky one there is
//   no draft to accept either — the entity ends up with no bio and no retry, forever, because the
//   API had a bad afternoon. So these DO NOT burn: the entity keeps its whole budget and is
//   retried next tick.
//
//   The loop that guards against is covered from the other side: every one of those failures logs
//   a line the `/status` sweep-strain detector scores (fluncle-healthcheck.ts `STRAIN_PHRASES`),
//   so a sweep grinding on a broken model call surfaces as `degraded` instead of silently
//   spinning. Losing the budget as a bound is the right trade — the budget exists to stop a
//   REWRITE loop, and a rewrite loop needs a rejection to continue.
//
// A DRY RUN spends no budget and touches no ledger: it is the operator's pre-flight, it stores
// nothing, and it must not consume an entity's real attempts.
// ---------------------------------------------------------------------------

/**
 * THE STRAIN VOCABULARY (the /status sweep-strain detector, fluncle-healthcheck.ts).
 *
 * Since #994 this sweep's stderr is captured into its cron marker and every line is scored: a
 * line containing one of `STRAIN_PHRASES` is a point, and the healthcheck applies its
 * cadence-relative rate plus repeated-tick gates before reporting the cron `degraded`. That makes
 * the WORDING of these logs load-bearing, so the rule this file follows is written down once,
 * here, and pinned by tests:
 *
 *   DISTRESS (must score) — the work did not get done and nothing here will fix it:
 *     · a transport/model failure ("retrying next tick" — and note it no longer costs the entity
 *       any budget, so the detector is the ONLY thing watching it)
 *     · an entity EXHAUSTED ("giving up") — a permanent write-off, said once, on the tick it
 *       happens
 *     · a ledger write that failed ("could not persist")
 *
 *   NOT DISTRESS (must score zero) — a healthy sweep doing its job:
 *     · a rejected draft that is ABOUT TO BE REWRITTEN. It is a step inside one entity's work,
 *       not an outcome; scoring it would push a sweep that rewrites and then SUCCEEDS toward
 *       `degraded`, which is the false positive that would make the detector worth ignoring.
 *     · the FINAL-ATTEMPT ACCEPTANCE. A bio landing on the third attempt is a DESIGNED outcome,
 *       and it has its own review channel with a real reader: the `bio-review` row on the /admin
 *       attention queue (plus the marker, `bypassedGate`, and the API fields).
 *     · the per-tick "skipping N exhausted" recap. The exhaustion was already reported once when
 *       it happened; scoring the recap would accrue a point every tick forever for a known,
 *       steady state, and a `degraded` that can never clear is noise.
 */
function logExhausted(kind: EntityKind, slug: string): void {
  log(
    `${slug}: EXHAUSTED — ${MAX_BIO_ATTEMPTS} drafts were rejected, giving up on this ${kind} (delete its line from ${attemptLedgerPath()} to re-arm)`,
  );
}

// Exported so the unit test can drive the REAL loop against stub `fluncle`/`claude` binaries
// (FLUNCLE_BIN / CLAUDE_BIN) rather than re-implementing the budget arithmetic beside it — the
// "authored at most three times, ever" guarantee is only worth as much as the code that runs it.
export async function describeOne(
  kind: EntityKind,
  row: QueueRow,
  options: { dryRun?: boolean; ledger?: AttemptLedger; ledgerPath?: string } = {},
): Promise<DescribeResult> {
  const { dryRun = false, ledger, ledgerPath } = options;
  const slug = row.slug;

  if (!slug) {
    log("queue row without a slug — skipping");

    return { cost: null, outcome: "skipped" };
  }

  // Belt-and-braces: `selectBioWork` already keeps exhausted rows out of the batch, so reaching
  // here means the budget ran out mid-tick. Either way, no draft is fetched and no model is
  // called — an exhausted entity costs nothing at all.
  if (ledger && planAttempt(ledger, kind, slug).exhausted) {
    logExhausted(kind, slug);

    return { cost: null, outcome: "exhausted" };
  }

  const group = groupForKind(kind);

  // (a) DRAFT the grounding Worker-side: the Worker runs Firecrawl (its key) + pulls the
  // logged finding titles (its DB) and assembles the registered prompt. A failed call or a
  // `found:false` (unresolved slug) is a clean skip — the entity stays queued, retried next
  // tick. The box never authors against a stale baked prompt. Fetched ONCE: the facts do not
  // change between rewrites, only the wording does.
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

  let authored: AuthoredBio | null = null;
  let delivery: Delivery = { gateBypassed: false, outcome: "skipped" };
  let rejection: string | undefined;

  // (b) Author → (c) deliver, until the bio lands or the budget is gone.
  for (;;) {
    const plan = ledger
      ? planAttempt(ledger, kind, slug)
      : // A dry run has no ledger: it makes exactly one pass and never claims to be final.
        { attempt: 1, exhausted: false, final: false, spent: 0 };

    if (plan.exhausted) {
      logExhausted(kind, slug);

      return { cost: null, outcome: "exhausted" };
    }

    if (plan.attempt > 1) {
      log(
        `${slug}: re-authoring (attempt ${plan.attempt} of ${MAX_BIO_ATTEMPTS})${
          plan.final ? " — the LAST one; its draft lands even if the gate refuses it" : ""
        }`,
      );
    }

    // Throws ClaudeAuthError to abort the whole batch; returns null on a transport/model failure
    // — which leaves THIS entity queued with its budget UNSPENT (there is no draft to judge), and
    // logs a line the strain detector scores so the failure is not silent.
    authored = await authorBio(
      kind,
      `${buildRewriteBlock(rejection, plan.attempt)}${draft.prompt}`,
      draft.promptVersion ?? 0,
    );

    if (!authored) {
      return { cost: null, outcome: "skipped" };
    }

    delivery = deliverBio({
      bio: authored.bio,
      dryRun,
      finalAttempt: plan.final,
      kind,
      promptVersion: authored.promptVersion,
      slug,
    });

    // Anything but a gate rejection is terminal for this entity this tick.
    if (delivery.outcome !== "gateSkipped" || !ledger) {
      break;
    }

    // THE ONE PLACE THE BUDGET IS SPENT: the gate read this draft and refused it. Persisted
    // immediately, so the count is honest even if this process dies before the next pass.
    rejection = delivery.rejection;
    recordAttempt(ledger, kind, slug, Math.floor(Date.now() / 1000));

    if (ledgerPath) {
      writeAttemptLedger(ledgerPath, ledger);
    }

    if (planAttempt(ledger, kind, slug).exhausted) {
      // Only reachable when the FINAL attempt's draft was refused on a STRUCTURAL ground the
      // acceptance still enforces (empty / too short / too long) — the voice scan cannot refuse
      // it at that point. Terminal, and said in the detector's vocabulary.
      log(
        `${slug}: EXHAUSTED — the last of ${MAX_BIO_ATTEMPTS} drafts was still rejected${
          rejection ? ` (${rejection})` : ""
        }; giving up on this ${kind}, it stays bio-less`,
      );

      return { cost: null, outcome: "exhausted" };
    }
  }

  const outcome = delivery.outcome;

  // The entity is done with this sweep: its bio landed, or an operator's already had. Drop its
  // budget so a future re-queue (a cleared bio, a re-minted entity) starts fresh.
  if (ledger && ledgerPath && (outcome === "authored" || outcome === "alreadyBio")) {
    clearAttempts(ledger, kind, slug);
    writeAttemptLedger(ledgerPath, ledger);
  }

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
  return {
    cost: bioCostEvent({ authored, dryRun, outcome, slug }),
    gateBypassed: delivery.gateBypassed,
    outcome,
  };
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

/**
 * The once-per-tick recap of the entities this sweep is no longer working. Deliberately OUTSIDE
 * the strain vocabulary (see the contract above `describeOne`): each of these was already
 * reported as distress on the tick it exhausted, and this line repeats every tick for as long as
 * they sit in the queue — scoring it would accrue a point an hour forever for a known, steady
 * state, and a `degraded` that can never clear is noise. Exported so its wording is scored by a
 * test rather than trusted.
 */
export function exhaustedRecapLine(kind: EntityKind, exhausted: readonly QueueRow[]): string {
  const slugs = exhausted
    .map((row) => row.slug)
    .filter(Boolean)
    .slice(0, 10)
    .join(", ");

  return `not working ${exhausted.length} exhausted ${kind}(s) — ${MAX_BIO_ATTEMPTS} drafts spent each (${slugs})`;
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
    const summary = createBioSweepSummary(kind);

    for (const slug of dryRunSlugs) {
      try {
        // No ledger: a pre-flight must not spend an entity's real attempt budget.
        const { gateBypassed, outcome } = await describeOne(
          kind,
          { name: slug, slug },
          { dryRun: true },
        );
        outcomes[slug] = outcome;
        // The preview authored a paragraph but deliberately stored nothing.
        recordBioOutcome(summary, outcome, gateBypassed, false);
      } catch (error) {
        outcomes[slug] = "failed";
        recordBioOutcome(summary, "skipped");

        if (error instanceof ClaudeAuthError) {
          summary.errors += 1;
        }

        log(`error on ${slug}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    console.log(JSON.stringify({ gateState: "dry-run", ok: true, outcomes, ...summary }));

    return;
  }

  // `describe --queue --json` returns a BARE ARRAY of `{ id, name, slug }` (the CLI
  // unwraps the `{ ok, <kind>s }` reply before printing).
  const queue = fluncleJson<QueueRow[]>([
    "admin",
    group,
    "describe",
    "--queue",
    "--limit",
    String(QUEUE_LIMIT),
  ]);

  const summary = createBioSweepSummary(kind);

  if (queue.length === 0) {
    console.log(JSON.stringify({ ok: true, ...summary }));

    return; // fast no-op
  }

  // The attempt budgets, loaded once per tick and written through as they are spent.
  const ledgerPath = attemptLedgerPath();
  const ledger = readAttemptLedger(ledgerPath);

  // Exhausted rows are dropped BEFORE the cap: an exhausted head must never block the entities
  // behind it (that would trade an infinite loop for a permanent stall).
  const { exhausted, work } = selectBioWork(queue, ledger, kind, BATCH_CAP);

  summary.exhausted = exhausted.length;

  if (exhausted.length > 0) {
    log(exhaustedRecapLine(kind, exhausted));
  }

  // The tick's authoring-spend rows, POSTed once at the end (best-effort, after the bios
  // are already durable — a dropped POST only understates the ledger).
  const costs: BoxCostEvent[] = [];

  for (const row of work) {
    try {
      const { cost, gateBypassed, outcome } = await describeOne(kind, row, { ledger, ledgerPath });

      if (cost) {
        costs.push(cost);
      }

      recordBioOutcome(summary, outcome, gateBypassed);
    } catch (error) {
      if (error instanceof ClaudeAuthError) {
        // Auth failure: STOP the batch, leave the queue intact, alert loudly.
        summary.checked += 1;
        summary.errors += 1;
        log("claude auth failed — aborting the batch, the queue is untouched");
        pingClaudeAuthFailure(kind, error.message);
        console.log(
          JSON.stringify({
            ok: false,
            reason: "claude_auth",
            ...summary,
          }),
        );
        process.exit(1);
      }

      // One entity's failure must not abort the sweep — log it and move on; it stays in
      // the queue for the next tick.
      recordBioOutcome(summary, "skipped");
      log(`error on ${row.slug ?? "?"}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Record the tick's authoring spend best-effort. It cannot throw or outlive its
  // 15s budget; rejected rows remain visible in the final status reading.
  const costWriteFailures = (await emitCost(costs)).failed;
  console.log(JSON.stringify({ costWriteFailures, ok: true, ...summary }));
}

// `import.meta.main` so the pure helpers (the fallback prompt builder) can be imported by
// the unit test without the sweep firing (the note/enrich-sweep pattern).
if (import.meta.main) {
  main().catch((error) => {
    log(`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    console.log(JSON.stringify(buildBioFatalSummary()));
    process.exit(1);
  });
}
