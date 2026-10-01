import { type Effect, ManagedRuntime } from "effect";
import { serverLoggerLayer } from "./logger";

export const serverRuntime = ManagedRuntime.make(serverLoggerLayer);

export function runServerEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return serverRuntime.runPromise(effect);
}
