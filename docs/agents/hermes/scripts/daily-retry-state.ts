import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type DailyRetryState =
  | "complete"
  | "exhausted"
  | "off-cycle"
  | "partial"
  | "pending"
  | "skipped"
  | "started";

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export type Weekday = (typeof WEEKDAYS)[number];

export const RERUN_SAFE_JOBS: ReadonlySet<string> = new Set([
  "fluncle-backup",
  "fluncle-cluster",
  "fluncle-demand",
  "fluncle-funnel-snapshot",
  "fluncle-label-releases",
  "fluncle-label-triage",
  "fluncle-logbook",
  "fluncle-newsletter",
  "fluncle-reach",
  "fluncle-reconcile-hub-counts",
  "fluncle-social-metrics",
]);

export type DailyRetrySchedule = Readonly<{
  finalSlot: string;
  primarySlot: string;
  timeZone: string;
  weekday?: Weekday;
}>;

const amsterdam = (primarySlot: string, finalSlot: string, weekday?: Weekday) => ({
  finalSlot,
  primarySlot,
  timeZone: "Europe/Amsterdam",
  ...(weekday === undefined ? {} : { weekday }),
});

export const DAILY_RETRY_SCHEDULES: Readonly<Record<string, DailyRetrySchedule>> = {
  "fluncle-audit": amsterdam("01:00", "03:10"),
  "fluncle-audit-review": amsterdam("05:00", "06:20"),
  "fluncle-backup": amsterdam("03:00", "05:20"),
  "fluncle-cluster": amsterdam("03:20", "04:30"),
  "fluncle-demand": amsterdam("04:40", "05:50"),
  "fluncle-funnel-snapshot": { finalSlot: "23:57", primarySlot: "23:45", timeZone: "UTC" },
  "fluncle-label-releases": amsterdam("07:20", "08:20"),
  "fluncle-label-triage": amsterdam("06:40", "07:50"),
  "fluncle-logbook": amsterdam("00:40", "01:50"),
  "fluncle-newsletter": amsterdam("15:00", "16:15", "Fri"),
  "fluncle-reach": amsterdam("04:00", "05:10"),
  "fluncle-reconcile-hub-counts": amsterdam("04:10", "05:25"),
  "fluncle-sentry-triage": amsterdam("03:30", "05:40"),
  "fluncle-social-metrics": { finalSlot: "23:30", primarySlot: "22:15", timeZone: "UTC" },
};

export const DAILY_RETRY_COMPLETION_GRACE_MINUTES = 120;

function minutesOf(slot: string): number {
  return Number(slot.slice(0, 2)) * 60 + Number(slot.slice(3, 5));
}

export function expectedCompletedSlotDay(schedule: DailyRetrySchedule, now: Date): string | null {
  const local = localParts(now, schedule.timeZone);
  const elapsedToday = minutesOf(local.time);
  const owedAfter = minutesOf(schedule.finalSlot) + DAILY_RETRY_COMPLETION_GRACE_MINUTES;

  for (let back = 0; back <= 8; back += 1) {
    const day = new Date(`${local.day}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() - back);
    if (schedule.weekday !== undefined && WEEKDAYS[day.getUTCDay()] !== schedule.weekday) {
      continue;
    }
    if (elapsedToday + back * 1440 >= owedAfter) {
      return day.toISOString().slice(0, 10);
    }
  }

  return null;
}

export function slotDayCompleted(options: {
  day: string;
  directory: string;
  job: string;
  schedule: DailyRetrySchedule;
}): boolean {
  const state = dailyRetryState({
    day: options.day,
    directory: options.directory,
    job: options.job,
    now: new Date(),
    primarySlot: options.schedule.primarySlot,
    timeZone: options.schedule.timeZone,
  });

  return state === "complete" || state === "started";
}

function localParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    timeZone,
    weekday: "short",
    year: "numeric",
  }).formatToParts(date);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";

  return {
    day: `${part("year")}-${part("month")}-${part("day")}`,
    time: `${part("hour")}:${part("minute")}`,
    weekday: part("weekday"),
  };
}

export function offCycle(
  date: Date,
  timeZone: string,
  primarySlot: string,
  weekday: Weekday | undefined,
): boolean {
  if (weekday === undefined) {
    return false;
  }
  const local = localParts(date, timeZone);

  return local.weekday !== weekday || local.time < primarySlot;
}

function slotDay(date: Date, timeZone: string, primarySlot: string): string {
  const local = localParts(date, timeZone);

  if (local.time >= primarySlot) {
    return local.day;
  }

  const prior = new Date(`${local.day}T00:00:00Z`);
  prior.setUTCDate(prior.getUTCDate() - 1);

  return prior.toISOString().slice(0, 10);
}

function summaryFromMarker(marker: string): Record<string, unknown> | null {
  const output = marker.split("<!-- fluncle-cron-output: stderr tail -->", 1)[0] ?? "";

  for (const line of output.split("\n").reverse()) {
    if (!line.startsWith("{")) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(line);

      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {}
  }

  return null;
}

function backupComplete(summary: Record<string, unknown>, day: string): boolean {
  const boxState = summary.boxState;

  return (
    summary.ok === true &&
    summary.dailyKey === `db-backups/daily/${day}/fluncle.sql.gz` &&
    boxState !== null &&
    typeof boxState === "object" &&
    !Array.isArray(boxState) &&
    typeof (boxState as Record<string, unknown>).key === "string" &&
    (boxState as Record<string, unknown>).key === `box-state/daily/${day}/box-state.tar.gz.enc`
  );
}

function noPayloadAdmissionPause(job: string, summary: Record<string, unknown>): boolean {
  return (
    job === "fluncle-reconcile-hub-counts" &&
    summary.admissionOutcome === "phase-yielded" &&
    summary.gateState === "paused" &&
    summary.reason === "database_admission" &&
    summary.windows === 0 &&
    summary.checked === 0 &&
    summary.produced === 0 &&
    summary.partial === true
  );
}

function markerOutcome(
  summary: Record<string, unknown> | null,
  job: string,
  day: string,
): "complete" | "partial" | "skipped" | "started" {
  if (
    summary?.gateState === "admission-skipped" ||
    summary?.payloadStarted === false ||
    (summary !== null && noPayloadAdmissionPause(job, summary))
  ) {
    return "skipped";
  }

  if (summary?.outcome === "payload-unconfirmed") {
    return RERUN_SAFE_JOBS.has(job) ? "partial" : "started";
  }

  if (summary === null) {
    return "started";
  }

  if (job === "fluncle-backup") {
    if (backupComplete(summary, day)) {
      return "complete";
    }
    return summary.dailyKey === `db-backups/daily/${day}/fluncle.sql.gz` && summary.ok === false
      ? "partial"
      : "started";
  }

  if (
    (job === "fluncle-funnel-snapshot" || job === "fluncle-social-metrics") &&
    summary.ok === true &&
    summary.day !== day &&
    !(Array.isArray(summary.backfilledDays) && summary.backfilledDays.includes(day))
  ) {
    return "partial";
  }

  return "started";
}

export function dailyRetryState(options: {
  directory: string;
  job: string;
  now: Date;
  primarySlot: string;
  timeZone: string;
  weekday?: Weekday;
  day?: string;
}): DailyRetryState {
  if (
    options.day === undefined &&
    offCycle(options.now, options.timeZone, options.primarySlot, options.weekday)
  ) {
    return "off-cycle";
  }
  const day = options.day ?? slotDay(options.now, options.timeZone, options.primarySlot);
  const markerDirectory = join(options.directory, options.job);
  let names: string[];

  try {
    names = readdirSync(markerDirectory).filter((name) => name.endsWith(".md"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return "pending";
    }
    throw error;
  }

  let partial = false;
  let skipped = false;
  let retryableAttempts = 0;

  for (const name of names) {
    const path = join(markerDirectory, name);
    let marker: string;
    let modified: Date;

    try {
      modified = statSync(path).mtime;
      if (slotDay(modified, options.timeZone, options.primarySlot) !== day) {
        continue;
      }
      marker = readFileSync(path, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }

    const outcome = markerOutcome(summaryFromMarker(marker), options.job, day);

    if (outcome === "skipped") {
      skipped = true;
      retryableAttempts += 1;
      continue;
    }

    if (outcome === "partial") {
      partial = true;
      retryableAttempts += 1;
      continue;
    }

    return outcome;
  }

  return retryableAttempts >= 2
    ? "exhausted"
    : partial
      ? "partial"
      : skipped
        ? "skipped"
        : "pending";
}

if (import.meta.main) {
  const [job, timeZone, primarySlot, startedAt, weekdayArgument] = process.argv.slice(2);
  const weekday = WEEKDAYS.find((candidate) => candidate === weekdayArgument);

  if (
    !job ||
    !/^fluncle-[a-z0-9-]+$/.test(job) ||
    !timeZone ||
    !primarySlot ||
    !/^\d{2}:\d{2}$/.test(primarySlot) ||
    !startedAt ||
    Number.isNaN(Date.parse(startedAt)) ||
    (weekdayArgument !== undefined && weekday === undefined)
  ) {
    process.stderr.write(
      "usage: daily-retry-state.ts fluncle-<job> <timezone> <primary-hour:minute> <started-at-iso> [Mon|Tue|Wed|Thu|Fri|Sat|Sun]\n",
    );
    process.exit(2);
  }

  try {
    const now = new Date(startedAt);
    process.stdout.write(
      `${slotDay(now, timeZone, primarySlot)} ${dailyRetryState({
        directory:
          process.env.HEALTHCHECK_CRON_OUTPUT_DIR ??
          join(process.env.HOME ?? "/opt/data/home", "..", "cron", "output"),
        job,
        now,
        primarySlot,
        timeZone,
        ...(weekday === undefined ? {} : { weekday }),
      })}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
