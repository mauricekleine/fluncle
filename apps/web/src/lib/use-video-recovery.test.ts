import { describe, expect, it } from "vitest";
import {
  MAX_RECOVERY_ATTEMPTS,
  type MediaStallSnapshot,
  mediaStallVerdict,
  type RecoveryLatchSnapshot,
  recoveryLatchDecision,
  STALL_EVENT_GRACE_MS,
  STALL_TIMEOUT_MS,
} from "./use-video-recovery";

// The stall verdict is the load-bearing decision of the watchdog (a stuck load
// fires no `error`, so the old one-shot onError never recovered it). It runs on a
// timer with real DOM elements in the field, so the logic is tested in isolation:
// a playable element is left alone, an idle element never fires, and only a
// genuinely wedged not-yet-playable load (timeout OR a lingering stall event)
// triggers exactly one recovery.

// HAVE_NOTHING(0) … HAVE_CURRENT_DATA(2) … HAVE_ENOUGH_DATA(4)
const NOTHING = 0;
const METADATA = 1;
const CURRENT = 2;

function snapshot(overrides: Partial<MediaStallSnapshot> = {}): MediaStallSnapshot {
  return {
    expectsPlayback: true,
    msSinceLastProgress: 0,
    msSinceLoadStart: 0,
    msSinceStallEvent: undefined,
    readyState: NOTHING,
    ...overrides,
  };
}

describe("mediaStallVerdict", () => {
  it("stands down when the element isn't expected to play (idle / off-screen)", () => {
    expect(
      mediaStallVerdict(
        snapshot({ expectsPlayback: false, msSinceLastProgress: STALL_TIMEOUT_MS * 10 }),
      ),
    ).toBe(false);
  });

  it("stands down once the element is playable, even past the timeout", () => {
    // readyState >= HAVE_CURRENT_DATA: any later rebuffer is the browser's own,
    // not a stuck initial load — never our recovery's job.
    expect(
      mediaStallVerdict(
        snapshot({ msSinceLastProgress: STALL_TIMEOUT_MS * 5, readyState: CURRENT }),
      ),
    ).toBe(false);
  });

  it("leaves a fresh load alone (inside the timeout, no stall event)", () => {
    expect(mediaStallVerdict(snapshot({ msSinceLastProgress: 1_000, readyState: METADATA }))).toBe(
      false,
    );
  });

  it("recovers a not-yet-playable load that hasn't progressed past the timeout", () => {
    expect(
      mediaStallVerdict(snapshot({ msSinceLastProgress: STALL_TIMEOUT_MS, readyState: METADATA })),
    ).toBe(true);
  });

  it("does not recover one millisecond before the timeout", () => {
    expect(
      mediaStallVerdict(
        snapshot({ msSinceLastProgress: STALL_TIMEOUT_MS - 1, readyState: NOTHING }),
      ),
    ).toBe(false);
  });

  it("recovers sooner when a stall/waiting event has stood past the grace window", () => {
    // The element told us it's starved — react before the full timeout.
    expect(
      mediaStallVerdict(
        snapshot({
          msSinceLastProgress: 1_000,
          msSinceStallEvent: STALL_EVENT_GRACE_MS,
          readyState: NOTHING,
        }),
      ),
    ).toBe(true);
  });

  it("ignores a stall event still inside its grace window", () => {
    expect(
      mediaStallVerdict(
        snapshot({
          msSinceLastProgress: 1_000,
          msSinceStallEvent: STALL_EVENT_GRACE_MS - 1,
          readyState: NOTHING,
        }),
      ),
    ).toBe(false);
  });

  it("ignores a stall event once the element became playable", () => {
    expect(
      mediaStallVerdict(
        snapshot({
          msSinceStallEvent: STALL_EVENT_GRACE_MS * 5,
          readyState: CURRENT,
        }),
      ),
    ).toBe(false);
  });
});

// The recovery latch is the second-order guard: one recovery per wedge episode,
// never a tight loop. The original latch re-armed ONLY on a fresh
// `loadstart`/`emptied`, so radio's `resolveSlot()` recovery — which commonly
// resolves to the SAME `videoUrl` and swaps no `src` — left the latch dead
// forever and a later stall on that clip had no recovery path. These cover the
// new re-arm rules (healthy verdict OR bounded window) and the attempt cap that
// keeps a genuinely dead source from looping.

function latch(overrides: Partial<RecoveryLatchSnapshot> = {}): RecoveryLatchSnapshot {
  return {
    attempts: 0,
    isPlayable: false,
    msSinceRecovery: 0,
    recovered: false,
    ...overrides,
  };
}

describe("recoveryLatchDecision", () => {
  it("opens the wedge check when no recovery has fired yet", () => {
    expect(recoveryLatchDecision(latch({ attempts: 0, recovered: false }))).toBe("open");
  });

  it("holds right after a recovery (still inside the window, not yet playable)", () => {
    // The one-recovery-per-episode guarantee: a fresh recovery stands the latch
    // down until it re-arms.
    expect(
      recoveryLatchDecision(latch({ attempts: 1, msSinceRecovery: 1_000, recovered: true })),
    ).toBe("hold");
  });

  it("re-arms after the bounded window even when src was unchanged — the radio bug", () => {
    // resolveSlot() resolved to the same videoUrl: no loadstart/emptied, the
    // element never reached playable, yet the latch must NOT stay dead forever.
    expect(
      recoveryLatchDecision(
        latch({
          attempts: 1,
          isPlayable: false,
          msSinceRecovery: STALL_TIMEOUT_MS,
          recovered: true,
        }),
      ),
    ).toBe("rearm");
  });

  it("does not re-arm one millisecond before the window", () => {
    expect(
      recoveryLatchDecision(
        latch({ attempts: 1, msSinceRecovery: STALL_TIMEOUT_MS - 1, recovered: true }),
      ),
    ).toBe("hold");
  });

  it("re-arms immediately once the element reached a playable frame", () => {
    // A real recovery (the element actually started): re-arm so a future DISTINCT
    // wedge on this episode can still recover, well before the window elapses.
    expect(
      recoveryLatchDecision(
        latch({ attempts: 1, isPlayable: true, msSinceRecovery: 10, recovered: true }),
      ),
    ).toBe("rearm");
  });

  it("holds for good once the attempt cap is hit, even past the window", () => {
    // A genuinely dead source: never let it re-arm into a tight recovery loop.
    expect(
      recoveryLatchDecision(
        latch({
          attempts: MAX_RECOVERY_ATTEMPTS,
          isPlayable: false,
          msSinceRecovery: STALL_TIMEOUT_MS * 10,
          recovered: true,
        }),
      ),
    ).toBe("hold");
  });

  it("holds at the cap even before a recovery would otherwise open the check", () => {
    // The cap is checked first, so a re-wedge at the budget ceiling cannot fire.
    expect(
      recoveryLatchDecision(latch({ attempts: MAX_RECOVERY_ATTEMPTS, recovered: false })),
    ).toBe("hold");
  });

  it("allows a bounded retry up to the cap — a same-src re-wedge recovers", () => {
    // Walk the radio second-wedge path: each no-op recovery re-arms after the
    // window, fires again, until the budget is spent — bounded, not permanent.
    let attempts = 0;
    let recovered = false;
    const fired: number[] = [];

    for (let tick = 0; tick < 50; tick += 1) {
      const action = recoveryLatchDecision({
        attempts,
        isPlayable: false, // dead source: never reaches playable
        msSinceRecovery: recovered ? STALL_TIMEOUT_MS : 0,
        recovered,
      });

      if (action === "hold") {
        continue;
      }

      if (action === "rearm") {
        recovered = false;
      }

      // The wedge check would judge this still-stuck load wedged → fire.
      recovered = true;
      attempts += 1;
      fired.push(tick);
    }

    // Exactly MAX_RECOVERY_ATTEMPTS recoveries fired — more than the original
    // single shot (so the same-src re-wedge DOES recover), but strictly bounded.
    expect(fired).toHaveLength(MAX_RECOVERY_ATTEMPTS);
    expect(attempts).toBe(MAX_RECOVERY_ATTEMPTS);
  });
});
