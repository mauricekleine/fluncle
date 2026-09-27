import { getDb, typedRow } from "./db";

type CounterRow = { count: number };

export async function bumpRateLimitCounter({
  action,
  bucket,
  limit,
  now = Date.now(),
  units = 1,
  windowMs,
}: {
  action: string;
  bucket: string;
  limit: number;
  now?: number;
  units?: number;
  windowMs: number;
}): Promise<number | undefined> {
  if (units < 1 || units > limit) {
    return undefined;
  }
  const db = await getDb();
  const windowStart = new Date(Math.floor(now / windowMs) * windowMs).toISOString();
  const result = await db.execute({
    args: [action, bucket, windowStart, units, units, units, limit],
    sql: `insert into rate_limit_counters (action, bucket, window_start, count)
      values (?, ?, ?, ?)
      on conflict(action, bucket, window_start) do update set count = count + ?
      where count + ? <= ?
      returning count`,
  });
  return typedRow<CounterRow>(result.rows)?.count;
}

export async function readRateLimitCount({
  action,
  bucket,
  now = Date.now(),
  windowMs,
}: {
  action: string;
  bucket: string;
  now?: number;
  windowMs: number;
}): Promise<number> {
  const db = await getDb();
  const windowStart = new Date(Math.floor(now / windowMs) * windowMs).toISOString();
  const result = await db.execute({
    args: [action, bucket, windowStart],
    sql: `select count from rate_limit_counters
          where action = ? and bucket = ? and window_start = ?
          limit 1`,
  });
  return typedRow<CounterRow>(result.rows)?.count ?? 0;
}

const RATE_LIMIT_COUNTER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export async function pruneRateLimitCounters(now = Date.now()): Promise<number> {
  const db = await getDb();
  const cutoff = new Date(now - RATE_LIMIT_COUNTER_RETENTION_MS).toISOString();
  const result = await db.execute({
    args: [cutoff],
    sql: `delete from rate_limit_counters where window_start < ?`,
  });
  return result.rowsAffected;
}
