import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { assertRailArmed, installNoNetworkRail, isRailArmed } from "./no-network";

// The rail's own mechanics, proven behaviourally ONCE here. Every package then carries a
// one-line proof that its runner actually ARMED the rail (see e.g.
// apps/cli/src/no-network.test.ts) — a safety mechanism nobody tests is one that silently
// rots.

/** The message a fetch rejected with, or "" when it resolved. Explicit rather than
 *  `expect(...).rejects`, whose bun typing is not thenable (the type-aware lint flags
 *  awaiting it), and clearer about which of the two outcomes actually happened. */
async function failureOf(request: Promise<Response>): Promise<string> {
  try {
    await request;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  return "";
}

describe("the no-network rail", () => {
  let restore: () => void = () => {};

  beforeEach(() => {
    restore = installNoNetworkRail();
  });

  afterEach(() => {
    restore();
  });

  test("rejects an outbound request to an external host", async () => {
    expect(await failureOf(fetch("https://discord.com/api/webhooks/nope"))).toMatch(
      /Blocked outbound request/,
    );
  });

  test("names the offending URL so the caller is findable", async () => {
    expect(await failureOf(fetch("https://api.example.com/v1/send"))).toContain(
      "https://api.example.com/v1/send",
    );
  });

  test("blocks a Request object, not just a string URL", async () => {
    expect(await failureOf(fetch(new Request("https://hooks.example.com/post")))).toMatch(
      /Blocked outbound request/,
    );
  });

  test("blocks a URL object", async () => {
    expect(await failureOf(fetch(new URL("https://example.com/thing")))).toMatch(
      /Blocked outbound request/,
    );
  });

  test("lets loopback through (a local libSQL server or fixture server is legitimate)", async () => {
    // Port 1 is closed, so this fails at the TRANSPORT — the point is that it is NOT
    // refused by the rail, proving loopback is exempt.
    expect(await failureOf(fetch("http://127.0.0.1:1/health"))).not.toMatch(
      /Blocked outbound request/,
    );
  });

  test("restores the real fetch when uninstalled", () => {
    const wrapped = globalThis.fetch;

    restore();

    expect(globalThis.fetch).not.toBe(wrapped);
    restore = installNoNetworkRail();
  });

  test("reports itself armed, and `assertRailArmed` throws when it is not", () => {
    expect(isRailArmed()).toBe(true);
    expect(() => assertRailArmed("this suite")).not.toThrow();

    restore();

    expect(isRailArmed()).toBe(false);
    expect(() => assertRailArmed("a suite with no preload")).toThrow(/NOT armed/);

    restore = installNoNetworkRail();
  });
});
