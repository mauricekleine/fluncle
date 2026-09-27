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

export const ANCHOR_APIFY_REFUND_ACTION = "anchor_apify_refunds";

export const ANCHOR_APIFY_REFUND_DAILY_ROWS = 10;

export const ANCHOR_APIFY_SPEND_WINDOW_MS = 24 * 60 * 60 * 1000;

export const ANCHOR_APIFY_DEFAULT_DAILY_ROWS = 300;

export function hasUnsettledAnchorPaidReceipt(
  receipt: unknown,
  state: unknown,
  now: Date = new Date(),
): boolean {
  if (typeof receipt !== "string" || !receipt.trim()) {
    return false;
  }
  if (state === "pending") {
    return true;
  }
  if (state === "settled") {
    return false;
  }
  if (state !== null && state !== undefined) {
    return true;
  }
  const receiptMs = Date.parse(receipt);
  return (
    !Number.isFinite(receiptMs) ||
    receiptMs > now.getTime() ||
    now.getTime() - receiptMs <= 2 * 60 * 60 * 1000
  );
}

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

export async function chargeAnchorApifyRowForTrack(
  trackId: string,
  receiptAt: string,
  now: Date = new Date(),
): Promise<{ budget: AnchorApifyBudget; charged: boolean; priorReceiptLive: boolean }> {
  const db = await getDb();
  const dailyRows = await readAnchorApifyDailyRows();
  const windowStart = new Date(
    Math.floor(now.getTime() / ANCHOR_APIFY_SPEND_WINDOW_MS) * ANCHOR_APIFY_SPEND_WINDOW_MS,
  ).toISOString();
  const transaction = await db.transaction("write");
  try {
    const existing = await transaction.execute({
      args: [trackId],
      sql: `select spotify_anchor_paid_admitted_at as receipt,
                   spotify_anchor_paid_state as paid_state
            from tracks where track_id = ? limit 1`,
    });
    const previous = existing.rows[0]?.receipt;
    const previousMs = Date.parse(typeof previous === "string" ? previous : "");
    const pending = hasUnsettledAnchorPaidReceipt(previous, existing.rows[0]?.paid_state, now);
    const sameLiveReceipt =
      previous === receiptAt &&
      pending &&
      Number.isFinite(previousMs) &&
      previousMs <= now.getTime() &&
      now.getTime() - previousMs <= 2 * 60 * 60 * 1000;
    if (pending || previous === receiptAt) {
      const counted = await transaction.execute({
        args: [ANCHOR_APIFY_SPEND_ACTION, ANCHOR_APIFY_SPEND_BUCKET, windowStart],
        sql: `select count from rate_limit_counters
              where action = ? and bucket = ? and window_start = ? limit 1`,
      });
      await transaction.commit();
      return {
        budget: budgetOf(dailyRows, Number(counted.rows[0]?.count ?? 0), now),
        charged: sameLiveReceipt,
        priorReceiptLive: !sameLiveReceipt,
      };
    }
    const result = await transaction.execute({
      args: [
        ANCHOR_APIFY_SPEND_ACTION,
        ANCHOR_APIFY_SPEND_BUCKET,
        windowStart,
        1,
        1,
        dailyRows,
        dailyRows,
      ],
      sql: `insert into rate_limit_counters (action, bucket, window_start, count)
            select ?, ?, ?, ? where ? <= ?
            on conflict(action, bucket, window_start) do update set count = count + 1
            where count + 1 <= ?
            returning count`,
    });
    const count = Number(result.rows[0]?.count ?? Number.NaN);
    if (!Number.isFinite(count)) {
      await transaction.rollback();
      return { budget: await getAnchorApifyBudget(now), charged: false, priorReceiptLive: false };
    }
    const stamped = await transaction.execute({
      args: [receiptAt, now.toISOString(), trackId],
      sql: `update tracks set spotify_anchor_paid_admitted_at = ?,
                             spotify_anchor_paid_charged_at = ?,
                             spotify_anchor_paid_state = 'pending'
            where track_id = ? and spotify_uri is null`,
    });
    if (stamped.rowsAffected !== 1) {
      await transaction.rollback();
      return { budget: await getAnchorApifyBudget(now), charged: false, priorReceiptLive: false };
    }
    await transaction.commit();
    return { budget: budgetOf(dailyRows, count, now), charged: true, priorReceiptLive: false };
  } catch (error) {
    await transaction.rollback();
    logEvent("warn", "anchor.apify-spend-charge-failed", { error });
    return {
      budget: { dailyRows: 0, day: utcDay(now), remainingRows: 0, rowsSent: 0, spent: true },
      charged: false,
      priorReceiptLive: false,
    };
  } finally {
    transaction.close();
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
