import { Clock, Effect } from "effect";

export type SpacedQueue = {
  readonly deferUntil: (atMs: number) => Effect.Effect<void>;
  readonly run: <A, E, R>(call: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
};

const CHAIN_WAIT_FACTOR = 40;

export function makeSpacedQueue(intervalMs: () => number): SpacedQueue {
  let nextSlotAt = 0;
  let tail: Promise<void> = Promise.resolve();

  const deferUntil = (atMs: number): Effect.Effect<void> =>
    Effect.sync(() => {
      nextSlotAt = Math.max(nextSlotAt, atMs);
    });

  const run = <A, E, R>(call: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      const { promise: done, resolve } = Promise.withResolvers<void>();
      const previous = tail;
      tail = done;

      return Effect.gen(function* () {
        const interval = intervalMs();

        if (interval > 0) {
          yield* Effect.promise(() => previous).pipe(
            Effect.timeoutOption(interval * CHAIN_WAIT_FACTOR),
          );
        }

        const now = yield* Clock.currentTimeMillis;
        const slotAt = Math.max(now, nextSlotAt);
        nextSlotAt = slotAt + interval;

        if (slotAt > now) {
          yield* Effect.sleep(slotAt - now);
        }

        return yield* call;
      }).pipe(Effect.ensuring(Effect.sync(resolve)));
    });

  return { deferUntil, run };
}
