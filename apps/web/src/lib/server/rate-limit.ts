// The ONE shared rate limiter: a durable, atomic, hard-to-forge check. It avoids DB-backed TOCTOU
// count-then-insert, spoofable x-forwarded-for fallback, user-agent buckets that clients can rotate,
// and per-isolate state that resets on redeploy.
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
//
// The atomic check is never skipped. What a caller may bound is how long it WAITS
// for the check's verdict when its own work costs nothing — see `chargeRateLimit`.

import { waitUntil } from "cloudflare:workers";
import { getDb, typedRow } from "./db";
import { jsonError } from "./env";
import { logEvent } from "./log";
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
  return (await bumpRateLimitCounter({ action, bucket, limit, windowMs })) !== undefined;
}

/**
 * The atomic core itself, returning the counter's NEW VALUE rather than a verdict — `undefined`
 * when the conditional update was a no-op (already at `limit`).
 *
 * `consumeRateLimit` is the one-line verdict wrapper over this, and is what a request path should
 * use. The count matters to exactly one caller: the abuse detector, which needs to know HOW FAR a
 * bucket is into a window to fire a threshold exactly once (identity-envelope.ts). Reading the
 * counter back separately would reopen the read-then-write race this statement exists to close, so
 * the count comes out of the same atomic statement or not at all.
 *
 * `units` is how much this call SPENDS, and it defaults to 1 so every existing caller is unchanged.
 * It exists because one request is not always one unit of work: a batch identity read answers
 * twenty keys and must cost twenty, or a caller could pace themselves under a per-minute dial and
 * still walk the archive twenty times faster than the dial was set for. The whole spend clears or
 * none of it does — a partially-charged batch would refuse work it had already been paid for.
 */
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
  /** The clock the window is aligned against. Injected so a fixed-window test needs no real time. */
  now?: number;
  units?: number;
  windowMs: number;
}): Promise<number | undefined> {
  // A spend wider than the whole window can never fit, and the statement below would open a fresh
  // window ABOVE the cap on the insert path. Refuse it before it can, rather than after.
  if (units < 1 || units > limit) {
    return undefined;
  }

  const db = await getDb();
  // Align the window so every request in the same windowMs slice shares a row.
  const windowStart = new Date(Math.floor(now / windowMs) * windowMs).toISOString();

  // One atomic conditional upsert. The INSERT path opens a new window at the spend.
  // The conflict path bumps the existing counter ONLY while the spend still fits under
  // `limit`; at the cap the `WHERE count + ? <= ?` predicate makes the UPDATE a no-op, so
  // RETURNING yields no row and we know the caller is over the limit. SQLite runs
  // the statement atomically (and libSQL serializes writers), closing the
  // count-then-insert TOCTOU gap. At `units = 1` the predicate is `count + 1 <= limit`,
  // exactly the `count < limit` condition required by the limiter.
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

/**
 * Read a window's counter WITHOUT touching it — the readout half of {@link bumpRateLimitCounter},
 * for a counter that is not only a limiter but a SPEND the operator watches (the Apify anchor row
 * brake, ./anchor-apify.ts). It composes the window key the exact same way the bump does, so a
 * display can never describe a different window than the one being charged.
 *
 * 0 when the window has no row yet — an unopened window has spent nothing.
 */
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

/**
 * HOW LONG A SPENT COUNTER ROW IS KEPT. A fixed-window row is dead the moment its window closes —
 * nothing reads a past window, ever — so this is pure headroom, not retention: long enough that the
 * longest window in use (a day) plus any clock skew is comfortably inside, short enough that the
 * table cannot grow without bound.
 */
const RATE_LIMIT_COUNTER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Delete rate-limit counter rows whose window closed long ago. Nothing in the repo deleted from
 * `rate_limit_counters` before this: every limited request writes a row per (action, bucket,
 * window), so the table only ever grew, and adding a per-IP DAILY dial (identity-envelope.ts) is
 * what made that a real slope rather than a note.
 *
 * ONE cutoff delete, keyed on `window_start` — the same `delete … where <old>` shape the status
 * ledger prunes with. It rides the periodic health snapshot (status.ts) rather than any request
 * path: a maintenance write does not belong on a read a caller is waiting for, and the snapshot is
 * already the repo's home for exactly this kind of upkeep. Returns the row count so a caller can
 * log it.
 */
export async function pruneRateLimitCounters(now = Date.now()): Promise<number> {
  const db = await getDb();
  const cutoff = new Date(now - RATE_LIMIT_COUNTER_RETENTION_MS).toISOString();
  const result = await db.execute({
    args: [cutoff],
    sql: `delete from rate_limit_counters where window_start < ?`,
  });

  return result.rowsAffected;
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

/**
 * How long {@link chargeRateLimit} holds a free answer for the limiter's verdict. The counter upsert
 * is a WRITE on the primary: a healthy one lands in tens of milliseconds, but it queues behind any
 * write holding the database's single write lock (a background batch can hold it for seconds) while
 * reads on the same database keep answering. So the bound only binds while the primary is stalled.
 */
export const RATE_LIMIT_VERDICT_WAIT_MS = 250;

/** A request whose charge has been issued and whose verdict may still be settling. */
export type RateLimitCharge = {
  /** Wait for the verdict, then throw the 429 when it is over the limit. Gate a paid step on this. */
  requireAllowed: () => Promise<void>;
  /**
   * Throw the 429 when the verdict has ALREADY come back over the limit, or rethrow the counter
   * write's failure when that is already known. Never waits.
   */
  throwIfLimited: () => void;
};

type ChargeOutcome = { allowed: boolean } | { error: unknown };

/**
 * Charge the limiter for a request whose work costs no vendor money until one step that does.
 *
 * The charge is the SAME atomic upsert {@link assertRateLimit} issues — same key, same limit, same
 * window, one unit per request — so the count stays exact and a flood is still refused. What differs
 * is how long the caller waits for the verdict:
 *
 *   - The verdict lands inside `verdictWaitMs` (the healthy primary): it is acted on exactly as
 *     `assertRateLimit` acts on it. Over the limit throws the 429 before any work runs, and a failed
 *     write rethrows.
 *   - The verdict is still pending (the primary's write lock is held elsewhere): the caller
 *     proceeds, the write finishes under `waitUntil`, and the handle keeps the verdict authoritative
 *     where it matters. `requireAllowed` in front of the paid step waits for it; `throwIfLimited`
 *     after the free work refuses the answer when the verdict has come back over the limit by then.
 *
 * So the one thing a stalled primary lends an over-limit caller is free work answered while the
 * charge is still being recorded. The paid step never runs on an unknown verdict.
 */
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
  // Never rejects: the outcome is recorded instead, so a write that fails after the caller moved on
  // is an observed fault rather than an unhandled rejection.
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
