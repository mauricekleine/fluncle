// The MB pacing gate's two load-bearing properties. The first is THE 2026-07-18 regression: the
// old serialized promise chain wedged the whole isolate when one caller's request context died
// mid-call (Workers freeze a completed request's timers, so the chain's next delay() never fired
// and every later MB caller queued forever — the label-lineage box tick poisoned its isolate this
// way). Slot allocation must keep an unsettled call from ever blocking the next one.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mbFetch, setMusicbrainzRateLimitForTests } from "./musicbrainz";

const realFetch = globalThis.fetch;

// Every property here is about WHEN one call fires relative to another, so the whole file runs
// on FAKE time: the gate's two waits (the chain deadline, the slot delay) are stepped explicitly
// instead of slept through. Real sleeps made the pacing assertion flaky — the slot clock hands
// caller B a FIXED timestamp, so whenever caller A's own timer fired late under load the measured
// gap collapsed to `interval - lateness` (observed 15ms against a 50ms interval on a loaded build
// box, 2026-07-28). Fake time removes the lateness term entirely and drops the file to ~0ms.
//
// Two rules keep the stepping honest, both learned by getting them wrong:
//   - Step with `advanceTimersByTimeAsync`, never `runAllTimersAsync`. The latter jumps straight
//     to the FARTHEST timer, which fires the chain deadline before the predecessor has even run —
//     the serialization under test would be skipped rather than exercised.
//   - Give each test its own clock epoch. `nextSlotAt` is module state with no reset seam (its
//     one setter is also called by artist-resolution/discogs at runtime, so it must not be
//     repurposed as a test reset), and a fresh `useFakeTimers()` rewinds the clock to real now —
//     leaving the previous test's slot stamp in the FUTURE. Distinct epochs keep it in the past.
const CLOCK_EPOCH = Date.UTC(2026, 0, 1);
// Wider than any single test advances the clock, so no test inherits a future slot stamp.
const EPOCH_STRIDE_MS = 1_000_000;
let testIndex = 0;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(CLOCK_EPOCH + testIndex * EPOCH_STRIDE_MS);
  testIndex += 1;
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = realFetch;
  setMusicbrainzRateLimitForTests(1100);
  vi.restoreAllMocks();
});

/** Drain the pending microtasks without moving the fake clock. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}

describe("mbFetch pacing", () => {
  it("a hung in-flight call never blocks the next caller (the isolate-poison regression)", async () => {
    setMusicbrainzRateLimitForTests(10);

    let calls = 0;
    globalThis.fetch = vi.fn(() => {
      calls += 1;

      if (calls === 1) {
        // A call whose settlement never comes — the shape a dead request context leaves behind.
        return new Promise<Response>(() => {});
      }

      return Promise.resolve(jsonResponse({ ok: true }));
    }) as unknown as typeof fetch;

    // Fire the doomed call and deliberately do NOT await it.
    void mbFetch("/label/dead-context");

    const pending = mbFetch<{ ok: boolean }>("/label/alive");

    // Let the doomed call take its slot and hang, so the live caller is genuinely queued
    // behind an unsettled predecessor rather than racing it.
    await settle();
    expect(calls).toBe(1);

    // The dead head never settles, so the chain deadline (interval × 40) IS the unwedge.
    await vi.advanceTimersByTimeAsync(10 * 40);

    const second = await pending;

    expect(second.data).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it("serializes in-flight calls — the second fires only after a SLOW (but alive) first settles", async () => {
    // The 2026-07-19 regression: arrival pacing alone let calls overlap when one ran long,
    // and under MusicBrainz's evening slowdown the overlap compounded into real 503
    // throttling. One call in flight at a time is the etiquette MB expects.
    setMusicbrainzRateLimitForTests(10);

    const events: string[] = [];
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      const id = calls;
      events.push(`start-${id}`);

      if (id === 1) {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }

      events.push(`end-${id}`);

      return jsonResponse({});
    }) as unknown as typeof fetch;

    const pending = Promise.all([mbFetch("/label/slow"), mbFetch("/label/second")]);

    // The slow call is in flight and the second caller is queued behind it.
    await settle();
    expect(events).toEqual(["start-1"]);

    // 150 < the 400ms chain deadline, so the second caller is released by its predecessor
    // SETTLING — the property under test — and not by the wedge-immunity timeout.
    await vi.advanceTimersByTimeAsync(150);
    await pending;

    expect(events).toEqual(["start-1", "end-1", "start-2", "end-2"]);
  });

  it("paces two callers at least the rate-limit interval apart", async () => {
    setMusicbrainzRateLimitForTests(50);

    const fetchTimes: number[] = [];
    globalThis.fetch = vi.fn(() => {
      fetchTimes.push(Date.now());

      return Promise.resolve(jsonResponse({}));
    }) as unknown as typeof fetch;

    const pending = Promise.all([mbFetch("/label/first"), mbFetch("/label/second")]);

    // The first call fires immediately; the second is holding its 50ms slot delay.
    await settle();
    expect(fetchTimes).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(50);
    await pending;

    expect(fetchTimes).toHaveLength(2);
    const [first, second] = fetchTimes;
    // On fake time the slot arithmetic is exact, so this is the interval itself rather than
    // the old 45ms tolerance for real-timer jitter.
    expect(Math.abs((second ?? 0) - (first ?? 0))).toBeGreaterThanOrEqual(50);
  });
});
