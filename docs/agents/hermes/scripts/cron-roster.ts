// cron-roster.ts — DERIVE the expected-writer roster from the committed systemd timer units,
// so the prober's `AUTOMATION_CRONS` stops being a list somebody has to remember to update.
//
// THE PROBLEM THIS EXISTS FOR. `AUTOMATION_CRONS` in fluncle-healthcheck.ts is the set of crons
// the /status prober expects to find markers for, and every entry — the token, the service id,
// the cadence — restates by hand something the repo already states elsewhere: the timer unit.
// Restating drifts. Measured 2026-07-29 against the 45 committed `.timer` units:
//
//   • `fluncle-frontier-refresh` moved from a Friday-07:00 burst to a 15-minute paced drain
//     (its timer says `OnCalendar=*:0/15`; its README explains why), and the prober kept the
//     old weekly cadence. The stale budget is 3x the cadence, so a DEAD frontier-refresh would
//     have read `fresh` on /status for 21 days instead of 45 minutes. `@fluncle/registry`'s
//     probeConfig had already been corrected to 15 min — the prober alone was left behind,
//     which is exactly what a third uncoupled copy of a fact buys you.
//   • `fluncle-timer-watchdog` and `fluncle-secrets-sync` had no entry at all — and, unlike
//     `pin-watch` (which self-posts the `self-deploy` row) and `fluncle-healthcheck` (which
//     self-emits its own), they report to NOTHING. Two of the box's timers were invisible.
//
// AGENTS.md names this exact class for the Cloudflare watch-paths mirror: "the two lists live
// in different places with NOTHING testing that they agree". This module is the something.
//
// WHAT IT DERIVES, AND FROM WHAT. For every `<dir>/*.timer` beside docs/agents/hermes/:
//
//   1. the paired `<dir>/<same-name>.service` gives the `ExecStart=` line;
//   2. the cron TOKEN is the argument of the `emit_cron_output <token>` call that ExecStart
//      reaches — either written inline in the unit (the render conductor does this) or in the
//      `/opt/hermes-scripts/<name>.sh` sweep the unit `docker exec`s, whose source of truth is
//      `docs/agents/hermes/scripts/<name>.sh` in this very directory;
//   3. the service id is `cron.<token>` — the same id `cron-output.sh` bakes into the marker's
//      `# Cron Job: fluncle-<token>` header and the prober's `match` claims;
//   4. the CADENCE comes off the timer's own `OnUnitActiveSec=` or `OnCalendar=`. Never
//      `OnBootSec=`, which is the FIRST fire and not a period.
//
// A timer whose ExecStart reaches no `emit_cron_output` call writes no marker and so cannot be
// probed this way. Those are declared in NON_WRITER_TIMERS with a reason each, and the guard
// checks that list in BOTH directions — an undeclared non-writer fails the build, and so does a
// declaration for a timer that turns out to write after all. An exemption list is precisely the
// hand-kept thing that rots, so it gets its own tripwire.
//
// NOTHING HERE GUESSES. An unreadable cadence, an ambiguous token, a `.timer` with no `.service`
// beside it: each lands in its own bucket and fails the guard by name. That is the same posture
// docs/vector-serving.md ratified for the sonar filter — an unknown field is REJECTED, so a
// version skew degrades loudly instead of silently widening.
//
// SCOPE: rave-02's roster only. The rave-01 self-deploys (apps/sonar/deploy,
// apps/ssh/deploy) are systemd timers too, but they POST their own `/status` row via
// `record_health` rather than writing a marker a prober reads, so they are not expected
// writers and are not derived here.
//
// WHY THIS IS A BUILD-TIME GUARD RATHER THAN THE PROBER'S RUNTIME SOURCE. The prober is
// deployed standalone: the Dockerfile bakes `docs/agents/hermes/scripts/` to
// /opt/hermes-scripts/ and NOTHING else, while the timer units are laid down on the HOST
// (/etc/systemd/system, by install-host-timers.sh) and never enter the container. So the box
// cannot read a unit file at tick time, and `AUTOMATION_CRONS` has to stay a literal the prober
// carries. cron-roster.test.ts fails the build the moment that literal disagrees with the
// units. (This module rides the image as inert dead weight — it exports pure functions and runs
// nothing at import time — so a bake that includes it costs nothing.)
//
// The sibling guard over the same directory tree is install-host-timers.test.ts, which asks a
// different question: does the INSTALLER lay every unit down? This one asks: does every unit it
// lays down actually get WATCHED?

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

/** One cron the units say SHOULD be writing markers. Shape-compatible with the prober's CronDef. */
export type DerivedCron = {
  /** Stale-budget input: how often the timer says this sweep fires. */
  cadenceMs: number;
  /** The bare `emit_cron_output` token — the prober's `match`. */
  match: string;
  /** The registry surface id the prober emits — always `cron.<match>`. */
  service: string;
  /** The unit that fires it, e.g. `fluncle-enrich.timer`. */
  unit: string;
};

/** What one timer resolved to, including the ways it can fail to resolve. */
export type TimerReading =
  | { cadenceMs: number; kind: "writer"; match: string; unit: string }
  | { kind: "non-writer"; unit: string }
  | { kind: "unreadable"; problem: string; unit: string };

export type Roster = {
  /** Derived expected writers, sorted by service id. */
  crons: DerivedCron[];
  /** Timers that reach no `emit_cron_output` call, sorted. */
  nonWriters: string[];
  /** Timers this module refused to interpret — always a guard failure, never a guess. */
  unreadable: { problem: string; unit: string }[];
};

// ---------------------------------------------------------------------------
// The declared non-writers. A timer here fires something that writes NO cron-output marker,
// so `judgeCron` could only ever read it as "no runs yet" and then — once the box's uptime
// passes the stale budget — as a permanent, lying `lagging`. Listing one is a RULING that its
// silence is intended; the guard enforces that the ruling is still true.
// ---------------------------------------------------------------------------

export const NON_WRITER_TIMERS: Record<string, string> = {
  // The prober itself. It emits its own `cron.healthcheck` row self-evidently (reaching the
  // end of a tick IS the proof it ran); reading a marker it wrote would be circular.
  "fluncle-healthcheck.timer":
    "the prober itself — it self-emits cron.healthcheck; a self-read would be circular",
  // Runs on the HOST as a root oneshot outside the container, so it never sources
  // cron-output.sh. GAP, deliberately recorded: it posts to nothing at all, so a secrets sync
  // that has been failing for a week is invisible on /status. Closing it needs a
  // `@fluncle/registry` cron surface (packages/), which is outside this slice.
  "fluncle-secrets-sync.timer":
    "a host-side oneshot outside the container — writes no marker, and today reports nowhere",
  // Same shape as secrets-sync: a root host oneshot. GAP, deliberately recorded — and a
  // sharper one, because a watchdog that reports nothing is the blind-detector case this whole
  // roster exists to stop. Same blocker: a new row needs a registry surface.
  "fluncle-timer-watchdog.timer":
    "a host-side oneshot outside the container — writes no marker, and today reports nowhere",
  // The box's self-deploy. Writes no marker, but is NOT invisible: rebuild-hermes.sh POSTs the
  // `self-deploy` row to record_health directly, which is why /status carries it.
  "pin-watch.timer": "self-posts the `self-deploy` /status row via record_health, not a marker",
};

// ---------------------------------------------------------------------------
// systemd time-span parsing.
// ---------------------------------------------------------------------------

/** systemd's time-span suffixes, in ms. Months/years are deliberately absent: their length is
 *  ambiguous and no unit here uses one, so meeting one should fail loudly. */
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

/**
 * A systemd time span (`5min`, `1h`, `24h`, `30s`, `1h 30min`) in ms, or null if any part of it
 * is not understood. A bare number is SECONDS, matching systemd's own default.
 */
export function parseTimeSpanMs(raw: string): number | null {
  const text = raw.trim().toLowerCase();

  if (!text) {
    return null;
  }

  // Each term is a number plus an optional suffix; systemd allows them run together or spaced.
  const terms = text.match(/\d+(?:\.\d+)?\s*[a-z]*/g);

  if (!terms || terms.join("").replace(/\s+/g, "") !== text.replace(/\s+/g, "")) {
    return null; // leftover junk between the terms — refuse to interpret it
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

/** The timezone token systemd allows at the end of an OnCalendar expression (`UTC`, `Europe/Amsterdam`). */
const TIMEZONE_TOKEN = /^(?:UTC|[A-Za-z]+\/[A-Za-z_+-]+)$/;
const WEEKDAY_TOKEN =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/;

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/**
 * The PERIOD an `OnCalendar=` expression repeats on, in ms — or null when the shape is one this
 * module has not been taught. Only the three shapes the repo actually uses are understood, on
 * purpose: an unrecognised calendar spec must fail the guard by name rather than be rounded to
 * something plausible, because the number it produces becomes a staleness budget.
 *
 *   `*:0/15`                        → every 15 minutes (an hour-wildcard minute step)
 *   `*-*-* 03:00:00 Europe/…`       → daily at a fixed clock time
 *   `Fri 15:00 Europe/…`            → weekly on one weekday
 */
export function parseOnCalendarMs(expression: string): number | null {
  const parts = expression.trim().split(/\s+/).filter(Boolean);

  if (parts.length === 0) {
    return null;
  }

  // A trailing timezone is presentation, not period.
  if (TIMEZONE_TOKEN.test(parts[parts.length - 1] ?? "")) {
    parts.pop();
  }

  const weekday = WEEKDAY_TOKEN.test(parts[0] ?? "") ? parts.shift() : null;
  const timeSpec = parts.pop() ?? "";
  const dateSpec = parts.pop() ?? null;

  if (parts.length > 0) {
    return null; // more tokens than the grammar above allows
  }

  // `*:0/N` — every N minutes, every hour. Only the `0/` origin is accepted: a different
  // origin (`7/20`) does not divide the hour evenly and its period is not one number.
  if (!weekday && !dateSpec) {
    const step = timeSpec.match(/^\*:0\/(\d+)$/);
    const minutes = Number.parseInt(step?.[1] ?? "", 10);

    if (Number.isFinite(minutes) && minutes > 0 && 60 % minutes === 0) {
      return minutes * 60_000;
    }
  }

  // A fixed clock time — `HH:MM` or `HH:MM:SS`, nothing wildcarded inside it.
  if (!/^\d{1,2}:\d{2}(?::\d{2})?$/.test(timeSpec)) {
    return null;
  }

  if (weekday) {
    // One weekday, one clock time. A LIST or a RANGE (`Mon,Thu`, `Mon..Fri`) is a different
    // period, so it is refused rather than read as weekly.
    return /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?$/.test(weekday) ? WEEK_MS : null;
  }

  // No weekday: daily, provided the date half is fully wildcarded (or simply absent).
  if (dateSpec === null || dateSpec === "*-*-*") {
    return DAY_MS;
  }

  return null;
}

/** Every `Key=value` for one directive in a unit body, in file order. */
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

/**
 * The cadence a `.timer` body declares, in ms.
 *
 * `OnUnitActiveSec=` is the repeating period and wins when present; `OnCalendar=` is read only
 * in its absence. `OnBootSec=` is deliberately never consulted — it is the FIRST fire, and
 * reading it as a period is how a 30-second boot offset would become a 30-second staleness
 * budget for a sweep that actually runs every minute.
 */
export function parseTimerCadenceMs(body: string): number | null {
  const active = directiveValues(body, "OnUnitActiveSec");

  if (active.length === 1) {
    return parseTimeSpanMs(active[0] ?? "");
  }

  if (active.length > 1) {
    return null; // several periods — ambiguous, so refuse
  }

  const calendar = directiveValues(body, "OnCalendar");

  if (calendar.length === 1) {
    return parseOnCalendarMs(calendar[0] ?? "");
  }

  return null;
}

// ---------------------------------------------------------------------------
// Token resolution: which `emit_cron_output <token>` does a unit's ExecStart reach?
// ---------------------------------------------------------------------------

/** The in-container prefix every baked sweep script is exec'd from. */
const CONTAINER_SCRIPT_PREFIX = "/opt/hermes-scripts/";

/**
 * Every `emit_cron_output <token>` CALL in a shell body, ignoring comment lines (the helper's
 * own usage block is a comment, and a documented example must never be mistaken for a call).
 */
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

/** Every `/opt/hermes-scripts/<name>.sh` an ExecStart line references, in order. */
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

/**
 * Read one timer: its cadence, and the cron token its paired service reaches.
 *
 * `scriptsDir` is where the baked `/opt/hermes-scripts/*.sh` sources live in the repo
 * (docs/agents/hermes/scripts). The lookup deliberately runs INLINE-FIRST: the render
 * conductor's unit writes `emit_cron_output render --` in the ExecStart itself and also
 * mentions cron-output.sh on the same line, so resolving scripts first would have to
 * disambiguate two candidates where the unit already answered the question.
 */
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

/**
 * The whole roster, derived from the committed units under `hermesDir`.
 *
 * Template units (`name@.timer`) are skipped for the same reason install-host-timers.sh skips
 * them: they are instantiated on demand by an `OnFailure=` and never enabled, so nothing
 * schedules them and nothing should expect their output.
 */
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
