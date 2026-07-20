// The one no-network rail, shared by every suite in the repo.
//
// Why it exists: on 2026-07-20 the `apps/web` vitest suite was found POSTing REAL
// messages to the crew's Discord channel — ~15 per run, for many runs. `createSubmission`
// calls `notifyDiscord`, which reads `DISCORD_WEBHOOK_URL` through a `.dev.vars` load
// gated only on "are we in dev?" — true under a test runner. So the suite ran with the
// operator's live credentials and fired the live integration, locally AND inside the
// Cloudflare deploy gate.
//
// Mocking each seam per test file is the fragile fix: it protects only the seams someone
// remembered, and the NEXT integration repeats the trick. This blocks the TRANSPORT
// instead, so an outbound call nobody meant to make is inert by default and names itself.
//
// A test that genuinely wants HTTP still can — replacing `globalThis.fetch` wholesale
// (`vi.stubGlobal("fetch", …)` under vitest, a plain assignment under `bun test`) swaps
// this wrapper out, and mocking a wrapper module bypasses it entirely. The rail only
// catches the calls nobody asked for, and it REJECTS loudly rather than swallowing, so
// the offender is named at the call site.

/** Hosts a test may talk to: loopback only (a local libSQL server, a fixture server). */
function isLoopback(urlString: string): boolean {
  try {
    const { hostname } = new URL(urlString);

    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]" ||
      hostname === "0.0.0.0" ||
      hostname.endsWith(".localhost")
    );
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

/** The message every blocked call rejects with. Tests match on this prefix. */
export const BLOCKED_PREFIX = "Blocked outbound request to";

export function blockedRequestMessage(url: string): string {
  return (
    `${BLOCKED_PREFIX} ${url} — tests must not reach the network. ` +
    `Mock the wrapper module for this integration, or stub global fetch in this file.`
  );
}

/** Stamped on the wrapper so a suite can prove, without a request, that it is installed. */
const RAIL_MARKER = "__fluncleNoNetworkRail";

/**
 * Wrap `globalThis.fetch` so anything but loopback rejects. Returns the restore
 * function, so a runner with lifecycle hooks can put the real fetch back afterwards.
 */
export function installNoNetworkRail(): () => void {
  const realFetch = globalThis.fetch;

  const wrapped = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);

    if (isLoopback(url)) {
      return realFetch(input, init);
    }

    return Promise.reject(new Error(blockedRequestMessage(url)));
  }) as typeof globalThis.fetch;

  Object.defineProperty(wrapped, RAIL_MARKER, { value: true });
  globalThis.fetch = wrapped;

  return () => {
    globalThis.fetch = realFetch;
  };
}

/** True when the current `globalThis.fetch` is this rail's wrapper. */
export function isRailArmed(): boolean {
  return RAIL_MARKER in globalThis.fetch;
}

/**
 * The per-package proof, called from a one-line `no-network.test.ts`.
 *
 * The rail is wired by a `bunfig.toml` preload — easy to lose in a move, a rename, or a
 * new package that forgets to copy it. So every `bun test` package asserts it is armed;
 * if that file goes red, the suite can reach production services again. Treat it as an
 * incident, not a flaky test.
 *
 * Deliberately SYNCHRONOUS and runner-agnostic: plain throws rather than `bun:test`, and
 * no top-level `await`, so it works identically in every package whatever its tsconfig
 * module setting (apps/raycast is CommonJS/NodeNext; the mobile, contracts and registry
 * suites are assertion scripts rather than `test()` calls). `bun test` fails a file that
 * throws at module scope, which is exactly the signal wanted. That the wrapper actually
 * REFUSES an external host and still allows loopback is proven behaviourally, once, by
 * this package's own `no-network.test.ts`.
 */
export function assertRailArmed(suiteName: string): void {
  if (!isRailArmed()) {
    throw new Error(
      `${suiteName}: the no-network rail is NOT armed — this suite can reach the internet. ` +
        "Check this package's bunfig.toml `[test] preload`.",
    );
  }

  console.log(`no-network rail armed: ${suiteName}`);
}
