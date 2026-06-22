import { describe, expect, it } from "vitest";
import {
  type MediaStallSnapshot,
  mediaStallVerdict,
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
