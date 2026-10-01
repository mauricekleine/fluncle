import { AsyncLocalStorage } from "node:async_hooks";
import { Clock, Effect, Fiber } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeSpacedQueue } from "./spaced-queue";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 0, 1));
});

afterEach(() => {
  vi.useRealTimers();
});

const stamp = (times: number[]) =>
  Clock.currentTimeMillis.pipe(Effect.tap((now) => Effect.sync(() => times.push(now))));

describe("makeSpacedQueue", () => {
  it("starts queued calls one interval apart, in order", async () => {
    const queue = makeSpacedQueue(() => 100);
    const times: number[] = [];

    const pending = Effect.runPromise(
      Effect.all([queue.run(stamp(times)), queue.run(stamp(times)), queue.run(stamp(times))], {
        concurrency: "unbounded",
      }),
    );
    await vi.advanceTimersByTimeAsync(200);
    await pending;

    expect(times.map((time) => time - (times[0] ?? 0))).toEqual([0, 100, 200]);
  });

  it("holds the next call until a deferred slot", async () => {
    const queue = makeSpacedQueue(() => 100);
    const times: number[] = [];
    const start = Date.now();

    const pending = Effect.runPromise(
      queue.deferUntil(start + 3000).pipe(Effect.andThen(queue.run(stamp(times)))),
    );
    await vi.advanceTimersByTimeAsync(3000);
    await pending;

    expect(times).toEqual([start + 3000]);
  });

  it("resumes a queued caller in its own request context, not the caller it waited behind", async () => {
    vi.useRealTimers();
    const requestScope = new AsyncLocalStorage<string>();
    const queue = makeSpacedQueue(() => 30);
    const seen: (string | undefined)[] = [];
    const observe = Effect.sync(() => seen.push(requestScope.getStore()));

    const first = requestScope.run("request-a", () =>
      Effect.runPromise(queue.run(Effect.sleep(10).pipe(Effect.andThen(observe)))),
    );
    const second = requestScope.run("request-b", () => Effect.runPromise(queue.run(observe)));
    await Promise.all([first, second]);

    expect(seen).toEqual(["request-a", "request-b"]);
  });

  it("frees the queue when a running call is interrupted", async () => {
    const queue = makeSpacedQueue(() => 10);
    const times: number[] = [];

    const stuck = Effect.runFork(queue.run(Effect.never));
    await vi.advanceTimersByTimeAsync(0);
    await Effect.runPromise(Fiber.interrupt(stuck));

    const pending = Effect.runPromise(queue.run(stamp(times)));
    await vi.advanceTimersByTimeAsync(10);
    await pending;

    expect(times).toHaveLength(1);
  });
});
