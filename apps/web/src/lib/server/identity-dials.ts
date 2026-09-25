import * as Sentry from "@sentry/cloudflare";
import { bumpRateLimitCounter, rateLimitBucket } from "./rate-limit";
import { logEvent } from "./log";
import { ApiError } from "./spotify";

export const IDENTITY_BURST_LIMIT = 30;
export const IDENTITY_BURST_WINDOW_MS = 60 * 1000;

export const IDENTITY_DAILY_LIMIT = 1000;
export const IDENTITY_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;

export const IDENTITY_BURST_ACTION = "get_track_identity_burst";
export const IDENTITY_DAILY_ACTION = "get_track_identity_daily";

export const IDENTITY_BLOCKED_ACTION = "get_track_identity_blocked";

export const IDENTITY_ABUSE_ALERT_AT = 100;

const IDENTITY_BLOCKED_LEDGER_MAX = IDENTITY_ABUSE_ALERT_AT * 100;

export async function noteIdentityReadBlocked(bucket: string): Promise<void> {
  try {
    const blocked = await bumpRateLimitCounter({
      action: IDENTITY_BLOCKED_ACTION,
      bucket,
      limit: IDENTITY_BLOCKED_LEDGER_MAX,
      windowMs: IDENTITY_DAILY_WINDOW_MS,
    });

    if (blocked !== IDENTITY_ABUSE_ALERT_AT) {
      return;
    }

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
