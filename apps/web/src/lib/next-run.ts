import { type CronSchedule } from "@fluncle/registry";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function estimateNextRun(
  lastSeenIso: string,
  cadenceMs: number,
  nowIso: string,
): string | null {
  const lastSeen = new Date(lastSeenIso).getTime();
  const now = new Date(nowIso).getTime();

  if (
    !Number.isFinite(lastSeen) ||
    !Number.isFinite(now) ||
    !Number.isFinite(cadenceMs) ||
    cadenceMs <= 0
  ) {
    return null;
  }

  let next = lastSeen + cadenceMs;

  if (next <= now) {
    const stepsPast = Math.floor((now - next) / cadenceMs) + 1;
    next += stepsPast * cadenceMs;
  }

  return new Date(next).toISOString();
}

function zonedParts(
  utcMs: number,
  tz: string,
): { day: number; hour: number; minute: number; month: number; second: number; year: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone: tz,
    year: "numeric",
  }).formatToParts(new Date(utcMs));
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
  const hour = get("hour");

  return {
    day: get("day"),
    hour: hour === 24 ? 0 : hour,
    minute: get("minute"),
    month: get("month"),
    second: get("second"),
    year: get("year"),
  };
}

function zoneOffsetMs(utcMs: number, tz: string): number {
  const parts = zonedParts(utcMs, tz);
  const asIfUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );

  return Math.round((asIfUtc - utcMs) / MINUTE_MS) * MINUTE_MS;
}

function zonedWallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): number {
  const asIfUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset1 = zoneOffsetMs(asIfUtc, tz);
  const utc = asIfUtc - offset1;
  const offset2 = zoneOffsetMs(utc, tz);

  return offset2 === offset1 ? utc : asIfUtc - offset2;
}

export function nextScheduledRun(schedule: CronSchedule, nowIso: string): string | null {
  const now = new Date(nowIso).getTime();
  const [hour, minute] = schedule.time.split(":").map(Number);

  if (
    hour === undefined ||
    minute === undefined ||
    !Number.isFinite(now) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute)
  ) {
    return null;
  }

  for (let dayOffset = 0; dayOffset <= 8; dayOffset += 1) {
    const cand = zonedParts(now + dayOffset * DAY_MS, schedule.tz);

    if (schedule.weekday !== undefined) {
      const dow = new Date(Date.UTC(cand.year, cand.month - 1, cand.day)).getUTCDay();

      if (dow !== schedule.weekday) {
        continue;
      }
    }

    const fire = zonedWallClockToUtc(cand.year, cand.month, cand.day, hour, minute, schedule.tz);

    if (fire > now) {
      return new Date(fire).toISOString();
    }
  }

  return null;
}

export function formatZonedTime(iso: string, tz: string): string {
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const stamp = new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "short",
    timeZone: tz,
  }).format(date);
  const city = (tz.split("/").pop() ?? tz).replace(/_/g, " ");

  return `${stamp} ${city}`;
}

export function formatCountdown(targetIso: string, nowIso: string): string {
  const ms = new Date(targetIso).getTime() - new Date(nowIso).getTime();

  if (!Number.isFinite(ms) || ms < MINUTE_MS) {
    return "imminent";
  }

  const minutes = Math.floor(ms / MINUTE_MS);

  if (minutes < 60) {
    return `in ${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    return `in ${hours}h`;
  }

  return `in ${Math.floor(hours / 24)}d`;
}

export function formatCadence(cadenceMs: number): string {
  if (!Number.isFinite(cadenceMs) || cadenceMs <= 0) {
    return "";
  }

  if (cadenceMs % DAY_MS === 0) {
    return `${cadenceMs / DAY_MS}d`;
  }

  if (cadenceMs % HOUR_MS === 0) {
    return `${cadenceMs / HOUR_MS}h`;
  }

  return `${Math.max(1, Math.floor(cadenceMs / MINUTE_MS))}m`;
}
