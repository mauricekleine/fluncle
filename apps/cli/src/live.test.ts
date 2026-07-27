import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { maybePrintLiveCallout, shouldSkip } from "./live";

// This suite never touches the network: every case replaces `globalThis.fetch`
// wholesale, which is the no-network rail's sanctioned test seam (see
// packages/test-support/src/no-network.ts). The rail's wrapper is captured before
// the first swap and put back after each case, so it stays armed for every other file.
const originalFetch = globalThis.fetch;
const originalIsTty = process.stdout.isTTY;
const originalLog = console.log;
const originalEnv = {
  CI: process.env.CI,
  FLUNCLE_NO_LIVE_CALLOUT: process.env.FLUNCLE_NO_LIVE_CALLOUT,
  NO_COLOR: process.env.NO_COLOR,
};

// Nebula Violet (#ab7bff), the one sanctioned second light — DESIGN.md "The Live Exception".
const NEBULA_VIOLET = "\x1b[38;2;171;123;255m";

const LIVE_URL = "https://www.twitch.tv/fluncle";

let logged: string[] = [];
let fetchedUrls: string[] = [];

function setTty(value: boolean): void {
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value });
}

function stubFetch(respond: () => Promise<Response>): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    fetchedUrls.push(url);

    return respond();
  }) as typeof globalThis.fetch;
}

/** Answer the status read with a body, as the Worker's /api/v1/status would. */
function stubStatus(body: unknown, init?: ResponseInit): void {
  stubFetch(() => Promise.resolve(new Response(JSON.stringify(body), init)));
}

beforeEach(() => {
  logged = [];
  fetchedUrls = [];
  // The CI runner sets CI=true ambiently; clear it (and the opt-out) so a case
  // controls its own environment. The gate cases set the vars themselves.
  delete process.env.CI;
  delete process.env.FLUNCLE_NO_LIVE_CALLOUT;
  delete process.env.NO_COLOR;
  console.log = (...parts: unknown[]) => {
    logged.push(parts.map((part) => String(part)).join(" "));
  };
});

afterEach(() => {
  console.log = originalLog;
  globalThis.fetch = originalFetch;
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: originalIsTty });

  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("shouldSkip", () => {
  test("a normal human command carries the callout", () => {
    expect(shouldSkip(["recent"])).toBe(false);
    expect(shouldSkip(["add", "some track"])).toBe(false);
  });

  test("no args at all is skipped (the bare help screen)", () => {
    expect(shouldSkip([])).toBe(true);
  });

  test("the admin group and help are skipped", () => {
    expect(shouldSkip(["admin", "tracks", "update"])).toBe(true);
    expect(shouldSkip(["help"])).toBe(true);
  });

  test("machine-readable and help/version flags are skipped", () => {
    expect(shouldSkip(["recent", "--json"])).toBe(true);
    expect(shouldSkip(["recent", "--help"])).toBe(true);
    expect(shouldSkip(["recent", "-h"])).toBe(true);
    expect(shouldSkip(["--version"])).toBe(true);
    expect(shouldSkip(["-V"])).toBe(true);
  });

  test("CI opts out, so a build log never carries the flourish", () => {
    process.env.CI = "true";
    expect(shouldSkip(["recent"])).toBe(true);
  });

  test("FLUNCLE_NO_LIVE_CALLOUT=1 opts out, for a scripted rig", () => {
    process.env.FLUNCLE_NO_LIVE_CALLOUT = "1";
    expect(shouldSkip(["recent"])).toBe(true);
  });
});

describe("maybePrintLiveCallout", () => {
  test("prints one line naming the decks and the URL while Fluncle is live", async () => {
    setTty(true);
    stubStatus({ live: { on: true, title: "Late transmission", url: LIVE_URL } });

    await maybePrintLiveCallout(["recent"]);

    expect(logged).toHaveLength(1);
    // The ratified cross-surface phrasing — it mirrors the SSH terminal's live line
    // (apps/ssh/main.go). Changing it here alone would split the two surfaces.
    expect(logged[0]).toContain("On the decks, live now");
    // The scheme and leading www. are stripped for a clean terminal readout.
    expect(logged[0]).toContain("twitch.tv/fluncle");
    expect(fetchedUrls[0]).toContain("/api/v1/status");
  });

  test("colors the line Nebula Violet, and goes plain under NO_COLOR", async () => {
    setTty(true);
    stubStatus({ live: { on: true, title: null, url: LIVE_URL } });

    await maybePrintLiveCallout(["recent"]);

    expect(logged[0]).toContain(NEBULA_VIOLET);

    logged = [];
    process.env.NO_COLOR = "1";

    await maybePrintLiveCallout(["recent"]);

    expect(logged).toHaveLength(1);
    expect(logged[0]).not.toContain("\x1b");
    expect(logged[0]).toContain("On the decks, live now");
  });

  test("prints nothing when Fluncle is off the decks", async () => {
    setTty(true);
    stubStatus({ live: { on: false, title: null, url: LIVE_URL } });

    await maybePrintLiveCallout(["recent"]);

    expect(logged).toEqual([]);
  });

  test("prints nothing when the status payload carries no live object", async () => {
    setTty(true);
    stubStatus({});

    await maybePrintLiveCallout(["recent"]);

    expect(logged).toEqual([]);
  });

  test("no-ops without touching the network when stdout is not a TTY", async () => {
    setTty(false);
    stubStatus({ live: { on: true, title: null, url: LIVE_URL } });

    await maybePrintLiveCallout(["recent"]);

    expect(logged).toEqual([]);
    expect(fetchedUrls).toEqual([]);
  });

  test("no-ops without touching the network on a skipped command", async () => {
    setTty(true);
    stubStatus({ live: { on: true, title: null, url: LIVE_URL } });

    await maybePrintLiveCallout(["admin", "tracks", "update"]);
    await maybePrintLiveCallout(["recent", "--json"]);

    expect(logged).toEqual([]);
    expect(fetchedUrls).toEqual([]);
  });

  test("swallows a failed request silently — a command is never affected", async () => {
    setTty(true);
    stubFetch(() => Promise.reject(new Error("offline")));

    // Resolving (rather than rejecting) is the whole guarantee: main() awaits this.
    expect(await maybePrintLiveCallout(["recent"])).toBeUndefined();
    expect(logged).toEqual([]);
  });

  test("swallows a non-ok response silently", async () => {
    setTty(true);
    stubStatus({ live: { on: true, title: null, url: LIVE_URL } }, { status: 500 });

    expect(await maybePrintLiveCallout(["recent"])).toBeUndefined();
    expect(logged).toEqual([]);
  });

  test("swallows a malformed body silently", async () => {
    setTty(true);
    stubFetch(() => Promise.resolve(new Response("not json")));

    expect(await maybePrintLiveCallout(["recent"])).toBeUndefined();
    expect(logged).toEqual([]);
  });
});
