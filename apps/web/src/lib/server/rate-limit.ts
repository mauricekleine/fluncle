import { waitUntil } from "cloudflare:workers";
import { jsonError } from "./env";
import { logEvent } from "./log";
import { hashRequestPart } from "./public-auth";
import { ApiError } from "./api-error";
import { bumpRateLimitCounter } from "./rate-limit-counters";

export {
  bumpRateLimitCounter,
  readRateLimitCount,
  pruneRateLimitCounters,
} from "./rate-limit-counters";

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
