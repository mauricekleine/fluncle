#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { cronStaleBudgetMs, type CronDef } from "./cron-freshness";
import { findJsonSummary, splitMarker } from "./cron-marker";

export { cronStaleBudgetMs, MAX_TIMER_JITTER_MS, type CronDef } from "./cron-freshness";
export { findJsonSummary, splitMarker, STDERR_DELIMITER } from "./cron-marker";

const HOME = process.env.HOME ?? homedir() ?? "/opt/data/home";

const WORKER_URL = (process.env.HEALTHCHECK_WORKER_URL ?? "").replace(/\/+$/, "");
const R2_PROBE_URL = process.env.HEALTHCHECK_R2_PROBE_URL ?? "";

const SONAR_URL = (process.env.HEALTHCHECK_SONAR_URL ?? "").replace(/\/+$/, "");
const DNS_QUERY = process.env.HEALTHCHECK_DNS_QUERY ?? "";
const SSH_HOST = process.env.HEALTHCHECK_SSH_HOST ?? "";
const SSH_PORT = Number.parseInt(process.env.HEALTHCHECK_SSH_PORT ?? "", 10);
const DISCORD_ALERT_WEBHOOK = process.env.DISCORD_ALERT_WEBHOOK ?? "";
const FLUNCLE_API_TOKEN = process.env.FLUNCLE_API_TOKEN ?? "";

const BEACON_URL = process.env.HEALTHCHECK_BEACON_URL ?? "";

const PROBE_TIMEOUT_MS = Number.parseInt(process.env.HEALTHCHECK_TIMEOUT_MS ?? "", 10) || 4000;

const POST_TIMEOUT_MS = Number.parseInt(process.env.HEALTHCHECK_POST_TIMEOUT_MS ?? "", 10) || 20000;
const POST_ATTEMPTS = Number.parseInt(process.env.HEALTHCHECK_POST_ATTEMPTS ?? "", 10) || 3;

const ESCALATE_AFTER_TICKS = Number.parseInt(process.env.HEALTHCHECK_ESCALATE_AFTER ?? "", 10) || 6;

const TICK_INTERVAL_MS = Number.parseInt(process.env.HEALTHCHECK_TICK_MS ?? "", 10) || 10 * 60_000;

const STATE_DIR = join(HOME, ".healthcheck");
const STATE_FILE = join(STATE_DIR, "state.json");

const CRON_OUTPUT_DIR =
  process.env.HEALTHCHECK_CRON_OUTPUT_DIR ?? join(dirname(HOME), "cron", "output");

const RENDER_STATE_FILE = join(HOME, ".render-conductor", "state");

const BOAT_BIN = process.env.BOAT_BIN ?? process.env.BOX_BIN ?? "boat";

const log = (message: string) => console.error(`[fluncle-healthcheck] ${message}`);

type Status = "ok" | "degraded" | "down";

type Check = {
  latencyMs: number | null;

  message: string | null;
  service: string;
  status: Status;
};

type CheckWithTransition = Check & { transitioned: boolean };

export type ServiceState = { downStreak: number; escalatedStreak: number; status: Status };

type StateMap = Record<string, ServiceState>;

export type Escalation = { service: string; streak: number };

function msg(text: string): string | null {
  const trimmed = text.replace(/\s+/g, " ").trim();

  if (!trimmed) {
    return null;
  }

  return trimmed.length > 120 ? `${trimmed.slice(0, 119)}…` : trimmed;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, redirect: "follow", signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function runQuiet(
  bin: string,
  args: string[],
  timeoutMs: number,
): { code: number; stderr: string; stdout: string } {
  const result = spawnSync(bin, args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: timeoutMs,
  });

  return {
    code: result.status ?? (result.signal ? 124 : 1),
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}

export const WEB_RESAMPLE_OVER_MS = 500;

type WebSample = { latencyMs: number; status: number } | { error: unknown; latencyMs: number };

export async function probeWebWith(
  workerUrl: string | undefined,
  transport: (url: string, init: RequestInit) => Promise<Response> = fetchWithTimeout,
  now: () => number = Date.now,
): Promise<Check> {
  const service = "web";

  if (!workerUrl) {
    return { latencyMs: null, message: msg("not configured"), service, status: "down" };
  }

  const sample = async (): Promise<WebSample> => {
    const started = now();
    try {
      const response = await transport(`${workerUrl}/api/v1/health`, { method: "GET" });
      return { latencyMs: now() - started, status: response.status };
    } catch (error) {
      return { error, latencyMs: now() - started };
    }
  };

  let reading = await sample();
  if ("status" in reading && reading.status === 200 && reading.latencyMs > WEB_RESAMPLE_OVER_MS) {
    const second = await sample();
    if ("status" in second && second.status === 200 && second.latencyMs < reading.latencyMs) {
      reading = second;
    }
  }

  const { latencyMs } = reading;
  if (!("status" in reading)) {
    const reason =
      reading.error instanceof Error && reading.error.name === "AbortError"
        ? "timeout"
        : "unreachable";
    return { latencyMs, message: msg(`${reason} after ${latencyMs}ms`), service, status: "down" };
  }
  if (reading.status === 200) {
    return { latencyMs, message: msg(`200 in ${latencyMs}ms`), service, status: "ok" };
  }
  return {
    latencyMs,
    message: msg(`HTTP ${reading.status} in ${latencyMs}ms`),
    service,
    status: "down",
  };
}

function probeWeb(): Promise<Check> {
  return probeWebWith(WORKER_URL);
}

const DB_OK_MS = Number.parseInt(process.env.HEALTHCHECK_DB_OK_MS ?? "", 10) || 250;
const DB_DEGRADED_MS = Number.parseInt(process.env.HEALTHCHECK_DB_DEGRADED_MS ?? "", 10) || 1500;

async function probeDb(): Promise<Check> {
  const service = "db";

  if (!WORKER_URL) {
    return { latencyMs: null, message: msg("not configured"), service, status: "down" };
  }

  try {
    const response = await fetchWithTimeout(`${WORKER_URL}/api/v1/status`, { method: "GET" });

    if (response.status !== 200) {
      return {
        latencyMs: null,
        message: msg(`/api/v1/status HTTP ${response.status}`),
        service,
        status: "down",
      };
    }

    const body = (await response.json()) as { dbProbe?: { roundTripMs?: number } | null };
    const roundTripMs = body.dbProbe?.roundTripMs ?? null;

    if (roundTripMs === null) {
      return {
        latencyMs: null,
        message: msg("Worker could not reach Turso"),
        service,
        status: "down",
      };
    }

    const status: Status =
      roundTripMs <= DB_OK_MS ? "ok" : roundTripMs <= DB_DEGRADED_MS ? "degraded" : "down";

    return {
      latencyMs: roundTripMs,
      message: msg(`select 1 in ${roundTripMs}ms`),
      service,
      status,
    };
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "AbortError" ? "timeout" : "unreachable";

    return { latencyMs: null, message: msg(`/api/v1/status ${reason}`), service, status: "down" };
  }
}

async function probeR2(): Promise<Check> {
  const service = "r2";

  if (!R2_PROBE_URL) {
    return { latencyMs: null, message: msg("not configured"), service, status: "down" };
  }

  const started = Date.now();

  try {
    const response = await fetchWithTimeout(R2_PROBE_URL, { method: "HEAD" });
    const latencyMs = Date.now() - started;

    if (response.status >= 200 && response.status < 300) {
      return {
        latencyMs,
        message: msg(`${response.status} in ${latencyMs}ms`),
        service,
        status: "ok",
      };
    }

    return {
      latencyMs,
      message: msg(`HTTP ${response.status} in ${latencyMs}ms`),
      service,
      status: "down",
    };
  } catch (error) {
    const latencyMs = Date.now() - started;
    const reason =
      error instanceof Error && error.name === "AbortError" ? "timeout" : "unreachable";

    return { latencyMs, message: msg(`${reason} after ${latencyMs}ms`), service, status: "down" };
  }
}

async function probeSonar(): Promise<Check> {
  const service = "sonar";

  if (!SONAR_URL) {
    return { latencyMs: null, message: msg("not configured"), service, status: "down" };
  }

  const started = Date.now();

  try {
    const response = await fetchWithTimeout(`${SONAR_URL}/health`, { method: "GET" });
    const latencyMs = Date.now() - started;

    if (response.status < 200 || response.status >= 300) {
      return {
        latencyMs,
        message: msg(`HTTP ${response.status} in ${latencyMs}ms`),
        service,
        status: "down",
      };
    }

    let ready = false;

    try {
      const body = (await response.json()) as { ok?: unknown };

      ready = body.ok === true;
    } catch {
      return { latencyMs, message: msg("unreadable health body"), service, status: "down" };
    }

    if (!ready) {
      return { latencyMs, message: msg("engine reports not ready"), service, status: "down" };
    }

    return { latencyMs, message: msg(`200 in ${latencyMs}ms`), service, status: "ok" };
  } catch (error) {
    const latencyMs = Date.now() - started;
    const reason =
      error instanceof Error && error.name === "AbortError" ? "timeout" : "unreachable";

    return { latencyMs, message: msg(`${reason} after ${latencyMs}ms`), service, status: "down" };
  }
}

function probeDns(): Check {
  const service = "dns";

  if (!DNS_QUERY) {
    return { latencyMs: null, message: msg("not configured"), service, status: "down" };
  }

  const started = Date.now();

  const { code, stdout } = runQuiet(
    "dig",
    ["+short", "+time=3", "+tries=1", ...DNS_QUERY.trim().split(/\s+/)],
    PROBE_TIMEOUT_MS,
  );
  const latencyMs = Date.now() - started;
  const answers = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (code === 0 && answers.length > 0) {
    return {
      latencyMs,
      message: msg(`${answers.length} answer${answers.length === 1 ? "" : "s"} in ${latencyMs}ms`),
      service,
      status: "ok",
    };
  }

  return {
    latencyMs,
    message: msg(code === 124 ? "dig timeout" : "no answer"),
    service,
    status: "down",
  };
}

function probeSsh(): Promise<Check> {
  const service = "ssh";

  if (!SSH_HOST || !Number.isInteger(SSH_PORT) || SSH_PORT <= 0) {
    return Promise.resolve({
      latencyMs: null,
      message: msg("not configured"),
      service,
      status: "down",
    });
  }

  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;

    const socket = connect({ host: SSH_HOST, port: SSH_PORT });

    const finish = (status: Status, message: string) => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();
      resolve({ latencyMs: Date.now() - started, message: msg(message), service, status });
    };

    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once("connect", () => finish("ok", `connected in ${Date.now() - started}ms`));
    socket.once("timeout", () => finish("down", "tcp timeout"));
    socket.once("error", () => finish("down", "tcp refused"));
  });
}

const DISK_PROBE_PATH = process.env.HEALTHCHECK_DISK_PATH ?? HOME;
const DISK_DEGRADED_PCT =
  Number.parseInt(process.env.HEALTHCHECK_DISK_DEGRADED_PCT ?? "", 10) || 85;
const DISK_DOWN_PCT = Number.parseInt(process.env.HEALTHCHECK_DISK_DOWN_PCT ?? "", 10) || 93;

function probeDisk(): Check {
  const service = "disk";

  const { code, stdout } = runQuiet("df", ["-P", "-k", DISK_PROBE_PATH], PROBE_TIMEOUT_MS);

  if (code !== 0) {
    return { latencyMs: null, message: msg("df unavailable"), service, status: "ok" };
  }

  const dataLine = stdout.trim().split("\n").slice(1).pop() ?? "";
  const percentMatch = dataLine.match(/(\d+)%/);
  const usedPct = Number.parseInt(percentMatch?.[1] ?? "", 10);

  if (!Number.isFinite(usedPct)) {
    return { latencyMs: null, message: msg("df unparsable"), service, status: "ok" };
  }

  if (usedPct >= DISK_DOWN_PCT) {
    return { latencyMs: null, message: msg(`${usedPct}% full`), service, status: "down" };
  }

  if (usedPct >= DISK_DEGRADED_PCT) {
    return { latencyMs: null, message: msg(`${usedPct}% full`), service, status: "degraded" };
  }

  return { latencyMs: null, message: msg(`${usedPct}% used`), service, status: "ok" };
}

export const AUTOMATION_CRONS: CronDef[] = [
  { cadenceMs: 5 * 60_000, match: "enrich", service: "cron.enrich" },
  { cadenceMs: 5 * 60_000, match: "embed", service: "cron.embed" },
  { cadenceMs: 24 * 60 * 60_000, match: "cluster", service: "cron.cluster" },

  { cadenceMs: 5 * 60_000, match: "capture", service: "cron.capture" },
  { cadenceMs: 5 * 60_000, match: "context-note", service: "cron.context-note" },
  { cadenceMs: 10 * 60_000, match: "note", service: "cron.note" },
  { cadenceMs: 30 * 60_000, match: "artist-bio", service: "cron.artist-bio" },
  { cadenceMs: 30 * 60_000, match: "label-bio", service: "cron.label-bio" },
  { cadenceMs: 30 * 60_000, match: "album-bio", service: "cron.album-bio" },
  { cadenceMs: 24 * 60 * 60_000, match: "label-triage", service: "cron.label-triage" },
  { cadenceMs: 15 * 60_000, match: "triage", service: "cron.triage" },
  { cadenceMs: 60 * 60_000, match: "observation", service: "cron.observation" },
  { cadenceMs: 30 * 60_000, match: "backfill", service: "cron.backfill" },
  { cadenceMs: 10 * 60_000, match: "crawl", service: "cron.crawl" },
  { cadenceMs: 15 * 60_000, match: "pipeline-watch", service: "cron.pipeline-watch" },
  { cadenceMs: 24 * 60 * 60_000, match: "label-releases", service: "cron.label-releases" },
  { cadenceMs: 30 * 60_000, match: "rank", service: "cron.rank" },
  {
    cadenceMs: 5 * 60_000,
    match: "projection-maintenance",
    service: "cron.projection-maintenance",
  },
  { cadenceMs: 60 * 60_000, match: "anchor", service: "cron.anchor" },
  { cadenceMs: 10 * 60_000, match: "isrc-recovery", service: "cron.isrc-recovery" },
  { cadenceMs: 60 * 60_000, match: "device-mirror", service: "cron.device-mirror" },
  { cadenceMs: 60 * 60_000, match: "label-images", service: "cron.label-images" },
  { cadenceMs: 60 * 60_000, match: "recording-mbids", service: "cron.recording-mbids" },
  { cadenceMs: 60 * 60_000, match: "artist-edges", service: "cron.artist-edges" },
  { cadenceMs: 5 * 60_000, match: "artist-credits", service: "cron.artist-credits" },
  { cadenceMs: 60 * 60_000, match: "label-lineage", service: "cron.label-lineage" },
  { cadenceMs: 60 * 60_000, match: "cover-masters", service: "cron.cover-masters" },
  { cadenceMs: 60 * 60_000, match: "artist-sweep", service: "cron.artist-sweep" },
  { cadenceMs: 10 * 60_000, match: "social-capture", service: "cron.social-capture" },

  { cadenceMs: 30 * 60_000, match: "verify-captures", service: "cron.verify-captures" },
  { cadenceMs: 15 * 60_000, match: "studio-clip", service: "cron.studio-clip" },

  { cadenceMs: 60_000, match: "live", service: "cron.live" },
  { cadenceMs: 60 * 60_000, match: "render", service: "cron.render" },

  { cadenceMs: 30 * 60_000, match: "publish-advance", service: "cron.publish-advance" },

  { cadenceMs: 7 * 24 * 60 * 60_000, match: "newsletter", service: "cron.newsletter" },
  { cadenceMs: 7 * 24 * 60 * 60_000, match: "follow-digest", service: "cron.follow-digest" },

  { cadenceMs: 15 * 60_000, match: "frontier-refresh", service: "cron.frontier-refresh" },
  { cadenceMs: 24 * 60 * 60_000, match: "backup", service: "cron.backup" },

  {
    cadenceMs: 24 * 60 * 60_000,
    match: "reconcile-hub-counts",
    service: "cron.reconcile-hub-counts",
  },
  { cadenceMs: 24 * 60 * 60_000, match: "logbook", service: "cron.logbook" },

  { cadenceMs: 24 * 60 * 60_000, match: "reach", service: "cron.reach" },

  { cadenceMs: 24 * 60 * 60_000, match: "demand", service: "cron.demand" },

  { cadenceMs: 24 * 60 * 60_000, match: "funnel-snapshot", service: "cron.funnel-snapshot" },

  { cadenceMs: 24 * 60 * 60_000, match: "social-metrics", service: "cron.social-metrics" },

  { cadenceMs: 24 * 60 * 60_000, match: "audit-review", service: "cron.audit-review" },
  { cadenceMs: 24 * 60 * 60_000, match: "audit", service: "cron.audit" },

  { cadenceMs: 24 * 60 * 60_000, match: "sentry-triage", service: "cron.sentry-triage" },
];

export type CronVerdict =
  | "fresh-ok"
  | "lagging"
  | "failed"
  | "failed-once"
  | "no-data"
  | "no-summary";

type ProjectionMaintenanceOutcome =
  | "no_debt"
  | "no_progress"
  | "partial_progress"
  | "useful_completion";

const PROJECTION_MAINTENANCE_OUTCOMES = new Set<unknown>([
  "no_debt",
  "no_progress",
  "partial_progress",
  "useful_completion",
]);

export type ProjectionMaintenanceState = {
  converged: boolean | null;

  judgementAgeMs: number | null;
  oldestDebtAgeMs: number | null;
  outcome: ProjectionMaintenanceOutcome | null;
};

export const PROJECTION_JUDGEMENT_LOOKBACK_MARKERS = 20;

function dirInfo(dir: string): { jobName: string; mtimeMs: number } {
  try {
    const newest = readdirSync(dir)
      .filter((entry) => entry.endsWith(".md"))
      .map((entry) => join(dir, entry))
      .map((path) => ({ mtimeMs: statSync(path).mtimeMs, path }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];

    if (!newest) {
      return { jobName: "", mtimeMs: 0 };
    }

    const match = readFileSync(newest.path, "utf8")
      .slice(0, 600)
      .match(/^#\s*Cron Job:\s*(.+)$/m);

    return { jobName: (match?.[1]?.trim() ?? "").toLowerCase(), mtimeMs: newest.mtimeMs };
  } catch {
    return { jobName: "", mtimeMs: 0 };
  }
}

function claimCronDirs(crons: CronDef[]): Map<string, string> {
  const claimed = new Map<string, string>();

  if (!existsSync(CRON_OUTPUT_DIR)) {
    return claimed;
  }

  let resolved: { dir: string; jobName: string; mtimeMs: number }[];

  try {
    resolved = readdirSync(CRON_OUTPUT_DIR)
      .map((entry) => join(CRON_OUTPUT_DIR, entry))
      .filter((path) => {
        try {
          return statSync(path).isDirectory();
        } catch {
          return false;
        }
      })
      .map((dir) => ({ dir, ...dirInfo(dir) }))
      .filter((entry) => entry.jobName !== "")
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return claimed;
  }

  const used = new Set<string>();
  const byLongest = [...crons].sort((a, b) => b.match.length - a.match.length);

  for (const cron of byLongest) {
    const hit = resolved.find(
      (entry) => !used.has(entry.dir) && entry.jobName.includes(cron.match.toLowerCase()),
    );

    if (hit) {
      claimed.set(cron.service, hit.dir);
      used.add(hit.dir);
    }
  }

  return claimed;
}

function carriesConvergenceJudgement(summary: Record<string, unknown>): boolean {
  return typeof summary.converged === "boolean" || summary.gateState === "disabled";
}

export function readProjectionMaintenanceState(
  dir: string | undefined,
  nowMs: number = Date.now(),
): ProjectionMaintenanceState | null {
  if (!dir) {
    return null;
  }
  let markers: { mtimeMs: number; path: string }[];
  try {
    markers = readdirSync(dir)
      .filter((entry) => entry.endsWith(".md"))
      .map((entry) => join(dir, entry))
      .map((path) => ({ mtimeMs: statSync(path).mtimeMs, path }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, PROJECTION_JUDGEMENT_LOOKBACK_MARKERS);
  } catch {
    return null;
  }
  if (markers.length === 0) {
    return null;
  }
  for (const marker of markers) {
    let summary: Record<string, unknown> | null;
    try {
      summary = findJsonSummary(readFileSync(marker.path, "utf8"));
    } catch {
      continue;
    }
    if (summary === null || !carriesConvergenceJudgement(summary)) {
      continue;
    }
    const outcome = summary.outcome;
    const oldestDebtAgeMs = summary.oldestDebtAgeMs;
    return {
      converged: typeof summary.converged === "boolean" ? summary.converged : null,
      judgementAgeMs: Math.max(0, nowMs - marker.mtimeMs),
      oldestDebtAgeMs:
        typeof oldestDebtAgeMs === "number" &&
        Number.isSafeInteger(oldestDebtAgeMs) &&
        oldestDebtAgeMs >= 0
          ? oldestDebtAgeMs
          : null,
      outcome: PROJECTION_MAINTENANCE_OUTCOMES.has(outcome)
        ? (outcome as ProjectionMaintenanceOutcome)
        : null,
    };
  }
  return { converged: null, judgementAgeMs: null, oldestDebtAgeMs: null, outcome: null };
}

function formatElapsed(elapsedMs: number): string {
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) {
    return "<1m";
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

export function boxUptimeMs(): number | null {
  try {
    const seconds = Number.parseFloat(readFileSync("/proc/uptime", "utf8").split(/\s+/)[0] ?? "");

    return Number.isFinite(seconds) ? seconds * 1000 : null;
  } catch {
    return null;
  }
}

export function judgeCron(
  cron: CronDef,
  dir: string | undefined,
  uptimeMs: number | null = null,
): CronVerdict {
  const staleBudgetMs = cronStaleBudgetMs(cron);

  const noData = (): CronVerdict =>
    uptimeMs !== null && uptimeMs > staleBudgetMs ? "lagging" : "no-data";

  if (!dir) {
    return noData();
  }

  let runFiles: { mtimeMs: number; path: string }[];

  try {
    runFiles = readdirSync(dir)
      .filter((entry) => entry.endsWith(".md"))
      .map((entry) => join(dir, entry))
      .map((path) => ({ mtimeMs: statSync(path).mtimeMs, path }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return noData();
  }

  const newest = runFiles[0];

  if (!newest) {
    return noData();
  }

  if (Date.now() - newest.mtimeMs > staleBudgetMs) {
    return "lagging";
  }

  let body: string;

  try {
    body = readFileSync(newest.path, "utf8");
  } catch {
    return "fresh-ok";
  }

  const summary = findJsonSummary(body);

  if (!summary) {
    return "no-summary";
  }

  if (summary.ok === false) {
    return runFailed(runFiles[1]?.path) ? "failed" : "failed-once";
  }

  return "fresh-ok";
}

function runFailed(path: string | undefined): boolean {
  if (!path) {
    return false;
  }

  try {
    const summary = findJsonSummary(readFileSync(path, "utf8"));

    return summary === null || summary.ok === false;
  } catch {
    return false;
  }
}

export function cronCheck(
  cron: CronDef,
  verdict: CronVerdict,
  projection: ProjectionMaintenanceState | null = null,
): Check {
  const base = { latencyMs: null, service: cron.service };
  const staleBudgetMs = cronStaleBudgetMs(cron);

  const debtAgeMs =
    projection?.converged === false &&
    projection.oldestDebtAgeMs !== null &&
    projection.judgementAgeMs !== null
      ? projection.oldestDebtAgeMs + projection.judgementAgeMs
      : null;
  const outcomeMessage = (message: string) => {
    const details = [message];
    if (projection?.outcome !== null && projection?.outcome !== undefined) {
      details.push(projection.outcome);
    }
    if (projection?.converged === false) {
      details.push(
        debtAgeMs === null
          ? "debt age unavailable"
          : `oldest observed debt ${formatElapsed(debtAgeMs)}`,
      );
    }
    return msg(details.join("; "));
  };

  if (verdict === "no-summary") {
    return { ...base, message: outcomeMessage("last run died mid-flight"), status: "down" };
  }

  if (verdict === "failed") {
    return { ...base, message: outcomeMessage("last runs failed"), status: "down" };
  }

  if (debtAgeMs !== null && debtAgeMs > staleBudgetMs) {
    return { ...base, message: outcomeMessage("debt persists"), status: "down" };
  }

  if (projection !== null && projection.judgementAgeMs === null) {
    return { ...base, message: outcomeMessage("behind schedule"), status: "down" };
  }

  if (verdict === "failed-once") {
    return {
      ...base,
      message: outcomeMessage("last run failed; watching the retry"),
      status: "degraded",
    };
  }

  if (verdict === "lagging") {
    return { ...base, message: outcomeMessage("behind schedule"), status: "degraded" };
  }

  if (verdict === "no-data") {
    return { ...base, message: outcomeMessage("no runs yet"), status: "ok" };
  }

  if (
    projection !== null &&
    projection.judgementAgeMs !== null &&
    projection.judgementAgeMs > staleBudgetMs
  ) {
    return { ...base, message: outcomeMessage("behind schedule"), status: "degraded" };
  }

  return { ...base, message: outcomeMessage("fresh"), status: "ok" };
}

function probeCrons(claimed: Map<string, string>): Check[] {
  const uptimeMs = boxUptimeMs();

  return AUTOMATION_CRONS.map((cron) => {
    const dir = claimed.get(cron.service);
    const projection =
      cron.service === "cron.projection-maintenance" ? readProjectionMaintenanceState(dir) : null;
    return cronCheck(cron, judgeCron(cron, dir, uptimeMs), projection);
  });
}

export const STRAIN_PHRASES = [
  { level: "run", phrase: "aborting the batch" },
  { level: "run", phrase: "fatal:" },

  { level: "item", phrase: "bot-challenged" },

  { level: "item", phrase: "could not" },

  { level: "item", phrase: "error on " },

  { level: "item", phrase: "giving up" },

  { level: "item", phrase: "is_error" },

  { level: "item", phrase: "rate-limited" },
  { level: "item", phrase: "rejected the" },
  { level: "item", phrase: "retrying" },
  { level: "item", phrase: "stays queued" },
  { level: "item", phrase: "stays un-triaged" },
  { level: "item", phrase: "timed out" },
  { level: "item", phrase: "unable to" },
  { level: "item", phrase: "unavailable" },
] as const satisfies readonly { level: "item" | "run"; phrase: string }[];

export const STRAIN_COUNTER_KEYS: readonly string[] = ["errors", "gateSkipped"];

export const STRAIN_RATE_COUNTERS = [{ denominator: "checked", numerator: "failed" }] as const;

export const BACKPRESSURE_FLAG_KEYS: readonly string[] = ["throttled"];

export function summaryBackpressureReason(summary: Record<string, unknown> | null): string | null {
  const reason = summary?.reason;

  if (typeof reason !== "string" || reason.length === 0) {
    return null;
  }

  const admission = summary?.admissionYieldReason;

  return typeof admission === "string" && admission.length > 0 ? `${reason}:${admission}` : reason;
}

type DistressEvidence = { itemFailures: number; runFailures: number };

function countDistressEvidence(stderrRegion: string): DistressEvidence {
  const evidence: DistressEvidence = { itemFailures: 0, runFailures: 0 };

  for (const raw of stderrRegion.split("\n")) {
    const line = raw
      .replace(/^\s*>\s?/, "")
      .trim()
      .toLowerCase();

    if (!line) {
      continue;
    }

    if (STRAIN_PHRASES.some(({ level, phrase }) => level === "run" && line.includes(phrase))) {
      evidence.runFailures += 1;
    } else if (
      STRAIN_PHRASES.some(({ level, phrase }) => level === "item" && line.includes(phrase))
    ) {
      evidence.itemFailures += 1;
    }
  }

  return evidence;
}

function summaryCount(value: unknown): number {
  if (Array.isArray(value)) {
    return value.length;
  }

  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function countItemFailureRateStrain(failedValue: unknown, checkedValue: unknown): number {
  const checked =
    typeof checkedValue === "number" && Number.isFinite(checkedValue) && checkedValue > 0
      ? Math.floor(checkedValue)
      : 0;
  const failed = summaryCount(failedValue);

  return checked > 0 && failed / checked >= STRAIN_ITEM_FAILURE_RATE ? 1 : 0;
}

export function countDistressLines(stderrRegion: string, checked: unknown = null): number {
  const evidence = countDistressEvidence(stderrRegion);

  return evidence.runFailures + countItemFailureRateStrain(evidence.itemFailures, checked);
}

export function countSummaryStrain(summary: Record<string, unknown> | null): number {
  if (!summary) {
    return 0;
  }

  let points = 0;

  for (const key of STRAIN_COUNTER_KEYS) {
    points += summaryCount(summary[key]);
  }

  for (const { denominator, numerator } of STRAIN_RATE_COUNTERS) {
    points += countItemFailureRateStrain(summary[numerator], summary[denominator]);
  }

  if (typeof summary.error === "string") {
    points += 1;
  }

  return points;
}

export function countSummaryBackpressure(summary: Record<string, unknown> | null): number {
  if (!summary) {
    return 0;
  }

  let points = 0;

  for (const key of BACKPRESSURE_FLAG_KEYS) {
    if (summary[key] === true) {
      points += 1;
    }
  }

  return points;
}

export function markerSignals(body: string): {
  backpressure: number;
  backpressureReason: string | null;
  strain: number;
} {
  const summary = findJsonSummary(body);
  const distress = countDistressEvidence(splitMarker(body).stderr);
  const hasStructuredItemFailures =
    summary !== null &&
    STRAIN_RATE_COUNTERS.some(({ numerator }) => Object.hasOwn(summary, numerator));
  const proseItemStrain = hasStructuredItemFailures
    ? 0
    : countItemFailureRateStrain(distress.itemFailures, summary?.checked);

  const backpressure = countSummaryBackpressure(summary);

  return {
    backpressure,
    backpressureReason: backpressure > 0 ? summaryBackpressureReason(summary) : null,
    strain: distress.runFailures + proseItemStrain + countSummaryStrain(summary),
  };
}

export function markerStrain(body: string): number {
  return markerSignals(body).strain;
}

export function markerBackpressure(body: string): number {
  return markerSignals(body).backpressure;
}

const CONFIGURED_ITEM_FAILURE_RATE = Number.parseFloat(
  process.env.HEALTHCHECK_STRAIN_ITEM_FAILURE_RATE ?? "",
);
export const STRAIN_ITEM_FAILURE_RATE =
  Number.isFinite(CONFIGURED_ITEM_FAILURE_RATE) &&
  CONFIGURED_ITEM_FAILURE_RATE > 0 &&
  CONFIGURED_ITEM_FAILURE_RATE <= 1
    ? CONFIGURED_ITEM_FAILURE_RATE
    : 0.5;

const STRAIN_WINDOW_FLOOR_MS =
  Number.parseInt(process.env.HEALTHCHECK_STRAIN_WINDOW_MS ?? "", 10) || 6 * 60 * 60_000;
const STRAIN_WINDOW_CADENCES = 3;
const STRAIN_FAILURE_RATE =
  Number.parseFloat(process.env.HEALTHCHECK_STRAIN_FAILURE_RATE ?? "") || 0.25;
const STRAIN_MIN_TICKS = Number.parseInt(process.env.HEALTHCHECK_STRAIN_TICKS ?? "", 10) || 3;

export function strainWindowMs(
  cadenceMs: number,
  floorMs: number = STRAIN_WINDOW_FLOOR_MS,
): number {
  return Math.max(floorMs, cadenceMs * STRAIN_WINDOW_CADENCES);
}

export function strainMinimumPoints(
  cadenceMs: number,
  windowMs: number = strainWindowMs(cadenceMs),
  failureRate: number = STRAIN_FAILURE_RATE,
): number {
  return Math.max(1, Math.ceil((windowMs / cadenceMs) * failureRate));
}

const BACKPRESSURE_STALL_FLOOR_MS =
  Number.parseInt(process.env.HEALTHCHECK_BACKPRESSURE_STALL_MS ?? "", 10) || 60 * 60_000;
const BACKPRESSURE_STALL_MIN_TICKS =
  Number.parseInt(process.env.HEALTHCHECK_BACKPRESSURE_STALL_TICKS ?? "", 10) || 3;

export function backpressureStallTicks(
  cadenceMs: number,
  floorMs: number = BACKPRESSURE_STALL_FLOOR_MS,
  minTicks: number = BACKPRESSURE_STALL_MIN_TICKS,
): number {
  if (!Number.isFinite(cadenceMs) || cadenceMs <= 0) {
    return minTicks;
  }

  return Math.max(minTicks, Math.ceil(floorMs / cadenceMs));
}

const STRAIN_BUCKET_MS = 60 * 60_000;

export type StrainBucket = { backpressure?: number; points: number; ticks: number };

export type StalledSweep = { reason: string; service: string; ticks: number };

export type StrainState = {
  backpressureReason?: string;
  buckets: Record<string, StrainBucket>;

  stalled?: boolean;
  strained: boolean;
  watermarkMs: number;
};

type StrainMap = Record<string, StrainState>;

export function foldStrain(
  prev: StrainState | undefined,
  samples: {
    atMs: number;
    backpressure?: number;
    backpressureReason?: string | null;
    points: number;
  }[],
  now: number,
  windowMs: number = STRAIN_WINDOW_FLOOR_MS,
): StrainState {
  const buckets: Record<string, StrainBucket> = { ...prev?.buckets };
  let watermarkMs = prev?.watermarkMs ?? 0;
  let backpressureReason = prev?.backpressureReason;

  for (const sample of [...samples].sort((left, right) => left.atMs - right.atMs)) {
    watermarkMs = Math.max(watermarkMs, sample.atMs);

    if ((sample.backpressure ?? 0) > 0 && sample.backpressureReason) {
      backpressureReason = sample.backpressureReason;
    }

    if (sample.points <= 0 && (sample.backpressure ?? 0) <= 0) {
      continue;
    }

    const key = String(Math.floor(sample.atMs / STRAIN_BUCKET_MS) * STRAIN_BUCKET_MS);
    const bucket = buckets[key] ?? { points: 0, ticks: 0 };
    const backpressure = (bucket.backpressure ?? 0) + (sample.backpressure ?? 0);

    buckets[key] = {
      ...(backpressure > 0 ? { backpressure } : {}),
      points: bucket.points + Math.max(0, sample.points),
      ticks: bucket.ticks + (sample.points > 0 ? 1 : 0),
    };
  }

  const cutoff = now - windowMs;
  const kept: Record<string, StrainBucket> = {};

  for (const [key, bucket] of Object.entries(buckets)) {
    const start = Number.parseInt(key, 10);

    if (Number.isFinite(start) && start + STRAIN_BUCKET_MS > cutoff) {
      kept[key] = bucket;
    }
  }

  return {
    ...(backpressureReason === undefined ? {} : { backpressureReason }),
    buckets: kept,
    ...(prev?.stalled === true ? { stalled: true } : {}),
    strained: prev?.strained ?? false,
    watermarkMs,
  };
}

export function strainTotals(
  state: StrainState | undefined,
  now: number,
  windowMs: number = STRAIN_WINDOW_FLOOR_MS,
): StrainBucket {
  const cutoff = now - windowMs;
  const totals: StrainBucket = { points: 0, ticks: 0 };

  for (const [key, bucket] of Object.entries(state?.buckets ?? {})) {
    const start = Number.parseInt(key, 10);

    if (Number.isFinite(start) && start + STRAIN_BUCKET_MS > cutoff) {
      totals.points += bucket.points;
      totals.ticks += bucket.ticks;
    }
  }

  return totals;
}

export function backpressureTotal(
  state: StrainState | undefined,
  now: number,
  windowMs: number = STRAIN_WINDOW_FLOOR_MS,
): number {
  const cutoff = now - windowMs;
  let total = 0;

  for (const [key, bucket] of Object.entries(state?.buckets ?? {})) {
    const start = Number.parseInt(key, 10);

    if (Number.isFinite(start) && start + STRAIN_BUCKET_MS > cutoff) {
      total += bucket.backpressure ?? 0;
    }
  }

  return total;
}

export function isStrained(
  totals: StrainBucket,
  minPoints: number,
  minTicks = STRAIN_MIN_TICKS,
): boolean {
  return totals.points >= minPoints && totals.ticks >= minTicks;
}

export function sweepStrainCheck(
  strained: string[],
  backpressured: string[] = [],
  stalled: StalledSweep[] = [],
): Check {
  const service = "sweep-errors";
  const bare = (id: string) => id.replace(/^cron\./, "");

  if (strained.length === 0 && stalled.length === 0) {
    const names = backpressured.map(bare).join(", ");
    const message =
      backpressured.length === 0
        ? "no repeat errors"
        : `no repeat errors; ${backpressured.length} sweep${backpressured.length === 1 ? "" : "s"} yielded cleanly: ${names}`;

    return { latencyMs: null, message: msg(message), service, status: "ok" };
  }

  const parts: string[] = [];

  if (strained.length > 0) {
    parts.push(
      `${strained.length} sweep${strained.length === 1 ? "" : "s"} logging repeat errors: ${strained.map(bare).join(", ")}`,
    );
  }

  if (stalled.length > 0) {
    parts.push(
      `${stalled.length} sweep${stalled.length === 1 ? "" : "s"} paused without working: ${stalled
        .map((sweep) => `${bare(sweep.service)} (${sweep.reason} ×${sweep.ticks})`)
        .join(", ")}`,
    );
  }

  return { latencyMs: null, message: msg(parts.join("; ")), service, status: "degraded" };
}

function readStrainSamples(
  dir: string | undefined,
  watermarkMs: number,
): { atMs: number; backpressure: number; backpressureReason: string | null; points: number }[] {
  if (!dir) {
    return [];
  }

  try {
    return readdirSync(dir)
      .filter((entry) => entry.endsWith(".md"))
      .map((entry) => join(dir, entry))
      .map((path) => ({ mtimeMs: statSync(path).mtimeMs, path }))
      .filter((file) => file.mtimeMs > watermarkMs)
      .map((file) => {
        const signals = markerSignals(readFileSync(file.path, "utf8"));

        return {
          atMs: file.mtimeMs,
          backpressure: signals.backpressure,
          backpressureReason: signals.backpressureReason,
          points: signals.strain,
        };
      });
  } catch {
    return [];
  }
}

export function probeSweepStrain(
  claimed: Map<string, string>,
  prev: StrainMap,
  now = Date.now(),
): {
  backpressured: string[];
  check: Check;
  cleared: string[];
  clearedStall: string[];
  newly: string[];
  newlyStalled: StalledSweep[];
  next: StrainMap;
  stalled: StalledSweep[];
  strained: string[];
} {
  const next: StrainMap = {};
  const strained: string[] = [];
  const backpressured: string[] = [];
  const stalled: StalledSweep[] = [];
  const newly: string[] = [];
  const newlyStalled: StalledSweep[] = [];
  const cleared: string[] = [];
  const clearedStall: string[] = [];

  for (const cron of AUTOMATION_CRONS) {
    const before = prev[cron.service];
    const samples = readStrainSamples(claimed.get(cron.service), before?.watermarkMs ?? 0);
    const windowMs = strainWindowMs(cron.cadenceMs);
    const state = foldStrain(before, samples, now, windowMs);
    const nowStrained = isStrained(
      strainTotals(state, now, windowMs),
      strainMinimumPoints(cron.cadenceMs, windowMs),
    );
    const yielded = backpressureTotal(state, now, windowMs);
    const nowStalled = yielded >= backpressureStallTicks(cron.cadenceMs);

    if (yielded > 0) {
      backpressured.push(cron.service);
    }

    if (nowStalled) {
      const sweep: StalledSweep = {
        reason: state.backpressureReason ?? "throttled",
        service: cron.service,
        ticks: yielded,
      };

      stalled.push(sweep);

      if (before?.stalled !== true) {
        newlyStalled.push(sweep);
      }
    } else if (before?.stalled === true) {
      clearedStall.push(cron.service);
    }

    if (nowStrained) {
      strained.push(cron.service);

      if (before?.strained !== true) {
        newly.push(cron.service);
      }
    } else if (before?.strained === true) {
      cleared.push(cron.service);
    }

    const { stalled: _wasStalled, ...carried } = state;

    next[cron.service] = {
      ...carried,
      ...(nowStalled ? { stalled: true } : {}),
      strained: nowStrained,
    };
  }

  return {
    backpressured,
    check: sweepStrainCheck(strained, backpressured, stalled),
    cleared,
    clearedStall,
    newly,
    newlyStalled,
    next,
    stalled,
    strained,
  };
}

function probeRenderBox(): Check {
  const service = "render-box";

  let conductorState = "";

  if (existsSync(RENDER_STATE_FILE)) {
    try {
      conductorState = readFileSync(RENDER_STATE_FILE, "utf8").trim();
    } catch {
      conductorState = "";
    }
  }

  const stateLabel =
    conductorState === "idle" || conductorState === "rendering"
      ? conductorState
      : conductorState
        ? "unknown state"
        : "not yet provisioned";

  let usageSuffix = "";

  const limits = runQuiet(BOAT_BIN, ["--no-update", "limits", "--json"], PROBE_TIMEOUT_MS);

  if (limits.code === 0 && limits.stdout.trim()) {
    try {
      const parsed = JSON.parse(limits.stdout) as Record<string, unknown>;
      const used = parsed.used ?? parsed.hoursUsed ?? parsed.usage;
      const cap = parsed.limit ?? parsed.hours ?? parsed.cap;

      const isPrimitive = (value: unknown): value is number | string =>
        typeof value === "number" || typeof value === "string";

      if (isPrimitive(used) && isPrimitive(cap)) {
        usageSuffix = `, plan ${used}/${cap}`;
      }
    } catch {}
  }

  return {
    latencyMs: null,
    message: msg(`${stateLabel}${usageSuffix}`),
    service,
    status: "ok",
  };
}

function probeHermes(): Check {
  return {
    latencyMs: null,
    message: msg("cron host responsive"),
    service: "hermes",
    status: "ok",
  };
}

function probeHealthcheck(): Check {
  return {
    latencyMs: null,
    message: msg("prober tick live"),
    service: "cron.healthcheck",
    status: "ok",
  };
}

const STATE_VERSION = 5;

function isStatus(value: unknown): value is Status {
  return value === "ok" || value === "degraded" || value === "down";
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function normalizeState(parsed: unknown): StateMap {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }

  const record = parsed as Record<string, unknown>;
  const wrapped = record.services;
  const entries =
    wrapped && typeof wrapped === "object" && !Array.isArray(wrapped)
      ? (wrapped as Record<string, unknown>)
      : record;

  const state: StateMap = {};

  for (const [service, value] of Object.entries(entries)) {
    if (isStatus(value)) {
      state[service] = { downStreak: 0, escalatedStreak: 0, status: value };

      continue;
    }

    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }

    const entry = value as Record<string, unknown>;

    if (!isStatus(entry.status)) {
      continue;
    }

    state[service] = {
      downStreak: asCount(entry.downStreak),
      escalatedStreak: asCount(entry.escalatedStreak),
      status: entry.status,
    };
  }

  return state;
}

export function normalizeStrain(parsed: unknown): StrainMap {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }

  const record = parsed as Record<string, unknown>;
  const section = record.strain;

  if (!section || typeof section !== "object" || Array.isArray(section)) {
    return {};
  }

  const resetsOldScoring = record.version === 3 || record.version === 4;

  if (record.version !== STATE_VERSION && !resetsOldScoring) {
    return {};
  }

  const strain: StrainMap = {};

  for (const [service, value] of Object.entries(section as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }

    const entry = value as Record<string, unknown>;

    if (resetsOldScoring) {
      strain[service] = {
        buckets: {},
        ...(entry.stalled === true ? { stalled: true } : {}),
        strained: entry.strained === true,
        watermarkMs: 0,
      };

      continue;
    }

    const rawBuckets = entry.buckets;
    const buckets: Record<string, StrainBucket> = {};

    if (rawBuckets && typeof rawBuckets === "object" && !Array.isArray(rawBuckets)) {
      for (const [key, bucket] of Object.entries(rawBuckets as Record<string, unknown>)) {
        if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) {
          continue;
        }

        const shape = bucket as Record<string, unknown>;

        const backpressure = asCount(shape.backpressure);

        buckets[key] = {
          ...(backpressure > 0 ? { backpressure } : {}),
          points: asCount(shape.points),
          ticks: asCount(shape.ticks),
        };
      }
    }

    const reason = entry.backpressureReason;

    strain[service] = {
      ...(typeof reason === "string" && reason.length > 0 ? { backpressureReason: reason } : {}),
      buckets,
      ...(entry.stalled === true ? { stalled: true } : {}),
      strained: entry.strained === true,
      watermarkMs: asCount(entry.watermarkMs),
    };
  }

  return strain;
}

function loadState(): { services: StateMap; strain: StrainMap } {
  if (!existsSync(STATE_FILE)) {
    return { services: {}, strain: {} };
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(STATE_FILE, "utf8"));

    return { services: normalizeState(parsed), strain: normalizeStrain(parsed) };
  } catch (error) {
    log(
      `could not read state (${error instanceof Error ? error.message : String(error)}) — re-baselining`,
    );
  }

  return { services: {}, strain: {} };
}

export function serializeState(next: StateMap, strain: StrainMap = {}): string {
  return `${JSON.stringify({ services: next, strain, version: STATE_VERSION }, null, 2)}\n`;
}

function writeState(next: StateMap, strain: StrainMap): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, serializeState(next, strain), "utf8");
  } catch (error) {
    log(`could not write state (${error instanceof Error ? error.message : String(error)})`);
  }
}

export function nextServiceState(prev: ServiceState | undefined, status: Status): ServiceState {
  if (status !== "down") {
    return { downStreak: 0, escalatedStreak: 0, status };
  }

  const running = prev?.status === "down" ? prev : undefined;

  return {
    downStreak: (running?.downStreak ?? 0) + 1,
    escalatedStreak: running?.escalatedStreak ?? 0,
    status,
  };
}

export function escalationDue(state: ServiceState, threshold = ESCALATE_AFTER_TICKS): boolean {
  if (state.status !== "down") {
    return false;
  }

  const due = state.escalatedStreak > 0 ? state.escalatedStreak * 2 : threshold;

  return state.downStreak >= due;
}

function pingDiscord(content: string): void {
  if (!DISCORD_ALERT_WEBHOOK) {
    log("no DISCORD_ALERT_WEBHOOK — skipping the transition ping");

    return;
  }

  try {
    const body = JSON.stringify({ content });
    const { code } = runQuiet(
      "curl",
      [
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
      ],
      12_000,
    );

    if (code !== 0) {
      log(`discord alert POST exited ${code} (best-effort, ignored)`);
    }
  } catch (error) {
    log(
      `discord alert failed (best-effort, ignored): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function pingBeacon(): void {
  if (!BEACON_URL) {
    return;
  }

  try {
    const { code } = runQuiet(
      "curl",
      ["-sS", "-o", "/dev/null", "--max-time", "10", BEACON_URL],
      12_000,
    );

    if (code !== 0) {
      log(`beacon ping exited ${code} (best-effort, ignored)`);
    }
  } catch (error) {
    log(
      `beacon ping failed (best-effort, ignored): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function buildAlert(checks: CheckWithTransition[], prev: StateMap): string | null {
  const nowDown: string[] = [];
  const recovered: string[] = [];

  for (const check of checks) {
    if (!check.transitioned) {
      continue;
    }

    if (check.status === "down") {
      nowDown.push(check.service);
    } else if (prev[check.service]?.status === "down") {
      recovered.push(check.service);
    }
  }

  if (nowDown.length === 0 && recovered.length === 0) {
    return null;
  }

  const parts: string[] = [];

  if (nowDown.length > 0) {
    parts.push(`🔴 DOWN: ${nowDown.join(", ")}`);
  }

  if (recovered.length > 0) {
    parts.push(`🟢 recovered: ${recovered.join(", ")}`);
  }

  return `Fluncle status: ${parts.join(" — ")}`;
}

export function formatStreakDuration(streak: number, tickMs = TICK_INTERVAL_MS): string {
  const minutes = Math.round((streak * tickMs) / 60_000);

  if (minutes < 60) {
    return `~${minutes}m`;
  }

  const hours = minutes / 60;

  if (hours < 24) {
    return `~${Math.round(hours)}h`;
  }

  return `~${Math.round((hours / 24) * 10) / 10}d`;
}

const ESCALATION_LINE_LIMIT = 8;

export function buildEscalationAlert(
  escalations: Escalation[],
  tickMs = TICK_INTERVAL_MS,
): string | null {
  if (escalations.length === 0) {
    return null;
  }

  const line = ({ service, streak }: Escalation) =>
    `🚨 ${service} STILL DOWN — ${streak} consecutive checks (${formatStreakDuration(streak, tickMs)}). This is not a transient.`;

  if (escalations.length <= ESCALATION_LINE_LIMIT) {
    return escalations.map(line).join("\n");
  }

  const longest = escalations.reduce((worst, next) => (next.streak > worst.streak ? next : worst));
  const named = escalations
    .slice(0, ESCALATION_LINE_LIMIT)
    .map((escalation) => escalation.service)
    .join(", ");

  return `🚨 ${escalations.length} services STILL DOWN — longest ${longest.streak} consecutive checks (${formatStreakDuration(longest.streak, tickMs)}): ${named}, +${escalations.length - ESCALATION_LINE_LIMIT} more. This is not a transient.`;
}

export function buildStrainAlert(
  newly: string[],
  cleared: string[],
  newlyStalled: StalledSweep[] = [],
  clearedStall: string[] = [],
): string | null {
  if (
    newly.length === 0 &&
    cleared.length === 0 &&
    newlyStalled.length === 0 &&
    clearedStall.length === 0
  ) {
    return null;
  }

  const parts: string[] = [];

  if (newly.length > 0) {
    parts.push(
      `⚠️ logging repeat errors while still reporting ok: ${newly.join(", ")}. Their own summaries are green; the marker bodies are not.`,
    );
  }

  if (newlyStalled.length > 0) {
    parts.push(
      `⏸️ paused long enough to stop counting as backpressure: ${newlyStalled
        .map((sweep) => `${sweep.service} (${sweep.reason} ×${sweep.ticks})`)
        .join(", ")}. Every tick exits clean and does no work.`,
    );
  }

  if (cleared.length > 0) {
    parts.push(`🟢 quiet again: ${cleared.join(", ")}`);
  }

  if (clearedStall.length > 0) {
    parts.push(`🟢 working again: ${clearedStall.join(", ")}`);
  }

  return parts.join("\n");
}

const HEALTH_SNAPSHOT_PRODUCER = "hermes-healthcheck";

type SnapshotFetch = (input: string, init: RequestInit, timeoutMs?: number) => Promise<Response>;

function normalizeSnapshotMessage(message: string | null): string | null {
  const collapsed = message?.replace(/\s+/g, " ").trim() ?? "";

  if (collapsed.length === 0) {
    return null;
  }

  return collapsed.length > 160 ? `${collapsed.slice(0, 159)}…` : collapsed;
}

export async function healthSnapshotReceiptMetadata(
  at: string,
  checks: CheckWithTransition[],
): Promise<{
  at: string;
  checks: CheckWithTransition[];
  operationKey: string;
  producer: string;
  requestDigest: string;
}> {
  const canonicalAt = new Date(at).toISOString();
  const canonicalChecks = checks.map((check) => ({
    latencyMs: check.latencyMs,
    message: normalizeSnapshotMessage(check.message),
    service: check.service.trim(),
    status: check.status,
    transitioned: check.transitioned,
  }));
  const canonicalRequest = JSON.stringify({
    at: canonicalAt,
    checks: canonicalChecks,
    producer: HEALTH_SNAPSHOT_PRODUCER,
  });
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalRequest),
  );
  const requestDigest = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

  return {
    at: canonicalAt,
    checks: canonicalChecks,
    operationKey: `health.snapshot:${HEALTH_SNAPSHOT_PRODUCER}:${canonicalAt}`,
    producer: HEALTH_SNAPSHOT_PRODUCER,
    requestDigest,
  };
}

export async function postSnapshot(
  at: string,
  checks: CheckWithTransition[],
  transport: SnapshotFetch = fetchWithTimeout,
  config: {
    token?: string;
    wait?: () => Promise<void>;
    workerUrl?: string;
  } = {},
): Promise<boolean> {
  const workerUrl = config.workerUrl ?? WORKER_URL;
  const token = config.token ?? FLUNCLE_API_TOKEN;

  if (!workerUrl) {
    log("no HEALTHCHECK_WORKER_URL — cannot POST the snapshot");

    return false;
  }

  if (!token) {
    log("no FLUNCLE_API_TOKEN in the cron env — cannot POST the snapshot");

    return false;
  }

  const metadata = await healthSnapshotReceiptMetadata(at, checks);
  const body = JSON.stringify(metadata);
  const reconcileBody = JSON.stringify({
    operationId: "health.snapshot",
    operationKey: metadata.operationKey,
    requestDigest: metadata.requestDigest,
  });

  for (let attempt = 1; attempt <= POST_ATTEMPTS; attempt++) {
    try {
      const response = await transport(
        `${workerUrl}/api/v1/admin/health`,
        {
          body,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          method: "POST",
        },
        POST_TIMEOUT_MS,
      );

      if (response.ok) {
        return true;
      }

      if (response.status < 500) {
        log(`record_health POST returned HTTP ${response.status} (best-effort, ignored)`);
        return false;
      }

      throw new Error("record_health POST returned an ambiguous server response");
    } catch {
      try {
        const reconciliation = await transport(
          `${workerUrl}/api/v1/admin/operation-receipts/resolve`,
          {
            body: reconcileBody,
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            method: "POST",
          },
          POST_TIMEOUT_MS,
        );

        if (!reconciliation.ok) {
          log("record_health reconciliation unavailable; snapshot was not replayed");
          return false;
        }

        const payload = (await reconciliation.json()) as {
          receipt?: { outcome?: string };
        };
        const outcome = payload.receipt?.outcome;
        if (outcome === "committed") {
          return true;
        }

        if (outcome !== "safely-retryable") {
          log("record_health reconciliation did not authorize replay");
          return false;
        }
      } catch {
        log("record_health reconciliation unavailable; snapshot was not replayed");
        return false;
      }

      if (attempt < POST_ATTEMPTS) {
        log(`record_health POST attempt ${attempt}/${POST_ATTEMPTS} was safely retryable`);
        await (config.wait?.() ?? new Promise((resolve) => setTimeout(resolve, 1000)));
        continue;
      }

      log(`record_health POST failed after ${POST_ATTEMPTS} reconciled attempts`);
      return false;
    }
  }

  return false;
}

async function main(): Promise<void> {
  const at = new Date().toISOString();

  const [web, db, r2, sonar, ssh] = await Promise.all([
    probeWeb(),
    probeDb(),
    probeR2(),
    probeSonar(),
    probeSsh(),
  ]);
  const dns = probeDns();
  const disk = probeDisk();

  const claimed = claimCronDirs(AUTOMATION_CRONS);
  const crons = probeCrons(claimed);
  const renderBox = probeRenderBox();
  const hermes = probeHermes();

  const healthcheck = probeHealthcheck();

  const { services: prev, strain: prevStrain } = loadState();

  const sweepStrain = probeSweepStrain(claimed, prevStrain);

  const checks: Check[] = [
    web,
    db,
    r2,
    sonar,
    dns,
    ssh,
    disk,
    sweepStrain.check,
    ...crons,
    healthcheck,
    renderBox,
    hermes,
  ];

  const withTransition: CheckWithTransition[] = checks.map((check) => ({
    ...check,
    transitioned: prev[check.service] !== undefined && prev[check.service]?.status !== check.status,
  }));

  const next: StateMap = {};
  const escalations: Escalation[] = [];

  for (const check of checks) {
    const state = nextServiceState(prev[check.service], check.status);
    const escalate = escalationDue(state);

    if (escalate) {
      escalations.push({ service: check.service, streak: state.downStreak });
    }

    next[check.service] = escalate ? { ...state, escalatedStreak: state.downStreak } : state;
  }

  writeState(next, sweepStrain.next);

  const alert = buildAlert(withTransition, prev);

  if (alert) {
    pingDiscord(alert);
  }

  const escalationAlert = buildEscalationAlert(escalations);

  if (escalationAlert) {
    pingDiscord(escalationAlert);
  }

  const strainAlert = buildStrainAlert(
    sweepStrain.newly,
    sweepStrain.cleared,
    sweepStrain.newlyStalled,
    sweepStrain.clearedStall,
  );

  if (strainAlert) {
    pingDiscord(strainAlert);
  }

  pingBeacon();

  const posted = await postSnapshot(at, withTransition);

  const summary = {
    alerted: alert !== null || escalationAlert !== null || strainAlert !== null,
    at,

    backpressured: sweepStrain.backpressured,
    down: withTransition.filter((c) => c.status === "down").map((c) => c.service),

    escalated: escalations,
    ok: true as const,
    posted,
    services: withTransition.map((c) => ({
      service: c.service,
      status: c.status,
      transitioned: c.transitioned,
    })),

    stalled: sweepStrain.stalled,

    strained: sweepStrain.strained,
    transitions: withTransition.filter((c) => c.transitioned).map((c) => c.service),
  };

  console.log(JSON.stringify(summary));
}

if (import.meta.main) {
  main().catch((error) => {
    log(`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    console.log(JSON.stringify({ ok: false, reason: "prober_error" }));
    process.exit(1);
  });
}
