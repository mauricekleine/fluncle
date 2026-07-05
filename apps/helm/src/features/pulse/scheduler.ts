// The 18h nudge — a daemon-side scheduler. Once an hour it asks: has anything been
// posted lately, and is a dressed finding still waiting? If the last post is older
// than FLUNCLE_HELM_NUDGE_HOURS (default 18) and an unposted render exists, it taps
// the operator on the shoulder ONCE (osascript, works windowless under launchd),
// deduped to one nudge per local day so it never turns into a nag storm.
//
// The decision itself is the pure `nudgeTick` (logic.ts) — this file is the thin
// impure shell around it: the config, the interval, the per-day dedupe state, and
// the osascript fire. The tick is what the tests pin with an injected clock; this
// is what the live proof drives through the check route.

import { type NudgeCheckResponse, type NudgeStatus } from "./contract";
import { type NudgeInput, nudgeTick } from "./logic";
import { type GatheredPosting } from "./posting-state";

const DEFAULT_THRESHOLD_HOURS = 18;
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

export type NudgeConfig = {
  disabled: boolean;
  intervalMs: number;
  thresholdHours: number;
  timeZone: string;
};

/** Read the nudge config off the environment (pure over an env record — testable). */
export function readNudgeConfig(
  env: Record<string, string | undefined> = process.env,
): NudgeConfig {
  return {
    disabled: env.FLUNCLE_HELM_NUDGE_DISABLED === "1",
    intervalMs: positiveInt(env.FLUNCLE_HELM_NUDGE_INTERVAL_MS, DEFAULT_INTERVAL_MS),
    thresholdHours: positiveNumber(env.FLUNCLE_HELM_NUDGE_HOURS, DEFAULT_THRESHOLD_HOURS),
    timeZone: env.FLUNCLE_HELM_NUDGE_TZ ?? systemTimeZone(),
  };
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const value = raw === undefined ? Number.NaN : Number.parseFloat(raw);

  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);

  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export type NudgeScheduler = {
  readonly config: NudgeConfig;
  /** Run the tick against a gathered state. `fire` actually notifies; `force`
   *  bypasses the freshness + dedupe gates (the test hook's forced clock). */
  check(
    state: GatheredPosting,
    opts: { fire: boolean; force?: boolean },
  ): Promise<NudgeCheckResponse>;
  /** Begin the hourly interval, gathering fresh each tick. No-op when disabled. */
  start(gather: () => Promise<GatheredPosting>): void;
  /** The dry status for the panel — the current decision, nothing fired. */
  status(state: GatheredPosting, now: number): NudgeStatus;
  /** Stop the interval (tests; the daemon otherwise exits and the timer dies). */
  stop(): void;
};

export function createNudgeScheduler(deps: {
  config: NudgeConfig;
  notify: (title: string, body: string) => Promise<void>;
}): NudgeScheduler {
  const { config, notify } = deps;
  let lastNudgeDay: string | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;

  function buildInput(state: GatheredPosting, now: number, dedupe: string | null): NudgeInput {
    return {
      hasUnposted: state.nextToPost !== undefined,
      lastNudgeDay: dedupe,
      newestPostedAt: state.newestPostedAt,
      nextLabel: state.nextToPost?.artistTitle ?? null,
      now,
      thresholdHours: config.thresholdHours,
      timeZone: config.timeZone,
    };
  }

  function status(state: GatheredPosting, now: number): NudgeStatus {
    const decision = nudgeTick(buildInput(state, now, lastNudgeDay));

    return {
      ageMs: decision.ageMs,
      hasUnposted: state.nextToPost !== undefined,
      lastNudgeDay,
      newestPostedAt: state.newestPostedAt,
      reason: decision.reason,
      thresholdHours: config.thresholdHours,
      timeZone: config.timeZone,
      wouldFire: decision.fire,
    };
  }

  async function check(
    state: GatheredPosting,
    opts: { fire: boolean; force?: boolean },
  ): Promise<NudgeCheckResponse> {
    // The forced clock: push `now` just past the threshold and drop the dedupe, so
    // the tick fires whenever an unposted render exists — the proof path. A forced
    // fire never persists the real per-day dedupe (it's a synthetic clock).
    const forced = opts.force === true;
    const now = forced ? forcedNow(state, config.thresholdHours) : Date.now();
    const dedupe = forced ? null : lastNudgeDay;

    const decision = nudgeTick(buildInput(state, now, dedupe));
    let notified = false;

    if (opts.fire && decision.fire) {
      try {
        await notify(decision.title, decision.body);
        notified = true;

        // Only a natural (unforced) fire arms the per-day dedupe.
        if (!forced) {
          lastNudgeDay = decision.nudgeDay;
        }
      } catch {
        // osascript refused (notification permissions) — leave the dedupe unset so
        // the next tick can try again rather than silently marking the day done.
        notified = false;
      }
    }

    return { decision, notified };
  }

  function start(gather: () => Promise<GatheredPosting>): void {
    if (config.disabled || timer !== undefined) {
      return;
    }

    timer = setInterval(() => {
      void (async () => {
        try {
          const state = await gather();
          await check(state, { fire: true });
        } catch {
          // A failed gather is a missed hour, not a state — the next tick retries.
        }
      })();
    }, config.intervalMs);

    // Never let the nudge timer alone keep the daemon alive.
    timer.unref?.();
  }

  function stop(): void {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  return { check, config, start, status, stop };
}

/** A clock value guaranteed to read as stale for the forced check. */
function forcedNow(state: GatheredPosting, thresholdHours: number): number {
  const base = state.newestPostedAt ?? Date.now();

  return base + thresholdHours * 3_600_000 + 1;
}
