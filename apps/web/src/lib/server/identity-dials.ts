// THE IDENTITY-READ DIALS + THE ABUSE ALERT (RFC dnb-identity-graph, ruling 8).
//
// The identity envelope hands out a cross-identifier mapping — this recording is this Spotify link
// is this MusicBrainz id is this ISRC — and that is the one read on the whole public surface whose
// VALUE to a scraper is the aggregate rather than the row. So it is the one read that carries a
// dial, and the plain `GET /tracks/{idOrLogId}` read beside it stays unmetered exactly as it is
// today: nothing about a single finding's DTO changed, and metering it would tax the app's own
// pages for a threat that does not live there.
//
// TWO dials, not one, because they answer different questions. The per-minute burst stops a script
// from turning one IP into a firehose; the per-day ceiling stops the same script from simply
// pacing itself and walking the whole archive over a week. A single dial can do one or the other.
//
// The bucket is the shared limiter's non-forgeable one: `cf-connecting-ip` hashed (the edge sets
// it, the client cannot), or the signed-in user id. There is no `x-forwarded-for` fallback and the
// User-Agent is never in the key, so rotating either buys nothing.
//
// ── THE ALERT IS THE POINT ────────────────────────────────────────────────────────────────────
// A dial that nobody watches is a dial that silently absorbs an attack and tells the operator
// afterwards, in a bill. So a sustained run of REFUSALS raises an alarm through Sentry, the channel
// the operator already watches for this app.
//
// Detecting "sustained" needs its own counter, and the reason is subtle: the limiter's atomic
// upsert STOPS incrementing at the cap (`where count < ?`), so a bucket sitting at 1,000 looks
// exactly like a bucket that stopped knocking. The refusals themselves are therefore counted, in
// their own action row with a far higher ceiling, and the alert fires on the count crossing a named
// threshold — exactly once per window, on the equality, so a determined caller raises one alarm and
// not ten thousand.

import * as Sentry from "@sentry/cloudflare";
import { bumpRateLimitCounter, rateLimitBucket } from "./rate-limit";
import { logEvent } from "./log";
import { ApiError } from "./spotify";

/** The burst dial: requests per minute per bucket. */
export const IDENTITY_BURST_LIMIT = 30;
export const IDENTITY_BURST_WINDOW_MS = 60 * 1000;

/** The ceiling: requests per day per bucket. */
export const IDENTITY_DAILY_LIMIT = 1000;
export const IDENTITY_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The two counter action names. Distinct rows, distinct windows, one shared bucket. */
export const IDENTITY_BURST_ACTION = "get_track_identity_burst";
export const IDENTITY_DAILY_ACTION = "get_track_identity_daily";

/** The refusal ledger's action name — the only thing that counts past a cap. */
export const IDENTITY_BLOCKED_ACTION = "get_track_identity_blocked";

/**
 * HOW MANY REFUSALS IN A DAY RAISE THE ALARM. One refusal is a caller finding the edge; a hundred
 * is a caller that has been told no a hundred times and kept going, which is the shape of a harvest
 * rather than a mistake. Set well above the burst dial so a single enthusiastic minute cannot reach
 * it, and well below anything a real integrator would ever accumulate.
 */
export const IDENTITY_ABUSE_ALERT_AT = 100;

/**
 * The refusal ledger's own ceiling. It exists only so the counting statement stays bounded; it is
 * an order of magnitude past the alert threshold, so the alert always fires before the ledger stops
 * counting.
 */
const IDENTITY_BLOCKED_LEDGER_MAX = IDENTITY_ABUSE_ALERT_AT * 100;

/**
 * Count one refusal and, on crossing {@link IDENTITY_ABUSE_ALERT_AT}, raise the alarm. Exported for
 * its own test: a detector nobody has watched fire is a detector nobody knows works, so the suite
 * drives a synthetic run of refusals through this and asserts the alert lands, exactly once.
 *
 * Best-effort by construction — the caller is already being refused, and a bookkeeping failure must
 * never turn a clean 429 into a 500.
 */
export async function noteIdentityReadBlocked(bucket: string): Promise<void> {
  try {
    const blocked = await bumpRateLimitCounter({
      action: IDENTITY_BLOCKED_ACTION,
      bucket,
      limit: IDENTITY_BLOCKED_LEDGER_MAX,
      windowMs: IDENTITY_DAILY_WINDOW_MS,
    });

    // ON THE EQUALITY, not `>=`: the counter passes each value once, so this raises exactly one
    // alarm per bucket per day no matter how long the caller keeps knocking.
    if (blocked !== IDENTITY_ABUSE_ALERT_AT) {
      return;
    }

    // The bucket is a HASH of the client IP (or a user id), never the address itself — enough to
    // tell one caller from another in the alert, and not a new place Fluncle stores an IP.
    logEvent("warn", "identity.abuse-suspected", {
      blocked,
      bucket,
      threshold: IDENTITY_ABUSE_ALERT_AT,
    });

    Sentry.captureMessage(
      `Identity reads refused ${IDENTITY_ABUSE_ALERT_AT} times in a day for one caller`,
      { level: "warning", tags: { bucket, source: "identity.abuse" } },
    );
  } catch (error) {
    logEvent("error", "identity.abuse-bookkeeping-failed", { error });
  }
}

/**
 * Charge an identity read against BOTH dials and throw a 429 `ApiError` when either is spent.
 *
 * Order is load-bearing: the burst dial is charged first and, when it refuses, the daily dial is
 * NOT charged. A caller who trips the per-minute limit has not spent a day's allowance in that
 * instant, and charging both would let a short burst eat a ceiling it never actually used.
 *
 * ── ONE KEY, ONE UNIT ─────────────────────────────────────────────────────────────────────────
 * `units` is how many KEYS this read answers, and it is what keeps the dials meaning what the
 * published policy says they mean. A batch read answers up to twenty ISRCs in one request; charged
 * as one, a caller pacing themselves under the per-minute dial would walk the archive twenty times
 * faster than the dial was set for, and the number in the docs would be a fiction. So the meter
 * counts keys, not requests — the batch is a round-trip saving, never a discount.
 */
export async function assertIdentityReadAllowed(
  request: Request,
  { units = 1, userId }: { units?: number; userId?: string } = {},
): Promise<void> {
  const bucket = rateLimitBucket(request, userId);

  const burst = await bumpRateLimitCounter({
    action: IDENTITY_BURST_ACTION,
    bucket,
    limit: IDENTITY_BURST_LIMIT,
    units,
    windowMs: IDENTITY_BURST_WINDOW_MS,
  });

  if (burst === undefined) {
    await noteIdentityReadBlocked(bucket);

    throw new ApiError("rate_limited", "Too many requests. Try again later.", 429);
  }

  const daily = await bumpRateLimitCounter({
    action: IDENTITY_DAILY_ACTION,
    bucket,
    limit: IDENTITY_DAILY_LIMIT,
    units,
    windowMs: IDENTITY_DAILY_WINDOW_MS,
  });

  if (daily === undefined) {
    await noteIdentityReadBlocked(bucket);

    throw new ApiError("rate_limited", "Too many requests today. Try again tomorrow.", 429);
  }
}
