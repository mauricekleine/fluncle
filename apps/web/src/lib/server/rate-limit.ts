// The ONE shared rate limiter. Collapses three weaker limiters that used to
// live in account-data.ts (DB-backed, but TOCTOU count-then-insert + a spoofable
// x-forwarded-for fallback), submissions.ts (DB count keyed on `${ip}:${ua}` —
// rotate the UA to bypass), and newsletter.ts (a per-isolate in-memory array
// that resets on every redeploy — effectively no limit) into one durable,
// atomic, hard-to-forge check.
//
// THREE invariants, one per deepsec finding:
//
//   1. One trustworthy key. On Cloudflare the only non-forgeable client IP is
//      `cf-connecting-ip` (the edge sets it; the client cannot). The bucket is
//      `userId` when authenticated, else `hash(cf-connecting-ip)`. There is NO
//      x-forwarded-for fallback (spoofable) and the User-Agent is NEVER part of
//      the key (rotating it must not grant a fresh allowance).
//
//   2. One atomic check. A single conditional upsert against a fixed-window
//      counter row: the INSERT seeds count=1 for a new window; the
//      `ON CONFLICT … DO UPDATE SET count = count + 1 WHERE count < :max`
//      increments only while under the cap. SQLite executes the statement
//      atomically and libSQL serializes writes, so two concurrent requests at
//      the boundary cannot both pass — the loser's UPDATE is skipped (no row
//      returned by RETURNING) and it is limited. No read-then-write window.
//
//   3. One durable store. Always the DB (`rate_limit_counters`), never
//      per-isolate memory.

import { getDb, typedRow } from "./db";
import { jsonError } from "./env";
import { hashRequestPart } from "./public-auth";
import { ApiError } from "./spotify";

type CounterRow = { count: number };

/**
 * Derive the rate-limit bucket for a request. Authenticated callers key on their
 * stable `userId`; anonymous callers key on `hash(cf-connecting-ip)` — the only
 * client IP header Cloudflare won't let the client forge. We deliberately do NOT
 * fall back to `x-forwarded-for` (a caller can set it to any value) and we never
 * mix in the User-Agent (rotating it must not reset the window). When neither a
 * user nor a trustworthy IP is present the bucket is the literal `"unknown"`, so
 * every header-less / IP-less caller shares one window rather than each getting a
 * private one.
 */
export function rateLimitBucket(request: Request, userId?: string): string {
  if (userId) {
    return userId;
  }

  const ipHash = hashRequestPart(request.headers.get("cf-connecting-ip"));

  return ipHash ?? "unknown";
}

/**
 * The atomic core: increment the fixed-window counter for `(action, bucket)` and
 * return whether the request is within `limit`. A single statement does the whole
 * check, so it is race-free under concurrency.
 *
 * Returns `true` when the request is ALLOWED (the counter was incremented to a
 * value `<= limit`), `false` when it is over the limit.
 */
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
  const db = await getDb();
  // Align the window so every request in the same windowMs slice shares a row.
  const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs).toISOString();

  // One atomic conditional upsert. The INSERT path opens a new window at count=1.
  // The conflict path bumps the existing counter ONLY while it is below `limit`;
  // at the cap the `WHERE count < ?` predicate makes the UPDATE a no-op, so
  // RETURNING yields no row and we know the caller is over the limit. SQLite runs
  // the statement atomically (and libSQL serializes writers), closing the
  // count-then-insert TOCTOU gap the old limiters had.
  const result = await db.execute({
    args: [action, bucket, windowStart, limit],
    sql: `insert into rate_limit_counters (action, bucket, window_start, count)
      values (?, ?, ?, 1)
      on conflict(action, bucket, window_start) do update set count = count + 1
      where count < ?
      returning count`,
  });

  return typedRow<CounterRow>(result.rows) !== undefined;
}

/**
 * Enforce a per-action limit for a request, deriving the bucket from
 * `cf-connecting-ip`/`userId`. Returns a 429 `Response` when the caller is over
 * the limit, or `undefined` when the request may proceed. This is the form the
 * `/me` mutation preamble and the account/auth handlers use (they already deal in
 * guard `Response`s).
 */
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

/**
 * Enforce a per-action limit and THROW an `ApiError` (429, `rate_limited`) when
 * over — the form the submission / newsletter / search flows use, since they
 * surface failures as thrown `ApiError`s that the oRPC rails reshape into the
 * legacy `jsonError` body. `message` lets a flow keep its own copy (e.g. the
 * submission "Too many submissions from this connection." line) byte-for-byte.
 */
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
