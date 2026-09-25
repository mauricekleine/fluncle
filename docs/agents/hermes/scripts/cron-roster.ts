import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export type DerivedCron = {
  cadenceMs: number;

  match: string;

  service: string;

  unit: string;
};

export type TimerReading =
  | { cadenceMs: number; kind: "writer"; match: string; unit: string }
  | { kind: "non-writer"; unit: string }
  | { kind: "unreadable"; problem: string; unit: string };

export type Roster = {
  crons: DerivedCron[];

  nonWriters: string[];

  unreadable: { problem: string; unit: string }[];
};

export const NON_WRITER_TIMERS: Record<string, string> = {
  "fluncle-healthcheck.timer":
    "the prober itself — it self-emits cron.healthcheck; a self-read would be circular",

  "fluncle-secrets-sync.timer":
    "a host-side oneshot outside the container — writes no marker; POSTs its own run-ledger row",

  "fluncle-timer-watchdog.timer":
    "a host-side oneshot outside the container — writes no marker; POSTs its own run-ledger row",

  "pin-watch.timer": "self-posts the `self-deploy` /status row via record_health, not a marker",
};

const SPAN_UNITS_MS: Record<string, number> = {
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  h: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  hr: 3_600_000,
  m: 60_000,
  min: 60_000,
  minute: 60_000,
  minutes: 60_000,
  ms: 1,
  msec: 1,
  s: 1000,
  sec: 1000,
  second: 1000,
  seconds: 1000,
  w: 604_800_000,
  week: 604_800_000,
  weeks: 604_800_000,
};

export function parseTimeSpanMs(raw: string): number | null {
  const text = raw.trim().toLowerCase();

  if (!text) {
    return null;
  }

  const terms = text.match(/\d+(?:\.\d+)?\s*[a-z]*/g);

  if (!terms || terms.join("").replace(/\s+/g, "") !== text.replace(/\s+/g, "")) {
    return null;
  }

  let total = 0;

  for (const term of terms) {
    const parsed = term.match(/^(\d+(?:\.\d+)?)\s*([a-z]*)$/);
    const amount = Number.parseFloat(parsed?.[1] ?? "");
    const suffix = parsed?.[2] ?? "";

    if (!Number.isFinite(amount)) {
      return null;
    }

    const unitMs = suffix === "" ? 1000 : SPAN_UNITS_MS[suffix];

    if (unitMs === undefined) {
      return null;
    }

    total += amount * unitMs;
  }

  return total > 0 ? total : null;
}

const TIMEZONE_TOKEN = /^(?:UTC|[A-Za-z]+\/[A-Za-z_+-]+)$/;
const WEEKDAY_TOKEN =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/;

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

export function parseOnCalendarMs(expression: string): number | null {
  const parts = expression.trim().split(/\s+/).filter(Boolean);

  if (parts.length === 0) {
    return null;
  }

  if (TIMEZONE_TOKEN.test(parts[parts.length - 1] ?? "")) {
    parts.pop();
  }

  const weekday = WEEKDAY_TOKEN.test(parts[0] ?? "") ? parts.shift() : null;
  const timeSpec = parts.pop() ?? "";
  const dateSpec = parts.pop() ?? null;

  if (parts.length > 0) {
    return null;
  }

  if (!weekday && !dateSpec) {
    const step = timeSpec.match(/^\*:0\/(\d+)$/);
    const minutes = Number.parseInt(step?.[1] ?? "", 10);

    if (Number.isFinite(minutes) && minutes > 0 && 60 % minutes === 0) {
      return minutes * 60_000;
    }
  }

  if (!/^\d{1,2}:\d{2}(?::\d{2})?$/.test(timeSpec)) {
    return null;
  }

  if (weekday) {
    return /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?$/.test(weekday) ? WEEK_MS : null;
  }

  if (dateSpec === null || dateSpec === "*-*-*") {
    return DAY_MS;
  }

  return null;
}

function directiveValues(body: string, key: string): string[] {
  const values: string[] = [];

  for (const line of body.split("\n")) {
    const trimmed = line.trim();

    if (trimmed.startsWith("#") || trimmed.startsWith(";")) {
      continue;
    }

    if (trimmed.startsWith(`${key}=`)) {
      values.push(trimmed.slice(key.length + 1).trim());
    }
  }

  return values;
}

export function parseTimerCadenceMs(body: string): number | null {
  const active = directiveValues(body, "OnUnitActiveSec");

  if (active.length === 1) {
    return parseTimeSpanMs(active[0] ?? "");
  }

  if (active.length > 1) {
    return null;
  }

  const calendar = directiveValues(body, "OnCalendar");

  if (calendar.length === 0) {
    return null;
  }

  const periods = calendar.map((value) => parseOnCalendarMs(value));
  const [first] = periods;

  if (first === undefined || first === null) {
    return null;
  }

  return periods.every((period) => period === first) ? first : null;
}

const CONTAINER_SCRIPT_PREFIX = "/opt/hermes-scripts/";

export function emitCronOutputTokens(body: string): string[] {
  const tokens: string[] = [];

  for (const line of body.split("\n")) {
    const trimmed = line.trim();

    if (trimmed.startsWith("#")) {
      continue;
    }

    for (const hit of trimmed.matchAll(/emit_cron_output\s+([A-Za-z0-9_-]+)/g)) {
      const token = hit[1];

      if (token && !tokens.includes(token)) {
        tokens.push(token);
      }
    }
  }

  return tokens;
}

function containerScriptsIn(execStart: string): string[] {
  const names: string[] = [];

  for (const hit of execStart.matchAll(/\/opt\/hermes-scripts\/([A-Za-z0-9_.-]+\.sh)/g)) {
    const name = hit[1];

    if (name && !names.includes(name)) {
      names.push(name);
    }
  }

  return names;
}

export function readTimer(timerPath: string, scriptsDir: string): TimerReading {
  const unit = basename(timerPath);
  const servicePath = timerPath.replace(/\.timer$/, ".service");

  let timerBody: string;

  try {
    timerBody = readFileSync(timerPath, "utf8");
  } catch {
    return { kind: "unreadable", problem: "the timer unit could not be read", unit };
  }

  const cadenceMs = parseTimerCadenceMs(timerBody);

  if (!existsSync(servicePath)) {
    return {
      kind: "unreadable",
      problem: `no ${basename(servicePath)} beside it — nothing says what this timer runs`,
      unit,
    };
  }

  const serviceBody = readFileSync(servicePath, "utf8");
  const execStarts = directiveValues(serviceBody, "ExecStart");

  if (execStarts.length === 0) {
    return { kind: "unreadable", problem: "its service declares no ExecStart", unit };
  }

  const execStart = execStarts.join("\n");
  const tokens = new Set(emitCronOutputTokens(execStart));

  if (tokens.size === 0) {
    for (const scriptName of containerScriptsIn(execStart)) {
      const scriptPath = join(scriptsDir, scriptName);

      if (!existsSync(scriptPath)) {
        return {
          kind: "unreadable",
          problem: `its service execs ${CONTAINER_SCRIPT_PREFIX}${scriptName}, which has no source under scripts/`,
          unit,
        };
      }

      for (const token of emitCronOutputTokens(readFileSync(scriptPath, "utf8"))) {
        tokens.add(token);
      }
    }
  }

  if (tokens.size === 0) {
    return { kind: "non-writer", unit };
  }

  if (tokens.size > 1) {
    return {
      kind: "unreadable",
      problem: `it reaches more than one cron token (${[...tokens].sort().join(", ")})`,
      unit,
    };
  }

  const match = [...tokens][0] ?? "";

  if (cadenceMs === null) {
    return {
      kind: "unreadable",
      problem: "no cadence could be read from its OnUnitActiveSec / OnCalendar",
      unit,
    };
  }

  return { cadenceMs, kind: "writer", match, unit };
}

export function deriveTimerRoster(hermesDir: string): Roster {
  const scriptsDir = join(hermesDir, "scripts");
  const crons: DerivedCron[] = [];
  const nonWriters: string[] = [];
  const unreadable: { problem: string; unit: string }[] = [];

  for (const entry of readdirSync(hermesDir).sort()) {
    const dir = join(hermesDir, entry);

    if (!statSync(dir).isDirectory()) {
      continue;
    }

    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith(".timer") || file.includes("@")) {
        continue;
      }

      const reading = readTimer(join(dir, file), scriptsDir);

      if (reading.kind === "writer") {
        crons.push({
          cadenceMs: reading.cadenceMs,
          match: reading.match,
          service: `cron.${reading.match}`,
          unit: reading.unit,
        });
      } else if (reading.kind === "non-writer") {
        nonWriters.push(reading.unit);
      } else {
        unreadable.push({ problem: reading.problem, unit: reading.unit });
      }
    }
  }

  crons.sort((a, b) => a.service.localeCompare(b.service));
  nonWriters.sort();
  unreadable.sort((a, b) => a.unit.localeCompare(b.unit));

  return { crons, nonWriters, unreadable };
}
