#!/usr/bin/env bun

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { findJsonSummary } from "./cron-marker";
import {
  evaluatePipeline,
  type Marker,
  type PipelineSnapshot,
  type Stage,
  type StageVerdict,
} from "./pipeline-watch-evaluate";

const HOME = process.env.HOME ?? homedir();
const DATA_ROOT = dirname(HOME);
const MARKER_ROOT = process.env.HEALTHCHECK_CRON_OUTPUT_DIR ?? join(DATA_ROOT, "cron", "output");
const STATE_DIR = join(HOME, ".pipeline-watch");
const STATE_FILE = join(STATE_DIR, "state.json");
const TREND_FILE = join(STATE_DIR, "embed-trend.json");
const API_BASE = (
  process.env.FLUNCLE_API_BASE_URL ??
  process.env.HEALTHCHECK_WORKER_URL ??
  "https://www.fluncle.com"
).replace(/\/+$/, "");
const API_TOKEN = process.env.FLUNCLE_API_TOKEN ?? "";
const WEBHOOK = process.env.DISCORD_ALERT_WEBHOOK ?? "";

const JOBS: Record<Stage, string> = {
  analyze: "fluncle-enrich",
  anchor: "fluncle-anchor",
  capture: "fluncle-capture",
  crawl: "fluncle-crawl",
  embed: "fluncle-embed",
  "funnel-snapshot": "fluncle-funnel-snapshot",
  "isrc-recovery": "fluncle-isrc-recovery",
};

export const MEASUREMENT_GAP_GRACE_MS = 60 * 60_000;

type Incident = { healthyChecks: number; openedAt: number; sentAt: number[] };
export type IncidentState = Record<string, Incident>;
export type Alert = { key: string; message: string; type: "OPEN" | "REMINDER" | "RECOVERED" };

export function planIncidents(
  state: IncidentState,
  verdicts: StageVerdict[],
  nowMs: number,
): { alerts: Alert[]; next: IncidentState } {
  const next: IncidentState = structuredClone(state);
  const alerts: Alert[] = [];
  const active = new Set<string>();
  for (const verdict of verdicts) {
    // `degraded` is reported, never paged: embed capacity below intake is drained by off-box
    // batches. A measurement gap pages only once it has lasted an hour, so the partial window
    // after an image swap stays quiet.
    const incident = verdict.state === "stalled" || verdict.state === "measurement_unavailable";
    const key = `${verdict.stage}:${verdict.cause}`;
    if (incident) {
      active.add(key);
      const prior = next[key] ?? { healthyChecks: 0, openedAt: nowMs, sentAt: [] };
      prior.healthyChecks = 0;
      next[key] = prior;
      const age = nowMs - prior.openedAt;
      const quietFor = verdict.state === "measurement_unavailable" ? MEASUREMENT_GAP_GRACE_MS : 0;
      const due =
        age >= quietFor &&
        (prior.sentAt.length === 0 ||
          [60 * 60_000, 4 * 60 * 60_000].some(
            (threshold) =>
              age >= threshold && !prior.sentAt.some((sent) => sent - prior.openedAt >= threshold),
          ) ||
          (age >= 24 * 60 * 60_000 && nowMs - (prior.sentAt.at(-1) ?? 0) >= 24 * 60 * 60_000));
      if (due) {
        alerts.push({
          key,
          message: `${verdict.message} Incident open ${Math.floor(age / 60_000)}m.`,
          type: prior.sentAt.length === 0 ? "OPEN" : "REMINDER",
        });
      }
    }
  }
  for (const [key, prior] of Object.entries(next)) {
    if (active.has(key)) {
      continue;
    }
    const stage = key.split(":")[0];
    const verdict = verdicts.find((item) => item.stage === stage);
    if (verdict?.state !== "healthy") {
      continue;
    }
    prior.healthyChecks += 1;
    if (prior.healthyChecks >= 2 && prior.sentAt.length === 0) {
      // Never announced (a measurement gap that cleared inside its grace), so nothing to recover.
      delete next[key];
      continue;
    }
    if (prior.healthyChecks >= 2) {
      alerts.push({
        key,
        message: `${stage}: recovered after ${Math.floor((nowMs - prior.openedAt) / 60_000)}m; ${verdict.message}`,
        type: "RECOVERED",
      });
    }
  }
  return { alerts, next };
}

export function acceptAlert(state: IncidentState, alert: Alert, nowMs: number): void {
  if (alert.type === "RECOVERED") {
    delete state[alert.key];
  } else {
    state[alert.key]?.sentAt.push(nowMs);
  }
}

function readMarkers(job: string): Marker[] | null {
  const dir = join(MARKER_ROOT, job);
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".md"))
      .map((name) => join(dir, name))
      .map((path) => ({ at: statSync(path).mtimeMs, path }))
      .sort((a, b) => b.at - a.at)
      .slice(0, 20)
      .flatMap(({ at, path }) => {
        const summary = findJsonSummary(readFileSync(path, "utf8"));
        return summary ? [{ at, summary }] : [];
      });
  } catch {
    return null;
  }
}

async function apiRead(path: string): Promise<Record<string, unknown> | null> {
  if (!API_TOKEN) {
    return null;
  }
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${API_TOKEN}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      return null;
    }
    const value: unknown = await response.json();
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const validCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export async function collectSnapshot(): Promise<PipelineSnapshot> {
  const stages = Object.keys(JOBS) as Stage[];
  const markers = Object.fromEntries(
    stages.map((stage) => [stage, readMarkers(JOBS[stage])]),
  ) as PipelineSnapshot["markers"];
  const [crawl, budget, capture, analyze, embed] = await Promise.all([
    apiRead("/api/v1/admin/catalogue/crawl"),
    apiRead("/api/v1/admin/catalogue/capture-budget"),
    apiRead("/api/v1/admin/tracks/work?kind=capture&scope=all&count=true&debtAware=true&limit=1"),
    apiRead("/api/v1/admin/tracks/work?kind=analyze&scope=all&count=true&debtAware=true&limit=1"),
    apiRead(
      "/api/v1/admin/tracks/work?kind=embed&scope=all&count=true&debtAware=true&age=true&limit=1",
    ),
  ]);
  const frontier = crawl?.frontier;
  const frontierPending =
    frontier && typeof frontier === "object" ? (frontier as Record<string, unknown>).pending : null;
  const crawlCounts =
    validCount(frontierPending) &&
    validCount(crawl?.storablePending) &&
    validCount(crawl?.unstorablePending)
      ? {
          frontier: frontierPending,
          storable: crawl.storablePending,
          unstorable: crawl.unstorablePending,
        }
      : null;
  const budgetState =
    typeof budget?.open === "boolean" &&
    validCount(budget.remainingBytes) &&
    validCount(budget.remainingTracks)
      ? {
          closedReason: typeof budget.closedReason === "string" ? budget.closedReason : null,
          open: budget.open,
          remainingBytes: budget.remainingBytes,
          remainingTracks: budget.remainingTracks,
        }
      : null;
  return {
    budget: budgetState,
    crawl: crawlCounts,
    embedOldCapture:
      typeof embed?.oldestQueuedCaptureOver24h === "boolean"
        ? embed.oldestQueuedCaptureOver24h
        : null,
    markers,
    queues: {
      analyze: validCount(analyze?.queued) ? analyze.queued : null,
      capture: validCount(capture?.queued) ? capture.queued : null,
      embed: validCount(embed?.queued) ? embed.queued : null,
    },
    quiesced: existsSync(join(DATA_ROOT, "rebake.lock")),
  };
}

function loadState(): IncidentState {
  try {
    const value: unknown = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as IncidentState)
      : {};
  } catch {
    return {};
  }
}

function saveState(state: IncidentState): void {
  mkdirSync(STATE_DIR, { mode: 0o700, recursive: true });
  const temp = `${STATE_FILE}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
  renameSync(temp, STATE_FILE);
}

type EmbedTrend = { lastAt: number; lastQueue: number; since: number; startingQueue: number };

export function advanceEmbedTrend(
  previous: EmbedTrend | null,
  queued: number | null,
  nowMs: number,
): EmbedTrend | null {
  if (queued === null) {
    return null;
  }
  if (previous && nowMs - previous.lastAt <= 30 * 60_000 && queued > previous.lastQueue) {
    return { ...previous, lastAt: nowMs, lastQueue: queued };
  }
  return { lastAt: nowMs, lastQueue: queued, since: nowMs, startingQueue: queued };
}

function loadTrend(): EmbedTrend | null {
  try {
    const value: unknown = JSON.parse(readFileSync(TREND_FILE, "utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const trend = value as Record<string, unknown>;
      if (
        validCount(trend.lastAt) &&
        validCount(trend.lastQueue) &&
        validCount(trend.since) &&
        validCount(trend.startingQueue)
      ) {
        return trend as EmbedTrend;
      }
    }
  } catch {}
  return null;
}

function saveTrend(trend: EmbedTrend | null): void {
  mkdirSync(STATE_DIR, { mode: 0o700, recursive: true });
  const temp = `${TREND_FILE}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(trend), { mode: 0o600 });
  renameSync(temp, TREND_FILE);
}

async function sendAlert(alert: Alert): Promise<boolean> {
  if (!WEBHOOK) {
    return false;
  }
  try {
    const response = await fetch(WEBHOOK, {
      body: JSON.stringify({ content: `[pipeline-watch ${alert.type}] ${alert.message}` }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const now = new Date();
  const snapshot = await collectSnapshot();
  const trend = advanceEmbedTrend(loadTrend(), snapshot.queues.embed, now.getTime());
  snapshot.embedTrend = trend;
  saveTrend(trend);
  const verdicts = evaluatePipeline(snapshot, now);
  const { alerts, next } = planIncidents(loadState(), verdicts, now.getTime());
  let deliveryFailures = 0;
  for (const alert of alerts) {
    if (await sendAlert(alert)) {
      acceptAlert(next, alert, now.getTime());
    } else {
      deliveryFailures += 1;
    }
  }
  saveState(next);
  const stages = Object.fromEntries(
    verdicts.map(({ stage, state, cause, output, backlog }) => [
      stage,
      { backlog, cause, output, state },
    ]),
  );
  console.log(
    JSON.stringify({
      checked: verdicts.length,
      deliveryFailures,
      errors: deliveryFailures,
      measurementGaps: verdicts.filter((verdict) => verdict.state === "measurement_unavailable")
        .length,
      ok: true,
      produced: Object.keys(next).length,
      stages,
    }),
  );
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`[pipeline-watch] ${error instanceof Error ? error.message : String(error)}`);
    console.log(JSON.stringify({ checked: 0, errors: 1, ok: false, produced: 0 }));
    process.exitCode = 1;
  });
}
