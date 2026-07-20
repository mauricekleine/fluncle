// A global rail: no test may reach the real internet.
//
// Why this exists: server modules read their config through `readOptionalEnv` /
// `readEnvs` (src/lib/server/env.ts), which call `loadLocalEnv()` — and that loads
// the operator's real `.dev.vars` into `process.env`. So a test that exercises a
// write path picks up LIVE credentials and fires the real integration: creating a
// submission POSTed to the real Discord webhook, once per test row, on every local
// run AND inside the Cloudflare deploy gate. (Observed 2026-07-20: the write-rails
// and chat-tools suites spamming the crew's Discord channel.)
//
// Mocking each seam per test file is the fragile fix — it protects only the seams
// someone remembered. This blocks the transport instead, so a NEW outbound call in
// a NEW test is inert by default and the next integration cannot repeat the trick.
//
// A test that wants to exercise HTTP still can: `vi.stubGlobal("fetch", …)` (the
// established pattern in ~18 files) replaces this wrapper wholesale, and mocking a
// wrapper module bypasses it entirely. This only catches the calls nobody meant to
// make — and it throws loudly rather than silently swallowing, so the offender is
// named at the call site.

import { afterAll, beforeAll } from "vitest";

/** Hosts a test may talk to: loopback only (a local libSQL server, a test fixture server). */
function isLoopback(urlString: string): boolean {
  try {
    const { hostname } = new URL(urlString);

    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    // A non-absolute URL never leaves the process; let it through to fail on its own terms.
    return true;
  }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.href;
  }

  return input.url;
}

const realFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);

    if (isLoopback(url)) {
      return realFetch(input, init);
    }

    return Promise.reject(
      new Error(
        `Blocked outbound request to ${url} — tests must not reach the network. ` +
          `Mock the wrapper module for this integration, or stub global fetch in this file.`,
      ),
    );
  }) as typeof globalThis.fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});
