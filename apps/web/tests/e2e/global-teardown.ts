// Playwright global teardown — restore `.dev.vars`.
//
// The `webServer` orchestrator (`scripts/e2e-stack.ts`) also tries this from its
// SIGTERM trap, but Playwright tears the server down by killing the process
// GROUP, so that trap is not guaranteed to complete. This hook is: Playwright
// always runs globalTeardown, in its own (Node) process, after every test has
// finished and before the server is stopped — no requests are in flight, so
// putting the original file back here is both safe and reliable.
//
// `restoreDevVars` is pure `node:fs` (the Bun-only helpers in `stack.ts` are all
// inside functions this never calls), so it runs fine under the Node runner. It is
// idempotent, so the orchestrator's trap and this hook cannot conflict.

import { restoreDevVars } from "./stack";

export default function globalTeardown(): void {
  restoreDevVars();
}
