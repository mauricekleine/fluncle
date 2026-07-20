// The vitest end of the repo-wide no-network rail. Wired as `setupFiles` in
// vitest.config.ts; the implementation (and the incident that motivates it) lives in
// packages/test-support, shared with every `bun test` package and with the e2e stack's
// server-side guard.
//
// Why it exists, briefly: server modules read their config through `readOptionalEnv`
// (src/lib/server/env.ts), which loaded the operator's real `.dev.vars` whenever "are we
// in dev?" was true — true under vitest. So a write-path test ran with LIVE credentials
// and fired the real integration: `createSubmission` POSTing to the crew's actual Discord
// webhook, once per seeded row, on every local run AND inside the Cloudflare deploy gate.
//
// A test that wants HTTP still can: `vi.stubGlobal("fetch", …)` replaces this wrapper
// wholesale, and mocking a wrapper module bypasses it entirely. The rail only catches the
// calls nobody meant to make — and it rejects loudly, naming the offender.

import { installNoNetworkRail } from "@fluncle/test-support/no-network";
import { afterAll, beforeAll } from "vitest";

let restore: () => void = () => {};

beforeAll(() => {
  restore = installNoNetworkRail();
});

afterAll(() => {
  restore();
});
