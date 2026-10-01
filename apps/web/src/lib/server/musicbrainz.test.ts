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

describe("mbFetch outcome", () => {
  it("distinguishes an absent artist from a network error", async () => {
    setMusicbrainzRateLimitForTests(0);
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockRejectedValueOnce(new Error("network unavailable")) as unknown as typeof fetch;

    const missing = await mbFetch("/artist/missing");
    const unavailable = await mbFetch("/artist/unavailable");

    expect(missing).toMatchObject({ data: null, rateLimited: false, status: 404 });
    expect(unavailable).toMatchObject({ data: null, rateLimited: false });
    expect(unavailable.status).toBeUndefined();
  });
});

function unavailable(retryAfterSeconds: number): Response {
  return new Response(null, {
    headers: { "Retry-After": String(retryAfterSeconds) },
    status: 503,
  });
}

function loggedEvents(): { event: string; outcome?: string; attempt?: number }[] {
  return [vi.mocked(console.info), vi.mocked(console.warn)].flatMap((spy) =>
    spy.mock.calls.map(([line]) => JSON.parse(String(line))),
  );
}

describe("mbFetch 503 handling", () => {
  const context = { nodeKind: "label", requestKind: "label_browse" } as const;

  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("waits out Retry-After, then returns the body", async () => {
    setMusicbrainzRateLimitForTests(10);
    const fetchTimes: number[] = [];
    const responses = [unavailable(3), jsonResponse({ ok: true })];
    globalThis.fetch = vi.fn(() => {
      fetchTimes.push(Date.now());

      return Promise.resolve(responses.shift() as Response);
    }) as unknown as typeof fetch;

    const pending = mbFetch<{ ok: boolean }>("/label/busy", context);
    await settle();
    await vi.advanceTimersByTimeAsync(3000);

    await expect(pending).resolves.toEqual({ data: { ok: true }, rateLimited: false, status: 200 });
    expect((fetchTimes[1] ?? 0) - (fetchTimes[0] ?? 0)).toBeGreaterThanOrEqual(3000);
    expect(loggedEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "crawl.musicbrainz-request", outcome: "retry_503" }),
        expect.objectContaining({ attempt: 1, event: "musicbrainz.retry", retryAfterSeconds: 3 }),
        expect.objectContaining({ event: "crawl.musicbrainz-request", outcome: "body" }),
      ]),
    );
  });

  it("reports rateLimited after the third 503, recording two retries and one throttle", async () => {
    setMusicbrainzRateLimitForTests(0);
    globalThis.fetch = vi.fn(() => Promise.resolve(unavailable(1))) as unknown as typeof fetch;

    const pending = mbFetch("/label/down", context);
    await vi.advanceTimersByTimeAsync(10);
    const result = await pending;
    const outcomes = loggedEvents()
      .filter((line) => line.event === "crawl.musicbrainz-request")
      .map((line) => line.outcome);

    expect(result).toEqual({ data: null, rateLimited: true, status: 503 });
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    expect(outcomes).toEqual(["retry_503", "retry_503", "throttled"]);
  });

  it("treats a request that outlives the 15s timeout as a network error", async () => {
    setMusicbrainzRateLimitForTests(0);
    globalThis.fetch = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    ) as unknown as typeof fetch;

    const pending = mbFetch("/label/hung", context);
    await vi.advanceTimersByTimeAsync(15_000);

    await expect(pending).resolves.toEqual({ data: null, rateLimited: false });
    expect(loggedEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "crawl.musicbrainz-request", outcome: "network_error" }),
      ]),
    );
  });
});
