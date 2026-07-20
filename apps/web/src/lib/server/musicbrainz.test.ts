// The MB pacing gate's two load-bearing properties. The first is THE 2026-07-18 regression: the
// old serialized promise chain wedged the whole isolate when one caller's request context died
// mid-call (Workers freeze a completed request's timers, so the chain's next delay() never fired
// and every later MB caller queued forever — the label-lineage box tick poisoned its isolate this
// way). Slot allocation must keep an unsettled call from ever blocking the next one.

import { afterEach, describe, expect, it, vi } from "vitest";

import { mbFetch, setMusicbrainzRateLimitForTests } from "./musicbrainz";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  setMusicbrainzRateLimitForTests(1100);
  vi.restoreAllMocks();
});

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

    const second = await mbFetch<{ ok: boolean }>("/label/alive");

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

    await Promise.all([mbFetch("/label/slow"), mbFetch("/label/second")]);

    expect(events).toEqual(["start-1", "end-1", "start-2", "end-2"]);
  });

  it("paces two callers at least the rate-limit interval apart", async () => {
    setMusicbrainzRateLimitForTests(50);

    const fetchTimes: number[] = [];
    globalThis.fetch = vi.fn(() => {
      fetchTimes.push(Date.now());

      return Promise.resolve(jsonResponse({}));
    }) as unknown as typeof fetch;

    await Promise.all([mbFetch("/label/first"), mbFetch("/label/second")]);

    expect(fetchTimes).toHaveLength(2);
    const [first, second] = fetchTimes;
    // 45 rather than 50: timers can fire a hair early under load; the pacing property is what
    // matters, not millisecond exactness.
    expect(Math.abs((second ?? 0) - (first ?? 0))).toBeGreaterThanOrEqual(45);
  });
});
