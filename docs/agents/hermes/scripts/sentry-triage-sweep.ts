#!/usr/bin/env bun
// sentry-triage-sweep.ts — the DETERMINISTIC half of the nightly Sentry-triage cron.
//
// The cron is a HYBRID, exactly like note/observe/audit: the mechanics are deterministic and
// exactly ONE `claude -p` call owns the code judgment. This module is the deterministic half —
// it owns EVERY Sentry API call (fetch + resolve + comment) plus the GitHub reads it needs, so
// the Sentry token NEVER enters the claude process (claude only ever gets the GitHub PAT the
// audit sweep already uses, to open its fix PRs). The driver `sentry-triage-sweep.sh` calls the
// subcommands below around the one claude call.
//
// SUBCOMMANDS
//   fetch <ledgerPath> <outFile>   Pull unresolved issues from every project, EXCLUDE the ones
//                                  already covered (an open triage PR, or a row already in the
//                                  ledger), enrich the survivors with the latest event's top
//                                  in-app frames, and write a compact JSON worklist to <outFile>.
//                                  Prints a one-line JSON summary. Never throws on a bad/absent
//                                  token — it records the per-project error and writes an empty
//                                  worklist, so the driver degrades to a clean SKIP.
//   reconcile                      For every MERGED triage PR, resolve the Sentry issue(s) its
//                                  body references with `Sentry-Issue:` (idempotent — a re-resolve
//                                  of an already-resolved issue is a no-op). This is the ONLY path
//                                  that resolves an issue in Sentry: we resolve a fix that actually
//                                  landed on `main`, never a blanket sweep. A FILED issue (a
//                                  `Sentry-Filed:` ref on the ledger PR) is deliberately left alone.
//   comment <dateTag>              For each OPEN fix PR opened by tonight's run (head
//                                  `sentry-triage/<dateTag>-…`), post one note on the Sentry issue
//                                  linking the PR. Best-effort + idempotent (skips if a prior note
//                                  already links that PR). Only runs when the token grants writes.
//
// The PR-body contract (the single source of truth, so this stays stateless — GitHub IS the store):
//   • a FIX PR body carries one `Sentry-Issue: <numericId>` line per issue it fixes → resolved on merge.
//   • the LEDGER PR body carries one `Sentry-Filed: <numericId>` line per filed issue → NEVER resolved.
//   • a filed ledger ROW also carries an invisible `<!-- sentry_id:<numericId> -->` marker, so once
//     the ledger PR merges to `main` the fetch dedupe reads the id straight from `docs/sentry-backlog.md`.
//
// Self-contained box script (it cannot import the workspace) — pure helpers are unit-tested in
// sentry-triage-sweep.test.ts (`bun test docs/agents/hermes/scripts/sentry-triage-sweep.test.ts`).
// The network + gh functions take an injectable dep so the tests never touch the real API.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

// ── config (env-overridable, public-safe defaults) ──────────────────────────────────────────
// EU region ⇒ the API base is de.sentry.io (docs/error-tracking.md). Org + projects match the
// two Sentry projects the web app reports to. None of these are secrets.
const API_BASE = (process.env.SENTRY_TRIAGE_API_BASE ?? "https://de.sentry.io").replace(/\/$/, "");
const ORG = process.env.SENTRY_TRIAGE_ORG ?? process.env.SENTRY_ORG ?? "fluncle";
const PROJECTS = (process.env.SENTRY_TRIAGE_PROJECTS ?? "fluncle-web,fluncle-worker")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);
const REPO = process.env.SENTRY_TRIAGE_REPO ?? "mauricekleine/fluncle";
const BRANCH_PREFIX = "sentry-triage/";
// The two PR/ledger markers that make the loop stateless (see the header contract).
export const FIX_MARKER = "Sentry-Issue";
export const FILE_MARKER = "Sentry-Filed";
// Bound the nightly worklist so one bad night can't hand claude 200 issues (cost + review load).
// Most-frequent-first, so the cap keeps the highest-impact issues. Overridable for a pilot.
const MAX_TRIAGE = Number(process.env.SENTRY_TRIAGE_MAX ?? "12");
const MAX_PAGES = 5; // paginate defensively, never unbounded.

const log = (m: string) => console.error(`[sentry-triage] ${m}`);

// ── types ────────────────────────────────────────────────────────────────────────────────────
type StackFrame = { file: string; function: string; line: number | null };
export type CompactIssue = {
  count: number;
  culprit: string;
  firstSeen: string;
  frames?: StackFrame[];
  id: string;
  lastSeen: string;
  level: string;
  permalink: string;
  project: string;
  shortId: string;
  title: string;
  type: string;
  value: string;
};

type FetchDeps = { fetchFn: typeof fetch };
const defaultFetchDeps = (): FetchDeps => ({ fetchFn: fetch });

// ── pure helpers (unit-tested) ─────────────────────────────────────────────────────────────

/**
 * Read every `<marker>: <id>` reference out of a block of text (a PR body, or a `git`/`gh`
 * payload). Case-insensitive on the marker, tolerant of leading whitespace, deduped, order-preserving.
 */
export function parseMarkerIds(text: string, marker: string): string[] {
  const re = new RegExp(`^\\s*${marker}:\\s*#?([\\w-]+)`, "gim");
  const out: string[] = [];
  for (const m of text.matchAll(re)) {
    const id = m[1];
    if (id && !out.includes(id)) {
      out.push(id);
    }
  }
  return out;
}

/** Read the invisible `<!-- sentry_id:<id> -->` markers a filed ledger row carries. */
export function parseLedgerIds(ledger: string): string[] {
  const re = /<!--\s*sentry_id:\s*([\w-]+)\s*-->/gi;
  const out: string[] = [];
  for (const m of ledger.matchAll(re)) {
    const id = m[1];
    if (id && !out.includes(id)) {
      out.push(id);
    }
  }
  return out;
}

/** Normalize one raw Sentry issue (the list endpoint's shape) into the compact worklist record. */
export function compactIssue(raw: Record<string, unknown>, project: string): CompactIssue {
  const meta = (raw.metadata ?? {}) as Record<string, unknown>;
  const asStr = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
  return {
    count: Number(raw.count ?? 0),
    culprit: asStr(raw.culprit),
    firstSeen: asStr(raw.firstSeen),
    id: asStr(raw.id),
    lastSeen: asStr(raw.lastSeen),
    level: asStr(raw.level, "error"),
    permalink: asStr(raw.permalink),
    project,
    shortId: asStr(raw.shortId),
    title: asStr(raw.title),
    type: asStr(meta.type),
    value: asStr(meta.value ?? raw.culprit),
  };
}

/** Drop issues already covered by an open triage PR or an existing ledger row. */
export function filterNewIssues(all: CompactIssue[], covered: Set<string>): CompactIssue[] {
  return all.filter((i) => !covered.has(i.id));
}

/**
 * The Sentry `Link` header drives cursor pagination: the `rel="next"` segment carries
 * `results="true"` when another page exists, plus its `cursor="…"`. Return that cursor, else
 * undefined (last page).
 */
export function parseNextCursor(linkHeader: string | null): string | undefined {
  if (!linkHeader) {
    return undefined;
  }
  for (const part of linkHeader.split(",")) {
    if (!/rel="next"/.test(part)) {
      continue;
    }
    if (!/results="true"/.test(part)) {
      return undefined;
    }
    const cursor = part.match(/cursor="([^"]+)"/);
    return cursor ? cursor[1] : undefined;
  }
  return undefined;
}

/** Extract the top in-app stack frames from a Sentry "latest event" payload (best-effort). */
export function extractFrames(event: Record<string, unknown>, limit = 6): StackFrame[] {
  const entries = (event.entries ?? []) as Array<Record<string, unknown>>;
  const exception = entries.find((e) => e.type === "exception");
  const values = ((exception?.data as Record<string, unknown>)?.values ?? []) as Array<
    Record<string, unknown>
  >;
  const frames: StackFrame[] = [];
  for (const val of values) {
    const raw = ((val.stacktrace as Record<string, unknown>)?.frames ?? []) as Array<
      Record<string, unknown>
    >;
    for (const f of raw) {
      if (f.inApp !== true) {
        continue;
      }
      frames.push({
        file: typeof f.filename === "string" ? f.filename : "",
        function: typeof f.function === "string" ? f.function : "",
        line: typeof f.lineNo === "number" ? f.lineNo : null,
      });
    }
  }
  // Sentry lists frames oldest→newest; the crash site is last. Keep the deepest `limit`.
  return frames.slice(-limit);
}

// ── Sentry API (impure; deps injectable for the tests) ───────────────────────────────────────
function sentryHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

/** Page through a project's unresolved issues (bounded). Throws on a non-OK first response. */
export async function listUnresolvedIssues(
  project: string,
  token: string,
  deps: FetchDeps = defaultFetchDeps(),
): Promise<CompactIssue[]> {
  const out: CompactIssue[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL(`${API_BASE}/api/0/projects/${ORG}/${project}/issues/`);
    url.searchParams.set("query", "is:unresolved");
    url.searchParams.set("statsPeriod", "90d");
    url.searchParams.set("limit", "100");
    if (cursor) {
      url.searchParams.set("cursor", cursor);
    }
    const res = await deps.fetchFn(url.toString(), { headers: sentryHeaders(token) });
    if (!res.ok) {
      throw new Error(`GET issues ${project} → ${res.status} ${await res.text().catch(() => "")}`);
    }
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    for (const r of rows) {
      out.push(compactIssue(r, project));
    }
    cursor = parseNextCursor(res.headers.get("link"));
    if (!cursor) {
      break;
    }
  }
  return out;
}

/** Best-effort: attach the latest event's top in-app frames to an issue (never throws). */
async function enrichWithFrames(
  issue: CompactIssue,
  token: string,
  deps: FetchDeps,
): Promise<CompactIssue> {
  try {
    const url = `${API_BASE}/api/0/organizations/${ORG}/issues/${issue.id}/events/latest/`;
    const res = await deps.fetchFn(url, { headers: sentryHeaders(token) });
    if (!res.ok) {
      return issue;
    }
    const event = (await res.json()) as Record<string, unknown>;
    const frames = extractFrames(event);
    return frames.length > 0 ? { ...issue, frames } : issue;
  } catch (e) {
    log(`frame enrich skipped for ${issue.shortId}: ${(e as Error).message}`);
    return issue;
  }
}

/** Resolve one issue. Returns true on success; idempotent (re-resolving is a no-op on Sentry). */
export async function resolveIssue(
  issueId: string,
  token: string,
  deps: FetchDeps = defaultFetchDeps(),
): Promise<boolean> {
  const url = `${API_BASE}/api/0/organizations/${ORG}/issues/${issueId}/`;
  const res = await deps.fetchFn(url, {
    body: JSON.stringify({ status: "resolved" }),
    headers: sentryHeaders(token),
    method: "PUT",
  });
  if (!res.ok) {
    log(`resolve ${issueId} → ${res.status}`);
  }
  return res.ok;
}

/** List an issue's notes/comments (best-effort; empty on any failure). */
async function listIssueComments(
  issueId: string,
  token: string,
  deps: FetchDeps,
): Promise<string[]> {
  try {
    const url = `${API_BASE}/api/0/organizations/${ORG}/issues/${issueId}/comments/`;
    const res = await deps.fetchFn(url, { headers: sentryHeaders(token) });
    if (!res.ok) {
      return [];
    }
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    return rows.map((r) => {
      const text = (r.data as Record<string, unknown> | undefined)?.text;
      return typeof text === "string" ? text : "";
    });
  } catch {
    return [];
  }
}

/** Post one note on an issue, unless a prior note already contains `mustNotContain` (the PR URL). */
async function commentIssue(
  issueId: string,
  text: string,
  mustNotContain: string,
  token: string,
  deps: FetchDeps,
): Promise<boolean> {
  const existing = await listIssueComments(issueId, token, deps);
  if (existing.some((c) => c.includes(mustNotContain))) {
    return false;
  } // already linked
  const url = `${API_BASE}/api/0/organizations/${ORG}/issues/${issueId}/comments/`;
  const res = await deps.fetchFn(url, {
    body: JSON.stringify({ text }),
    headers: sentryHeaders(token),
    method: "POST",
  });
  if (!res.ok) {
    log(`comment ${issueId} → ${res.status}`);
  }
  return res.ok;
}

// ── GitHub reads (via the baked `gh`; GH_TOKEN is exported by the driver) ─────────────────────
type Pr = { body: string; headRefName: string; number: number; url: string };
type GhRunner = (args: string[]) => { ok: boolean; stdout: string };

const defaultGh: GhRunner = (args) => {
  const p = Bun.spawnSync(["gh", ...args], { stderr: "pipe", stdout: "pipe" });
  return { ok: p.exitCode === 0, stdout: p.stdout.toString() };
};

/** Open or merged triage PRs (head starts with the triage prefix). */
export function listTriagePrs(state: "open" | "merged", gh: GhRunner = defaultGh): Pr[] {
  const r = gh([
    "pr",
    "list",
    "--repo",
    REPO,
    "--state",
    state,
    "--limit",
    "100",
    "--json",
    "number,headRefName,body,url",
  ]);
  if (!r.ok) {
    log(`gh pr list --state ${state} failed`);
    return [];
  }
  let rows: Pr[] = [];
  try {
    rows = JSON.parse(r.stdout || "[]") as Pr[];
  } catch {
    return [];
  }
  return rows.filter((p) => (p.headRefName ?? "").startsWith(BRANCH_PREFIX));
}

// ── subcommands ────────────────────────────────────────────────────────────────────────────
function requireToken(): string {
  const token = process.env.SENTRY_TRIAGE_TOKEN ?? "";
  if (!token) {
    throw new Error("no SENTRY_TRIAGE_TOKEN");
  }
  return token;
}

async function runFetch(ledgerPath: string, outFile: string): Promise<void> {
  let token = "";
  try {
    token = requireToken();
  } catch {
    // Never crash on a missing token: write an empty worklist and let the driver SKIP cleanly.
    writeFileSync(outFile, JSON.stringify({ error: "no SENTRY_TRIAGE_TOKEN", issues: [] }));
    console.log(JSON.stringify({ error: "no SENTRY_TRIAGE_TOKEN", ok: true, triaged: 0 }));
    return;
  }

  // What's already covered: any open triage PR's referenced ids, plus every id already in the ledger.
  const covered = new Set<string>();
  for (const pr of listTriagePrs("open")) {
    for (const id of parseMarkerIds(pr.body ?? "", FIX_MARKER)) {
      covered.add(id);
    }
    for (const id of parseMarkerIds(pr.body ?? "", FILE_MARKER)) {
      covered.add(id);
    }
  }
  if (existsSync(ledgerPath)) {
    for (const id of parseLedgerIds(readFileSync(ledgerPath, "utf8"))) {
      covered.add(id);
    }
  }

  const deps = defaultFetchDeps();
  const all: CompactIssue[] = [];
  const errors: Array<{ error: string; project: string }> = [];
  for (const project of PROJECTS) {
    try {
      const issues = await listUnresolvedIssues(project, token, deps);
      all.push(...issues);
    } catch (e) {
      errors.push({ error: (e as Error).message, project });
      log(`fetch ${project} degraded: ${(e as Error).message}`);
    }
  }

  const fresh = filterNewIssues(all, covered).sort((a, b) => b.count - a.count);
  const picked = fresh.slice(0, MAX_TRIAGE);
  const enriched = await Promise.all(picked.map((i) => enrichWithFrames(i, token, deps)));

  writeFileSync(
    outFile,
    JSON.stringify(
      {
        covered: covered.size,
        errors,
        generatedAt: new Date().toISOString(),
        issues: enriched,
        org: ORG,
        region: API_BASE,
        totalUnresolved: all.length,
        triaged: enriched.length,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      errors: errors.length,
      ok: true,
      totalUnresolved: all.length,
      triaged: enriched.length,
    }),
  );
}

async function runReconcile(): Promise<void> {
  const token = requireToken();
  const deps = defaultFetchDeps();
  const ids = new Set<string>();
  for (const pr of listTriagePrs("merged")) {
    for (const id of parseMarkerIds(pr.body ?? "", FIX_MARKER)) {
      ids.add(id);
    }
  }
  let resolved = 0;
  for (const id of ids) {
    if (await resolveIssue(id, token, deps)) {
      resolved += 1;
    }
  }
  console.log(JSON.stringify({ candidates: ids.size, ok: true, resolved }));
}

async function runComment(dateTag: string): Promise<void> {
  const token = requireToken();
  const deps = defaultFetchDeps();
  const prefix = `${BRANCH_PREFIX}${dateTag}-`;
  let commented = 0;
  for (const pr of listTriagePrs("open")) {
    if (!pr.headRefName.startsWith(prefix)) {
      continue;
    }
    for (const id of parseMarkerIds(pr.body ?? "", FIX_MARKER)) {
      const text = `Fluncle nightly triage opened a fix: ${pr.url}`;
      if (await commentIssue(id, text, pr.url, token, deps)) {
        commented += 1;
      }
    }
  }
  console.log(JSON.stringify({ commented, ok: true }));
}

// ── entry ─────────────────────────────────────────────────────────────────────────────────
export async function main(argv: string[]): Promise<void> {
  const [cmd, a, b] = argv;
  switch (cmd) {
    case "fetch":
      await runFetch(a ?? ".sentry/issues.json", b ?? ".sentry/issues.json");
      return;
    case "reconcile":
      await runReconcile();
      return;
    case "comment":
      await runComment(a ?? "");
      return;
    default:
      console.log(JSON.stringify({ error: `unknown subcommand "${cmd ?? ""}"`, ok: false }));
      process.exitCode = 1;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((e: Error) => {
    // Fail visible, never crash the marker: emit the ok:false summary line the prober reads.
    console.log(JSON.stringify({ error: e.message, ok: false }));
    process.exitCode = 1;
  });
}
