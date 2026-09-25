import { waitUntil } from "cloudflare:workers";
import { getDb, typedRow } from "./db";
import { jsonError } from "./env";
import { logEvent } from "./log";
import { hashRequestPart } from "./public-auth";
import { ApiError } from "./spotify";

type CounterRow = { count: number };

export function rateLimitBucket(request: Request, userId?: string): string {
  if (userId) {
    return userId;
  }

  const ipHash = hashRequestPart(request.headers.get("cf-connecting-ip"));

  return ipHash ?? "unknown";
}

export async function consumeRateLimit({
  action,
  bucket,
  limit,
  windowMs,
}: {
  action: string;
  bucket: string;
  limit: number;
  windowMs: number;
}): Promise<boolean> {
  return (await bumpRateLimitCounter({ action, bucket, limit, windowMs })) !== undefined;
}

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

export async function enforceRateLimit({
  action,
  limit,
  request,
  userId,
  windowMs,
}: {
  action: string;
  limit: number;
  request: Request;
  userId?: string;
  windowMs: number;
}): Promise<Response | undefined> {
  const bucket = rateLimitBucket(request, userId);
  const allowed = await consumeRateLimit({ action, bucket, limit, windowMs });

  if (!allowed) {
    return jsonError(429, "rate_limited", "Too many requests. Try again later.");
  }

  return undefined;
}

export async function assertRateLimit({
  action,
  limit,
  message = "Too many requests. Try again later.",
  request,
  userId,
  windowMs,
}: {
  action: string;
  limit: number;
  message?: string;
  request: Request;
  userId?: string;
  windowMs: number;
}): Promise<void> {
  const bucket = rateLimitBucket(request, userId);
  const allowed = await consumeRateLimit({ action, bucket, limit, windowMs });

  if (!allowed) {
    throw new ApiError("rate_limited", message, 429);
  }
}

export const RATE_LIMIT_VERDICT_WAIT_MS = 250;

export type RateLimitCharge = {
  requireAllowed: () => Promise<void>;
  throwIfLimited: () => void;
};

type ChargeOutcome = { allowed: boolean } | { error: unknown };

export async function chargeRateLimit({
  action,
  limit,
  message = "Too many requests. Try again later.",
  request,
  userId,
  verdictWaitMs = RATE_LIMIT_VERDICT_WAIT_MS,
  windowMs,
}: {
  action: string;
  limit: number;
  message?: string;
  request: Request;
  userId?: string;
  verdictWaitMs?: number;
  windowMs: number;
}): Promise<RateLimitCharge> {
  const bucket = rateLimitBucket(request, userId);
  let outcome: ChargeOutcome | undefined;
  const settled = consumeRateLimit({ action, bucket, limit, windowMs }).then(
    (allowed) => {
      outcome = { allowed };
    },
    (error: unknown) => {
      outcome = { error };
    },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;

  await Promise.race([
    settled,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, verdictWaitMs);
    }),
  ]);
  clearTimeout(timer);

  const throwIfLimited = () => {
    if (outcome === undefined) {
      return;
    }

    if ("error" in outcome) {
      throw outcome.error;
    }

    if (!outcome.allowed) {
      throw new ApiError("rate_limited", message, 429);
    }
  };

  throwIfLimited();

  if (outcome === undefined) {
    waitUntil(
      settled.then(() => {
        if (outcome && "error" in outcome) {
          logEvent("error", "rate-limit.charge-failed", { action, error: outcome.error });
        }
      }),
    );
  }

  return {
    requireAllowed: async () => {
      await settled;
      throwIfLimited();
    },
    throwIfLimited,
  };
}
