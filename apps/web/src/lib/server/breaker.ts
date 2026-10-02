import { Effect } from "effect";

function parseCount(raw: string | undefined): number {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) {
    return 0;
  }

  const parsed = Number(raw.trim());

  return Number.isSafeInteger(parsed) ? parsed : 0;
}

export type BreakerSnapshot = {
  failures?: string;
  lastFailureAt?: string | null;
};

export type BreakerPatch = {
  failures: string;
  lastFailureAt?: string;
  trippedAt?: string;
};

export function makeBreaker(config: {
  cooldownMs: number;
  corruptTripped?: boolean;
  failureWindowMs?: number;
  maxFailures: number;
}) {
  const verdict = (now: number, trippedAt: string | null) => {
    const trippedMs = trippedAt ? Date.parse(trippedAt) : Number.NaN;
    const corrupt = Boolean(trippedAt) && !Number.isFinite(trippedMs);
    const remaining =
      corrupt && config.corruptTripped ? config.cooldownMs : config.cooldownMs - (now - trippedMs);

    return {
      cooldownRemainingMs: remaining > 0 ? remaining : 0,
      corrupt,
      tripped: remaining > 0,
    };
  };

  const failureCount = (snapshot: BreakerSnapshot, now: number): number => {
    if (config.failureWindowMs !== undefined) {
      const lastMs = snapshot.lastFailureAt ? Date.parse(snapshot.lastFailureAt) : Number.NaN;

      if (!Number.isFinite(lastMs) || now - lastMs >= config.failureWindowMs) {
        return 0;
      }
    }

    return parseCount(snapshot.failures);
  };

  const recordFailure = (snapshot: BreakerSnapshot, now: number): Effect.Effect<BreakerPatch> =>
    Effect.sync(() => {
      const failures = failureCount(snapshot, now) + 1;

      return {
        failures: failures >= config.maxFailures ? "0" : String(failures),
        ...(config.failureWindowMs === undefined
          ? {}
          : { lastFailureAt: new Date(now).toISOString() }),
        ...(failures >= config.maxFailures ? { trippedAt: new Date(now).toISOString() } : {}),
      };
    });

  return {
    failureCount,
    recordFailure,
    reset: { failures: "0", trippedAt: "" } as BreakerPatch,
    verdict,
  };
}

export function makeCallWindow(windowMs: number) {
  const count = (start: string | undefined, rawCount: string | undefined, now: number): number => {
    const startMs = start ? Date.parse(start) : Number.NaN;

    return !Number.isFinite(startMs) || now - startMs >= windowMs ? 0 : parseCount(rawCount);
  };

  const record = (start: string | undefined, rawCount: string | undefined, now: number) =>
    Effect.sync(() => {
      const startMs = start ? Date.parse(start) : Number.NaN;

      return !Number.isFinite(startMs) || now - startMs >= windowMs
        ? { count: "1", start: new Date(now).toISOString() }
        : { count: String(parseCount(rawCount) + 1) };
    });

  return { count, record };
}
