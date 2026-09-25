import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { assertRailArmed, installNoNetworkRail, isRailArmed } from "./no-network";

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
