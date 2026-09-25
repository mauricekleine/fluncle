#!/usr/bin/env bun

import { existsSync, readFileSync, writeFileSync } from "node:fs";

const API_BASE = (process.env.SENTRY_TRIAGE_API_BASE ?? "https://de.sentry.io").replace(/\/$/, "");
const ORG = process.env.SENTRY_TRIAGE_ORG ?? process.env.SENTRY_ORG ?? "fluncle";
const PROJECTS = (process.env.SENTRY_TRIAGE_PROJECTS ?? "fluncle-web,fluncle-worker")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);
const REPO = process.env.SENTRY_TRIAGE_REPO ?? "mauricekleine/fluncle";
const BRANCH_PREFIX = "sentry-triage/";

export const FIX_MARKER = "Sentry-Issue";
export const FILE_MARKER = "Sentry-Filed";

const MAX_TRIAGE = Number(process.env.SENTRY_TRIAGE_MAX ?? "12");
const MAX_PAGES = 5;

const log = (m: string) => console.error(`[sentry-triage] ${m}`);

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

export function sanitizeUntrusted(value: unknown, max = 300): string {
  if (typeof value !== "string") {
    return "";
  }
  const stripped = value
    // oxlint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length <= max ? stripped : `${stripped.slice(0, max)}… [truncated]`;
}

export function compactIssue(raw: Record<string, unknown>, project: string): CompactIssue {
  const meta = (raw.metadata ?? {}) as Record<string, unknown>;
  const asStr = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
  return {
    count: Number(raw.count ?? 0),
    culprit: sanitizeUntrusted(raw.culprit, 200),
    firstSeen: asStr(raw.firstSeen),
    id: asStr(raw.id),
    lastSeen: asStr(raw.lastSeen),
    level: sanitizeUntrusted(raw.level, 32) || "error",
    permalink: asStr(raw.permalink),
    project,
    shortId: asStr(raw.shortId),
    title: sanitizeUntrusted(raw.title, 200),
    type: sanitizeUntrusted(meta.type, 100),
    value: sanitizeUntrusted(meta.value ?? raw.culprit, 500),
  };
}

export function filterNewIssues(all: CompactIssue[], covered: Set<string>): CompactIssue[] {
  return all.filter((i) => !covered.has(i.id));
}

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

  return frames.slice(-limit);
}

function sentryHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

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
  }
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

export type TriagePr = {
  body: string;
  headRefName: string;
  mergedAt: string | null;
  number: number;
  url: string;
};
type GhRunner = (args: string[]) => { ok: boolean; stdout: string };

export type LedgerBranchResolution = {
  branch: string;
  continued: boolean;
  prNumber: number | null;
};

const RECONCILE_WINDOW_MS = 48 * 60 * 60_000;

export function filterRecentlyMerged(prs: TriagePr[], now: number, windowMs: number): TriagePr[] {
  return prs.filter((p) => {
    if (!p.mergedAt) {
      return false;
    }
    const merged = Date.parse(p.mergedAt);
    return Number.isFinite(merged) && now - merged <= windowMs;
  });
}

const defaultGh: GhRunner = (args) => {
  const p = Bun.spawnSync(["gh", ...args], { stderr: "pipe", stdout: "pipe" });
  return { ok: p.exitCode === 0, stdout: p.stdout.toString() };
};

function readTriagePrs(
  state: "open" | "merged",
  gh: GhRunner = defaultGh,
): { ok: boolean; rows: TriagePr[] } {
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
    "number,headRefName,body,url,mergedAt",
  ]);
  if (!r.ok) {
    log(`gh pr list --state ${state} failed`);
    return { ok: false, rows: [] };
  }
  let rows: TriagePr[] = [];
  try {
    rows = JSON.parse(r.stdout || "[]") as TriagePr[];
  } catch {
    log(`gh pr list --state ${state} returned invalid JSON`);
    return { ok: false, rows: [] };
  }
  return { ok: true, rows: rows.filter((p) => (p.headRefName ?? "").startsWith(BRANCH_PREFIX)) };
}

export function listTriagePrs(state: "open" | "merged", gh: GhRunner = defaultGh): TriagePr[] {
  return readTriagePrs(state, gh).rows;
}

export function listTriagePrsOrThrow(
  state: "open" | "merged",
  gh: GhRunner = defaultGh,
): TriagePr[] {
  const result = readTriagePrs(state, gh);
  if (!result.ok) {
    throw new Error(`gh pr list --state ${state} failed`);
  }
  return result.rows;
}

export function resolveLedgerBranch(prs: TriagePr[], dateTag: string): LedgerBranchResolution {
  const datedBranch = `${BRANCH_PREFIX}${dateTag}-ledger`;
  const openLedgerPrs = prs.filter((pr) => /^sentry-triage\/[^/]+-ledger$/.test(pr.headRefName));
  if (openLedgerPrs.length > 1) {
    throw new Error(`found ${openLedgerPrs.length} open ledger PRs; refusing to choose one`);
  }
  const existing = openLedgerPrs[0];
  if (!existing) {
    return { branch: datedBranch, continued: false, prNumber: null };
  }
  return { branch: existing.headRefName, continued: true, prNumber: existing.number };
}

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
    writeFileSync(outFile, JSON.stringify({ error: "no SENTRY_TRIAGE_TOKEN", issues: [] }));
    console.log(
      JSON.stringify({
        checked: 0,
        error: "no SENTRY_TRIAGE_TOKEN",
        errors: 1,
        ok: false,
        produced: 0,
        triaged: 0,
      }),
    );
    return;
  }

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
  let checked = 0;
  for (const project of PROJECTS) {
    try {
      const issues = await listUnresolvedIssues(project, token, deps);
      all.push(...issues);
      checked += 1;
    } catch (e) {
      errors.push({ error: (e as Error).message, project });
      log(`fetch ${project} degraded: ${(e as Error).message}`);
    }
  }
  if (checked === 0 && errors.length === 0) {
    errors.push({ error: "no Sentry projects configured", project: "*" });
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

  const checkedCounter = { checked };
  console.log(
    JSON.stringify({
      errors: errors.length,
      ...checkedCounter,
      ok: errors.length === 0 && checked > 0,
      produced: enriched.length,
      totalUnresolved: all.length,
      triaged: enriched.length,
    }),
  );
}

async function runReconcile(): Promise<void> {
  const token = requireToken();
  const deps = defaultFetchDeps();

  const recent = filterRecentlyMerged(listTriagePrs("merged"), Date.now(), RECONCILE_WINDOW_MS);
  const ids = new Set<string>();
  for (const pr of recent) {
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

function runLedgerBranch(dateTag: string): void {
  const resolution = resolveLedgerBranch(listTriagePrsOrThrow("open"), dateTag);
  console.log(JSON.stringify({ ok: true, ...resolution }));
}

export async function main(argv: string[]): Promise<void> {
  const [cmd, a, b] = argv;
  switch (cmd) {
    case "fetch":
      await runFetch(a ?? "docs/sentry-backlog.md", b ?? ".sentry/issues.json");
      return;
    case "reconcile":
      await runReconcile();
      return;
    case "comment":
      await runComment(a ?? "");
      return;
    case "ledger-branch":
      runLedgerBranch(a ?? "");
      return;
    default:
      console.log(JSON.stringify({ error: `unknown subcommand "${cmd ?? ""}"`, ok: false }));
      process.exitCode = 1;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((e: Error) => {
    console.log(JSON.stringify({ error: e.message, ok: false }));
    process.exitCode = 1;
  });
}
