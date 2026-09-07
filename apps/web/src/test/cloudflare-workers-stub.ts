// Test stub for the `cloudflare:workers` runtime module, which only exists inside
// the Workers runtime. Vitest runs under Node, so server modules that import `env`
// or `waitUntil` from it (e.g. lib/server/edge-cache.ts) would otherwise fail to
// resolve. The stub gives them inert values: an empty `env` (no purge credentials,
// so the purge path degrades to a local no-op) and a `waitUntil` that just runs the
// promise, which is exactly the behavior these unit tests want.

export const env: Record<string, string | undefined> = {};
const waitUntilPromises: Promise<unknown>[] = [];

export function waitUntil(promise: Promise<unknown>): void {
  waitUntilPromises.push(promise);
  void promise;
}

export function takeWaitUntilPromises(): Promise<unknown>[] {
  return waitUntilPromises.splice(0);
}
