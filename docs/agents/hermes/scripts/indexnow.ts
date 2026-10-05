#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultStateDir } from "./attempt-ledger";
import { runDatabaseAdmissionPhase } from "./database-admission-phase";

const API_BASE_URL = process.env.FLUNCLE_API_BASE_URL ?? "https://www.fluncle.com";
const API_TOKEN = process.env.FLUNCLE_API_TOKEN ?? "";
const ADMISSION_OWNER = "fluncle-indexnow";
const REQUEST_TIMEOUT_MS = 120_000;
const WINDOW_START_BUDGET_MS = 600_000;
const MAX_WINDOWS = 2000;
const DAILY_URL_BUDGET = 10_000;
const BATCH_SIZE = 1000;
const BATCH_PAUSE_MS = 5000;
const SUBMIT_BUDGET_MS = 300_000;
const WALK_FRESHNESS_MS = 12 * 60 * 60 * 1000;
const INDEXNOW_TIMEOUT_MS = 15_000;
const ENDPOINTS = {
  indexnow: "https://api.indexnow.org/indexnow",
  yandex: "https://yandex.com/indexnow",
} as const;
const KINDS = ["log", "artist", "label", "album", "track"] as const;

type Kind = (typeof KINDS)[number];
type Cursor = { after?: string; kind: Kind };
type WalkRequest = { cursor?: Cursor; phase: "walk" };
type Version = { changedAt: string; fingerprint: string; kind: Kind; subjectId: string };
type ClaimRequest = { limit: number; phase: "claim" };
type AckRequest = { phase: "ack"; versions: Version[] };
type RequestBody = WalkRequest | ClaimRequest | AckRequest;
type WalkResponse = {
  changed: number;
  checked: number;
  inserted: number;
  kind: Kind;
  next: Cursor | null;
  ok: true;
  phase: "walk";
  removed: number;
};
type ClaimResponse = {
  due: number;
  indexNow: { host: string; key: string; keyLocation: string };
  items: (Version & { url: string })[];
  ok: true;
  phase: "claim";
};
type AckResponse = { due: number; ok: true; phase: "ack"; stamped: number };
type PhaseResponse = WalkResponse | ClaimResponse | AckResponse;
type Batch = {
  accepted: boolean;
  endpoint: keyof typeof ENDPOINTS;
  retryAfterSecs?: number;
  size: number;
  status: number | null;
};
type Summary = {
  batches: Batch[];
  changed: number;
  checked: number;
  dryRun?: true;
  error: string | null;
  errors: number;
  gateState?: "dry-run";
  inserted: number;
  ok: boolean;
  partial: boolean;
  produced: number;
  queueDepth: number | null;
  rateLimited: boolean;
  reason: string | null;
  removed: number;
  retryAfterSecs?: number;
  sample?: string[];
  status: number | null;
  submitted: number;
  vendorCalls: number;
  walkSkipped: boolean;
  windows: number;
  wouldSubmit?: number;
};
type Deps = {
  dryRun?: boolean;
  fetch?: typeof fetch;
  log: (message: string) => void;
  now?: () => number;
  request: (body: RequestBody) => Promise<PhaseResponse | undefined>;
  sleep?: (milliseconds: number) => Promise<void>;
  stateDirectory: string;
};

const log = (message: string) => console.error(`[indexnow] ${message}`);

function validateCursor(value: unknown): Cursor | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("submit_indexnow returned an invalid cursor");
  }
  const candidate = value as Record<string, unknown>;
  const kind = KINDS.find((name) => name === candidate.kind);
  if (
    kind === undefined ||
    (candidate.after !== undefined && (typeof candidate.after !== "string" || !candidate.after))
  ) {
    throw new Error("submit_indexnow returned an invalid cursor");
  }
  return candidate.after === undefined ? { kind } : { after: candidate.after as string, kind };
}

function readCheckpoint(directory: string): Cursor | undefined {
  try {
    return (
      validateCursor(JSON.parse(readFileSync(join(directory, "cursor.json"), "utf8"))) ?? undefined
    );
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function writeCheckpoint(directory: string, cursor: Cursor | null): void {
  const path = join(directory, "cursor.json");
  if (cursor === null) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(directory, { recursive: true });
  const staged = `${path}.${process.pid}.tmp`;
  writeFileSync(staged, JSON.stringify(cursor));
  renameSync(staged, path);
}

function advancingCursor(cursor: Cursor | undefined, next: Cursor | null): boolean {
  if (next === null || cursor === undefined) {
    return true;
  }
  const order = KINDS.indexOf(next.kind) - KINDS.indexOf(cursor.kind);
  return (
    order > 0 ||
    (order === 0 && typeof next.after === "string" && next.after > (cursor.after ?? ""))
  );
}

function logAudit(write: (message: string) => void, summary: Summary): void {
  write(
    `AUDIT checked=${summary.checked} inserted=${summary.inserted} changed=${summary.changed} removed=${summary.removed} submitted=${summary.submitted} due=${summary.queueDepth ?? "?"} status=${summary.status ?? "?"} errors=${summary.errors} batches=${summary.batches.filter((batch) => batch.accepted).length}/${summary.batches.length} vendorCalls=${summary.vendorCalls}${summary.partial ? ` partial=${summary.reason ?? "unknown"}` : ""}`,
  );
}

function recentWalk(directory: string, now: number): boolean {
  try {
    const value: unknown = JSON.parse(readFileSync(join(directory, "walk.json"), "utf8"));
    if (
      typeof value !== "object" ||
      value === null ||
      !("completedAt" in value) ||
      typeof value.completedAt !== "string"
    ) {
      return false;
    }
    const elapsed = now - Date.parse(value.completedAt);
    return elapsed >= 0 && elapsed < WALK_FRESHNESS_MS;
  } catch {
    return false;
  }
}

function completeWalkCheckpoint(directory: string, now: number): void {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "walk.json");
  const staged = `${path}.${process.pid}.tmp`;
  writeFileSync(staged, JSON.stringify({ completedAt: new Date(now).toISOString() }));
  renameSync(staged, path);
}

function retryAfter(value: string | null, now: number): number | undefined {
  if (value === null || value.trim() === "") {
    return undefined;
  }
  const seconds = /^\d+(?:\.\d+)?$/.test(value.trim())
    ? Number(value)
    : (Date.parse(value) - now) / 1000;
  return Number.isFinite(seconds) ? Math.max(0, Math.ceil(seconds)) : undefined;
}

async function submitPhases(deps: Deps, summary: Summary): Promise<void> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((milliseconds) => Bun.sleep(milliseconds));
  const vendorFetch = deps.fetch ?? fetch;
  const started = now();
  try {
    const claim = await deps.request({ limit: DAILY_URL_BUDGET, phase: "claim" });
    if (claim === undefined) {
      summary.errors = 1;
      summary.error ??= "IndexNow claim yielded database admission";
      summary.reason ??= "database_admission";
      return;
    }
    if (claim.phase !== "claim" || claim.ok !== true) {
      throw new Error("submit_indexnow claim did not ack");
    }
    summary.queueDepth = claim.due;
    if (summary.walkSkipped) {
      summary.checked = claim.items.length;
    }
    if (deps.dryRun) {
      summary.wouldSubmit = claim.items.length;
      summary.sample = claim.items.slice(0, 5).map((item) => item.url);
      return;
    }
    const post = async (
      items: ClaimResponse["items"],
      endpoint: Batch["endpoint"],
    ): Promise<Batch> => {
      const batch: Batch = { accepted: false, endpoint, size: items.length, status: null };
      summary.batches.push(batch);
      summary.vendorCalls += 1;
      summary.submitted += items.length;
      summary.status = null;
      const response = await vendorFetch(ENDPOINTS[endpoint], {
        body: JSON.stringify({ ...claim.indexNow, urlList: items.map((item) => item.url) }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        signal: AbortSignal.timeout(INDEXNOW_TIMEOUT_MS),
      });
      void response.body?.cancel().catch(() => {});
      batch.status = response.status;
      summary.status = response.status;
      batch.accepted = response.status === 200 || response.status === 202;
      if (response.status === 429) {
        summary.rateLimited = true;
        const seconds = retryAfter(response.headers.get("Retry-After"), now());
        if (seconds !== undefined) {
          batch.retryAfterSecs = seconds;
          summary.retryAfterSecs = seconds;
        }
      }
      return batch;
    };
    for (let offset = 0; offset < claim.items.length; offset += BATCH_SIZE) {
      if (offset > 0) {
        await sleep(BATCH_PAUSE_MS);
      }
      if (now() - started >= SUBMIT_BUDGET_MS) {
        summary.partial = true;
        summary.reason = "submit_budget";
        break;
      }
      const items = claim.items.slice(offset, offset + BATCH_SIZE);
      const primary = await post(items, "indexnow");
      let result = primary;
      if (primary.status === 429) {
        result = await post(items, "yandex");
        if (
          result.status === 429 &&
          primary.retryAfterSecs !== undefined &&
          primary.retryAfterSecs <= 120
        ) {
          await sleep(primary.retryAfterSecs * 1000);
          result = await post(items, "indexnow");
        }
      }
      if (!result.accepted) {
        if (result.status === 429) {
          summary.partial = true;
          summary.reason = "rate_limited";
          if (summary.produced === 0) {
            summary.errors = 1;
            summary.error = "IndexNow submission rate limited";
          }
        } else {
          summary.errors = 1;
          summary.error = `IndexNow submission failed (${result.status ?? "network"})`;
        }
        break;
      }
      summary.produced += items.length;
      const ack = await deps.request({
        phase: "ack",
        versions: items.map(({ changedAt, fingerprint, kind, subjectId }) => ({
          changedAt,
          fingerprint,
          kind,
          subjectId,
        })),
      });
      if (ack === undefined) {
        summary.errors = 1;
        summary.error = "IndexNow acknowledgement yielded database admission";
        summary.reason = "database_admission";
        break;
      }
      if (ack.phase !== "ack" || ack.ok !== true) {
        throw new Error("submit_indexnow acknowledgement failed");
      }
      summary.queueDepth = ack.due;
    }
  } catch (error) {
    summary.errors = 1;
    summary.error = error instanceof Error ? error.message : String(error);
  }
}

export async function runIndexNowTick(deps: Deps): Promise<Summary> {
  const now = deps.now ?? Date.now;
  const started = now();
  const summary: Summary = {
    batches: [],
    ...(deps.dryRun ? ({ dryRun: true, gateState: "dry-run" } as const) : {}),
    changed: 0,
    checked: 0,
    error: null,
    errors: 0,
    inserted: 0,
    ok: true,
    partial: false,
    produced: 0,
    queueDepth: null,
    rateLimited: false,
    reason: null,
    removed: 0,
    status: null,
    submitted: 0,
    vendorCalls: 0,
    walkSkipped: recentWalk(deps.stateDirectory, now()),
    windows: 0,
  };
  const saved = summary.walkSkipped ? undefined : readCheckpoint(deps.stateDirectory);
  let catalogueResume = saved?.kind === "log" ? undefined : saved;
  let cursor = saved?.kind === "log" ? saved : undefined;
  try {
    while (!summary.walkSkipped && summary.windows < MAX_WINDOWS) {
      if (summary.windows > 0 && now() - started >= WINDOW_START_BUDGET_MS) {
        summary.partial = true;
        summary.reason = "wall_budget";
        break;
      }
      const response = await deps.request({
        ...(cursor === undefined ? {} : { cursor }),
        phase: "walk",
      });
      if (response === undefined) {
        summary.partial = true;
        summary.reason = "database_admission";
        break;
      }
      if (response.phase !== "walk" || response.ok !== true) {
        throw new Error("submit_indexnow walk did not ack");
      }
      let next = validateCursor(response.next);
      if (!advancingCursor(cursor, next)) {
        throw new Error("submit_indexnow cursor did not advance");
      }
      summary.windows += 1;
      summary.checked += response.checked;
      summary.inserted += response.inserted;
      summary.changed += response.changed;
      summary.removed += response.removed;
      if (catalogueResume !== undefined && next?.kind !== "log") {
        next = catalogueResume;
        catalogueResume = undefined;
      }
      if (catalogueResume === undefined) {
        writeCheckpoint(deps.stateDirectory, next);
      }
      if (next === null) {
        if (!deps.dryRun) {
          completeWalkCheckpoint(deps.stateDirectory, now());
        }
        break;
      }
      cursor = next;
      if (summary.windows === MAX_WINDOWS) {
        summary.partial = true;
        summary.reason = "window_budget";
      }
    }
  } catch (error) {
    summary.errors = 1;
    summary.error = error instanceof Error ? error.message : String(error);
    summary.partial = true;
    summary.reason = "walk_failed";
  }
  if (summary.windows === 0 && !summary.walkSkipped) {
    summary.errors = 1;
    summary.error ??= "submit_indexnow inspected no windows";
  }
  await submitPhases(deps, summary);
  summary.ok = summary.errors === 0;
  logAudit(deps.log, summary);
  return summary;
}

async function postPhase(body: RequestBody): Promise<PhaseResponse> {
  const response = await fetch(`${API_BASE_URL}/api/v1/admin/indexnow/submit`, {
    body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${API_TOKEN}`, "Content-Type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `submit_indexnow failed (${response.status}): ${(await response.text()).slice(0, 200)}`,
    );
  }
  return (await response.json()) as PhaseResponse;
}

function admittedPhase(body: RequestBody): Promise<PhaseResponse | undefined> {
  const directory = mkdtempSync(join(tmpdir(), "fluncle-indexnow-phase-"));
  const statePath = join(directory, "request.json");
  try {
    writeFileSync(statePath, JSON.stringify(body), { mode: 0o600 });
    const phase = runDatabaseAdmissionPhase({
      command: [process.execPath, import.meta.path, "--admission-phase", statePath],
      owner: ADMISSION_OWNER,
      phase: body.phase,
      yieldRetries: 1,
    });
    if (phase.kind === "yielded") {
      return Promise.resolve(undefined);
    }
    const envelope = JSON.parse(phase.stdout.trim().split("\n").at(-1) ?? "") as {
      error?: string;
      kind?: string;
      response?: PhaseResponse;
    };
    if (envelope.kind !== "response" || envelope.response === undefined) {
      throw new Error(envelope.error ?? "IndexNow phase returned an invalid envelope");
    }
    return Promise.resolve(envelope.response);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

async function main(): Promise<void> {
  if (!API_TOKEN) {
    throw new Error("Missing FLUNCLE_API_TOKEN");
  }
  const started = Date.now();
  const summary = await runIndexNowTick({
    dryRun: process.argv.includes("--dry-run"),
    log,
    request: process.env.FLUNCLE_ADMISSION_RUNNER_PID ? postPhase : admittedPhase,
    stateDirectory: process.env.INDEXNOW_STATE_DIR ?? defaultStateDir("indexnow"),
  });
  console.log(JSON.stringify({ ...summary, elapsedMs: Date.now() - started }));
  if (!summary.ok) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  const phaseIndex = process.argv.indexOf("--admission-phase");
  if (phaseIndex >= 0) {
    const statePath = process.argv[phaseIndex + 1];
    if (statePath === undefined) {
      throw new Error("IndexNow admission phase requires request state");
    }
    void postPhase(JSON.parse(readFileSync(statePath, "utf8")) as RequestBody).then(
      (response) => console.log(JSON.stringify({ kind: "response", response })),
      (error: unknown) =>
        console.log(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
            kind: "failed",
          }),
        ),
    );
  } else {
    void main().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      log(message);
      console.log(
        JSON.stringify({
          ...(process.argv.includes("--dry-run") ? { dryRun: true, gateState: "dry-run" } : {}),
          batches: [],
          changed: 0,
          checked: 0,
          error: message,
          errors: 1,
          inserted: 0,
          ok: false,
          produced: 0,
          queueDepth: null,
          rateLimited: false,
          removed: 0,
          status: null,
          submitted: 0,
          vendorCalls: 0,
          walkSkipped: false,
          windows: 0,
        }),
      );
      process.exitCode = 1;
    });
  }
}
