import { waitUntil } from "cloudflare:workers";
import { Cause, Effect } from "effect";

export const keepAlive = Effect.fnUntraced(function* (
  event: string,
  task: Effect.Effect<void, unknown>,
) {
  const context = yield* Effect.context<never>();
  const promise = Effect.runPromiseWith(context)(
    task.pipe(
      Effect.catchCause((cause) =>
        Effect.logError(event).pipe(Effect.annotateLogs({ cause: Cause.pretty(cause) })),
      ),
    ),
  );

  yield* Effect.try(() => waitUntil(promise)).pipe(Effect.ignore);
});
