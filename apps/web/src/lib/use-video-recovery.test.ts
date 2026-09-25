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
    expect(
      recoveryLatchDecision(latch({ attempts: 1, msSinceRecovery: 1_000, recovered: true })),
    ).toBe("hold");
  });

  it("re-arms after the bounded window even when src was unchanged — the radio bug", () => {
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
    expect(
      recoveryLatchDecision(
        latch({ attempts: 1, isPlayable: true, msSinceRecovery: 10, recovered: true }),
      ),
    ).toBe("rearm");
  });

  it("holds for good once the attempt cap is hit, even past the window", () => {
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
    expect(
      recoveryLatchDecision(latch({ attempts: MAX_RECOVERY_ATTEMPTS, recovered: false })),
    ).toBe("hold");
  });

  it("allows a bounded retry up to the cap — a same-src re-wedge recovers", () => {
    let attempts = 0;
    let recovered = false;
    const fired: number[] = [];

    for (let tick = 0; tick < 50; tick += 1) {
      const action = recoveryLatchDecision({
        attempts,
        isPlayable: false,
        msSinceRecovery: recovered ? STALL_TIMEOUT_MS : 0,
        recovered,
      });

      if (action === "hold") {
        continue;
      }

      if (action === "rearm") {
        recovered = false;
      }

      recovered = true;
      attempts += 1;
      fired.push(tick);
    }

    expect(fired).toHaveLength(MAX_RECOVERY_ATTEMPTS);
    expect(attempts).toBe(MAX_RECOVERY_ATTEMPTS);
  });
});
