import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type DailyRetryState =
  | "complete"
  | "exhausted"
  | "partial"
  | "pending"
  | "skipped"
  | "started";

function slotDay(date: Date, timeZone: string, primarySlot: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  }).formatToParts(date);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  const day = `${part("year")}-${part("month")}-${part("day")}`;

  if (`${part("hour")}:${part("minute")}` >= primarySlot) {
    return day;
  }

  const prior = new Date(`${day}T00:00:00Z`);
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

  if (summary === null || summary.outcome === "payload-unconfirmed") {
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
}): DailyRetryState {
  const day = slotDay(options.now, options.timeZone, options.primarySlot);
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
  const [job, timeZone, primarySlot, startedAt] = process.argv.slice(2);

  if (
    !job ||
    !/^fluncle-[a-z0-9-]+$/.test(job) ||
    !timeZone ||
    !primarySlot ||
    !/^\d{2}:\d{2}$/.test(primarySlot) ||
    !startedAt ||
    Number.isNaN(Date.parse(startedAt))
  ) {
    process.stderr.write(
      "usage: daily-retry-state.ts fluncle-<job> <timezone> <primary-hour:minute> <started-at-iso>\n",
    );
    process.exit(2);
  }

  try {
    process.stdout.write(
      `${dailyRetryState({
        directory:
          process.env.HEALTHCHECK_CRON_OUTPUT_DIR ??
          join(process.env.HOME ?? "/opt/data/home", "..", "cron", "output"),
        job,
        now: new Date(startedAt),
        primarySlot,
        timeZone,
      })}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
