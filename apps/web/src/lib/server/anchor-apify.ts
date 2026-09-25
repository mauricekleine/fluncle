import { getDb } from "./db";
import { markDueWorkSourceMaintenanceFromSelectStatements } from "./due-work";
import { logEvent } from "./log";
import { bumpRateLimitCounter, readRateLimitCount } from "./rate-limit";
import { deleteSetting, getSetting, setSetting } from "./settings";

export const ANCHOR_APIFY_ENABLED_KEY = "anchor_apify_enabled";

export const ANCHOR_APIFY_DISABLED_AT_KEY = "anchor_apify_disabled_at";

export async function isAnchorApifyEnabled(): Promise<boolean> {
  return (await getSetting(ANCHOR_APIFY_ENABLED_KEY)) !== "false";
}

export const ANCHOR_APIFY_DAILY_ROWS_KEY = "anchor_apify_daily_rows";

export const ANCHOR_APIFY_SPEND_ACTION = "anchor_apify_rows";

export const ANCHOR_APIFY_SPEND_BUCKET = "catalogue";

export const ANCHOR_APIFY_SPEND_WINDOW_MS = 24 * 60 * 60 * 1000;

export const ANCHOR_APIFY_DEFAULT_DAILY_ROWS = 300;

export type AnchorApifyBudget = {
  day: string;

  dailyRows: number;

  remainingRows: number;

  rowsSent: number;

  spent: boolean;
};

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

async function readAnchorApifyDailyRows(): Promise<number> {
  const raw = await getSetting(ANCHOR_APIFY_DAILY_ROWS_KEY);
  const parsed = Number(raw);

  return raw !== undefined && Number.isInteger(parsed) && parsed >= 0
    ? parsed
    : ANCHOR_APIFY_DEFAULT_DAILY_ROWS;
}

function budgetOf(dailyRows: number, rowsSent: number, now: Date): AnchorApifyBudget {
  return {
    dailyRows,
    day: utcDay(now),
    remainingRows: Math.max(0, dailyRows - rowsSent),
    rowsSent,
    spent: rowsSent >= dailyRows,
  };
}

export async function getAnchorApifyBudget(now: Date = new Date()): Promise<AnchorApifyBudget> {
  const [dailyRows, rowsSent] = await Promise.all([
    readAnchorApifyDailyRows(),
    readRateLimitCount({
      action: ANCHOR_APIFY_SPEND_ACTION,
      bucket: ANCHOR_APIFY_SPEND_BUCKET,
      now: now.getTime(),
      windowMs: ANCHOR_APIFY_SPEND_WINDOW_MS,
    }),
  ]);

  return budgetOf(dailyRows, rowsSent, now);
}

export async function setAnchorApifyDailyRows(
  dailyRows: number,
  now: Date = new Date(),
): Promise<AnchorApifyBudget> {
  await setSetting(ANCHOR_APIFY_DAILY_ROWS_KEY, String(Math.max(0, Math.trunc(dailyRows))));

  return getAnchorApifyBudget(now);
}

export async function chargeAnchorApifyRow(
  now: Date = new Date(),
): Promise<{ budget: AnchorApifyBudget; charged: boolean }> {
  try {
    const dailyRows = await readAnchorApifyDailyRows();
    const rowsSent = await bumpRateLimitCounter({
      action: ANCHOR_APIFY_SPEND_ACTION,
      bucket: ANCHOR_APIFY_SPEND_BUCKET,
      limit: dailyRows,
      now: now.getTime(),
      windowMs: ANCHOR_APIFY_SPEND_WINDOW_MS,
    });

    if (rowsSent === undefined) {
      return { budget: await getAnchorApifyBudget(now), charged: false };
    }

    return { budget: budgetOf(dailyRows, rowsSent, now), charged: true };
  } catch (error) {
    logEvent("warn", "anchor.apify-spend-charge-failed", { error });

    return {
      budget: { dailyRows: 0, day: utcDay(now), remainingRows: 0, rowsSent: 0, spent: true },
      charged: false,
    };
  }
}

async function requeueOffWindowDeferrals(): Promise<number> {
  const disabledAt = await getSetting(ANCHOR_APIFY_DISABLED_AT_KEY);

  if (!disabledAt) {
    return 0;
  }

  const db = await getDb();
  const selection = {
    args: [disabledAt],
    sql: `select track_id as subject_id from tracks
          where spotify_uri is null
            and spotify_anchor_attempted_at >= ?
            and has_isrc = 1`,
  };
  const results = await db.batch(
    [
      ...markDueWorkSourceMaintenanceFromSelectStatements("track", selection, {
        producer: "anchor-apify-requeue",
      }),
      {
        args: [disabledAt],
        sql: `update tracks
              set spotify_anchor_attempted_at = null
              where spotify_uri is null
                and spotify_anchor_attempted_at >= ?
                and has_isrc = 1`,
      },
    ],
    "write",
  );

  return results.at(-1)?.rowsAffected ?? 0;
}

export async function setAnchorApifyEnabled(enabled: boolean): Promise<number> {
  if (!enabled) {
    await setSetting(ANCHOR_APIFY_ENABLED_KEY, "false");

    if (!(await getSetting(ANCHOR_APIFY_DISABLED_AT_KEY))) {
      await setSetting(ANCHOR_APIFY_DISABLED_AT_KEY, new Date().toISOString());
    }

    return 0;
  }

  await setSetting(ANCHOR_APIFY_ENABLED_KEY, "true");

  const requeued = await requeueOffWindowDeferrals();
  await deleteSetting(ANCHOR_APIFY_DISABLED_AT_KEY);

  return requeued;
}
