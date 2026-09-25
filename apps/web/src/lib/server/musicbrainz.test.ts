import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mbFetch, setMusicbrainzRateLimitForTests } from "./musicbrainz";

const realFetch = globalThis.fetch;

const CLOCK_EPOCH = Date.UTC(2026, 0, 1);

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
        return new Promise<Response>(() => {});
      }

      return Promise.resolve(jsonResponse({ ok: true }));
    }) as unknown as typeof fetch;

    void mbFetch("/label/dead-context");

    const pending = mbFetch<{ ok: boolean }>("/label/alive");

    await settle();
    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(10 * 40);

    const second = await pending;

    expect(second.data).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it("serializes in-flight calls — the second fires only after a SLOW (but alive) first settles", async () => {
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

    await settle();
    expect(events).toEqual(["start-1"]);

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

    await settle();
    expect(fetchTimes).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(50);
    await pending;

    expect(fetchTimes).toHaveLength(2);
    const [first, second] = fetchTimes;

    expect(Math.abs((second ?? 0) - (first ?? 0))).toBeGreaterThanOrEqual(50);
  });
});
