#!/usr/bin/env bun

import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
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
const SUPPLY_FILE = join(STATE_DIR, "crawl-supply.json");
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

type Incident = {
  announcedCause: string | null;
  cause: string;
  healthyChecks: number;
  openedAt: number;
  sentAt: number[];
};
export type IncidentState = Record<string, Incident>;
export type Alert = {
  cause?: string;
  key: string;
  message: string;
  type: "OPEN" | "REMINDER" | "RECOVERED";
};

const validCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function parseIncidentState(value: unknown): IncidentState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const state: IncidentState = {};
  for (const [rawKey, raw] of Object.entries(value)) {
    const [stage, legacyCause] = rawKey.split(":");
    if (!stage || !(stage in JOBS) || !raw || typeof raw !== "object" || Array.isArray(raw)) {
      continue;
    }
    const entry = raw as Record<string, unknown>;
    const cause = typeof entry.cause === "string" ? entry.cause : legacyCause;
    if (
      !cause ||
      !validCount(entry.healthyChecks) ||
      !validCount(entry.openedAt) ||
      !Array.isArray(entry.sentAt) ||
      !entry.sentAt.every(validCount) ||
      (entry.announcedCause !== undefined &&
        entry.announcedCause !== null &&
        typeof entry.announcedCause !== "string")
    ) {
      continue;
    }
    const sentAt = [...entry.sentAt].sort((left: number, right: number) => left - right);
    const announcedCause =
      typeof entry.announcedCause === "string"
        ? entry.announcedCause
        : sentAt.length > 0
          ? cause
          : null;
    const prior = state[stage];
    state[stage] = prior
      ? {
          announcedCause:
            prior.sentAt.at(-1) && prior.sentAt.at(-1) > (sentAt.at(-1) ?? 0)
              ? prior.announcedCause
              : announcedCause,
          cause: prior.openedAt > entry.openedAt ? prior.cause : cause,
          healthyChecks: Math.min(prior.healthyChecks, entry.healthyChecks),
          openedAt: Math.min(prior.openedAt, entry.openedAt),
          sentAt: [...new Set([...prior.sentAt, ...sentAt])].sort((left, right) => left - right),
        }
      : {
          announcedCause,
          cause,
          healthyChecks: entry.healthyChecks,
          openedAt: entry.openedAt,
          sentAt,
        };
  }
  return state;
}

export function planIncidents(
  state: IncidentState,
  verdicts: StageVerdict[],
  nowMs: number,
): { alerts: Alert[]; next: IncidentState } {
  const next = parseIncidentState(state);
  const alerts: Alert[] = [];
  const active = new Set<Stage>();
  for (const verdict of verdicts) {
    const incident = verdict.state === "stalled" || verdict.state === "measurement_unavailable";
    const key = verdict.stage;
    if (incident) {
      active.add(verdict.stage);
      const prior = next[key] ?? {
        announcedCause: null,
        cause: verdict.cause,
        healthyChecks: 0,
        openedAt: nowMs,
        sentAt: [],
      };
      prior.cause = verdict.cause;
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
        const causeChange =
          prior.announcedCause && prior.announcedCause !== verdict.cause
            ? ` Cause changed from ${prior.announcedCause} to ${verdict.cause}.`
            : "";
        alerts.push({
          cause: verdict.cause,
          key,
          message: `${verdict.message} Incident open ${Math.floor(age / 60_000)}m.${causeChange}`,
          type: prior.sentAt.length === 0 ? "OPEN" : "REMINDER",
        });
      }
    }
  }
  for (const [key, prior] of Object.entries(next)) {
    if (active.has(key)) {
      continue;
    }
    const verdict = verdicts.find((item) => item.stage === key);

    if (!verdict || verdict.state === "scheduled_pause") {
      continue;
    }
    prior.healthyChecks += 1;
    if (prior.healthyChecks >= 2 && prior.sentAt.length === 0) {
      delete next[key];
      continue;
    }
    if (prior.healthyChecks >= 2) {
      alerts.push({
        key,
        message: `${key}: recovered after ${Math.floor((nowMs - prior.openedAt) / 60_000)}m; ${verdict.message}`,
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
    const incident = state[alert.key];
    if (incident) {
      incident.sentAt.push(nowMs);
      incident.announcedCause = alert.cause ?? incident.cause;
    }
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

export const API_READ_TIMEOUT_MS = 60_000;

async function apiRead(path: string): Promise<Record<string, unknown> | null> {
  if (!API_TOKEN) {
    return null;
  }
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${API_TOKEN}` },
      signal: AbortSignal.timeout(API_READ_TIMEOUT_MS),
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

export async function collectSnapshot(): Promise<PipelineSnapshot> {
  const stages = Object.keys(JOBS) as Stage[];
  const markers = Object.fromEntries(
    stages.map((stage) => [stage, readMarkers(JOBS[stage])]),
  ) as PipelineSnapshot["markers"];
  const [crawl, budget, capture, analyze, embed] = await Promise.all([
    apiRead("/api/v1/admin/catalogue/crawl?summary=true"),
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
    anchorQueue: validCount(crawl?.anchorsPending) ? crawl.anchorsPending : null,
    budget: budgetState,
    crawl: crawlCounts,
    crawlZeroChecks: 0,
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
  };
}

function loadState(): IncidentState {
  try {
    return parseIncidentState(JSON.parse(readFileSync(STATE_FILE, "utf8")) as unknown);
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

type EmbedSample = { at: number; queued: number };
type EmbedTrend = {
  lastAt: number;
  lastQueue: number;
  samples: EmbedSample[];
  since: number;
  startingQueue: number;
};

export function advanceEmbedTrend(
  previous: EmbedTrend | null,
  queued: number | null,
  nowMs: number,
): EmbedTrend | null {
  if (queued === null) {
    return null;
  }
  const continuous = previous && nowMs >= previous.lastAt && nowMs - previous.lastAt <= 30 * 60_000;
  const samples = [...(continuous ? previous.samples : []), { at: nowMs, queued }];
  const cutoff = nowMs - 24 * 60 * 60_000;
  const baseline = samples.findLastIndex((sample) => sample.at <= cutoff);
  const kept = samples.slice(Math.max(0, baseline));
  const first = kept[0] ?? { at: nowMs, queued };
  return {
    lastAt: nowMs,
    lastQueue: queued,
    samples: kept,
    since: first.at,
    startingQueue: first.queued,
  };
}

function loadTrend(): EmbedTrend | null {
  try {
    const value: unknown = JSON.parse(readFileSync(TREND_FILE, "utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const trend = value as Record<string, unknown>;
      if (
        Array.isArray(trend.samples) &&
        trend.samples.length <= 100 &&
        trend.samples.every(
          (sample: unknown) =>
            sample !== null &&
            typeof sample === "object" &&
            validCount((sample as Record<string, unknown>).at) &&
            validCount((sample as Record<string, unknown>).queued),
        ) &&
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

type CrawlSupply = { checks: number; lastAt: number };

export function advanceCrawlSupply(
  previous: CrawlSupply | null,
  storable: number | null,
  nowMs: number,
): CrawlSupply {
  return {
    checks:
      storable === 0
        ? previous && nowMs >= previous.lastAt && nowMs - previous.lastAt <= 30 * 60_000
          ? previous.checks + 1
          : 1
        : 0,
    lastAt: nowMs,
  };
}

function loadSupply(): CrawlSupply | null {
  try {
    const value: unknown = JSON.parse(readFileSync(SUPPLY_FILE, "utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const supply = value as Record<string, unknown>;
      if (validCount(supply.checks) && validCount(supply.lastAt)) {
        return supply as CrawlSupply;
      }
    }
  } catch {}
  return null;
}

function saveSupply(supply: CrawlSupply): void {
  mkdirSync(STATE_DIR, { mode: 0o700, recursive: true });
  const temp = `${SUPPLY_FILE}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(supply), { mode: 0o600 });
  renameSync(temp, SUPPLY_FILE);
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
  const supply = advanceCrawlSupply(loadSupply(), snapshot.crawl?.storable ?? null, now.getTime());
  snapshot.crawlZeroChecks = supply.checks;
  saveSupply(supply);
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
