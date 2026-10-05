#!/usr/bin/env bun

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultStateDir } from "./attempt-ledger";
import { runDatabaseAdmissionPhase } from "./database-admission-phase";

const API_BASE_URL = process.env.FLUNCLE_API_BASE_URL ?? "https://www.fluncle.com";
const API_TOKEN = process.env.FLUNCLE_API_TOKEN ?? "";
const ADMISSION_OWNER = "fluncle-indexnow";
const REQUEST_TIMEOUT_MS = 120_000;
const WINDOW_START_BUDGET_MS = 600_000;
const MAX_WINDOWS = 2000;
const KINDS = ["log", "artist", "label", "album", "track"] as const;

type Kind = (typeof KINDS)[number];
type Cursor = { after?: string; kind: Kind };
type WalkRequest = { cursor?: Cursor; phase: "walk" };
type SubmitRequest = { dryRun?: boolean; phase: "submit" };
type RequestBody = WalkRequest | SubmitRequest;
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
type SubmitResponse = {
  dryRun?: boolean;
  due: number | null;
  error?: string;
  ok: boolean;
  phase: "submit";
  sample?: string[];
  status: number | null;
  submitted: number;
};
type PhaseResponse = WalkResponse | SubmitResponse;

type Summary = {
  changed: number;
  checked: number;
  error: string | null;
  errors: number;
  inserted: number;
  ok: boolean;
  partial: boolean;
  produced: number;
  queueDepth: number | null;
  reason: string | null;
  removed: number;
  status: number | null;
  submitted: number;
  windows: number;
};

type Deps = {
  dryRun?: boolean;
  log: (message: string) => void;
  now?: () => number;
  request: (body: RequestBody) => Promise<PhaseResponse | undefined>;
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
    `AUDIT checked=${summary.checked} inserted=${summary.inserted} changed=${summary.changed} removed=${summary.removed} submitted=${summary.submitted} due=${summary.queueDepth ?? "?"} status=${summary.status ?? "?"} errors=${summary.errors}${summary.partial ? ` partial=${summary.reason ?? "unknown"}` : ""}`,
  );
}

async function submitPhase(deps: Deps, summary: Summary): Promise<void> {
  try {
    const response = await deps.request({ dryRun: deps.dryRun ?? false, phase: "submit" });
    if (response === undefined) {
      summary.errors = 1;
      summary.error ??= "IndexNow submission yielded database admission";
      summary.reason ??= "database_admission";
    } else {
      if (response.phase !== "submit") {
        throw new Error("submit_indexnow submit did not ack");
      }
      summary.queueDepth = response.due;
      summary.status = response.status;
      summary.submitted = response.submitted;
      summary.produced =
        response.dryRun === true || deps.dryRun === true
          ? 0
          : response.status === 200 || response.status === 202
            ? response.submitted
            : 0;
      if (!response.ok) {
        summary.errors = 1;
        summary.error =
          response.error ?? `IndexNow submission failed (${response.status ?? "network"})`;
      }
    }
  } catch (error) {
    summary.errors = 1;
    summary.error = error instanceof Error ? error.message : String(error);
  }
}

export async function runIndexNowTick(deps: Deps): Promise<Summary> {
  const now = deps.now ?? (() => performance.now());
  const started = now();
  const summary: Summary = {
    changed: 0,
    checked: 0,
    error: null,
    errors: 0,
    inserted: 0,
    ok: true,
    partial: false,
    produced: 0,
    queueDepth: null,
    reason: null,
    removed: 0,
    status: null,
    submitted: 0,
    windows: 0,
  };
  const saved = readCheckpoint(deps.stateDirectory);
  let catalogueResume = saved?.kind === "log" ? undefined : saved;
  let cursor = saved?.kind === "log" ? saved : undefined;
  try {
    while (summary.windows < MAX_WINDOWS) {
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
  if (summary.windows === 0) {
    summary.errors = 1;
    summary.error ??= "submit_indexnow inspected no windows";
  }
  await submitPhase(deps, summary);
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
  const phase = runDatabaseAdmissionPhase({
    command: [process.execPath, import.meta.path, "--admission-phase", JSON.stringify(body)],
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
    void postPhase(JSON.parse(process.argv[phaseIndex + 1] ?? "null") as RequestBody).then(
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
          changed: 0,
          checked: 0,
          error: message,
          errors: 1,
          inserted: 0,
          ok: false,
          produced: 0,
          queueDepth: null,
          removed: 0,
          status: null,
          submitted: 0,
        }),
      );
      process.exitCode = 1;
    });
  }
}
