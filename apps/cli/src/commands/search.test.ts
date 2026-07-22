import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import * as realApi from "../api";

// The `search` command is a thin HTTP client over `search_archive`. The mock
// serves one envelope; assertions ride on how the output shapes it — a jump
// line, entity links, and the coordinate-led / `—`-fallback track table (the
// Unlit Rule, matching `fresh`).
let apiResponse: unknown = { entities: [], ok: true, results: [] };
let lastPath = "";

await mock.module("../api", () => ({
  ...realApi,
  publicApiGet: async (path: string) => {
    lastPath = path;
    return apiResponse;
  },
}));

const jsonCalls: unknown[] = [];

await mock.module("../output", () => ({
  printJson: (value: unknown) => {
    jsonCalls.push(value);
  },
}));

const { searchCommand } = await import("./search");

let logs: string[] = [];

beforeEach(() => {
  apiResponse = { entities: [], ok: true, results: [] };
  lastPath = "";
  jsonCalls.length = 0;
  logs = [];
  spyOn(console, "log").mockImplementation((message?: unknown) => {
    logs.push(String(message));
  });
});

const output = (): string => logs.join("\n");

describe("searchCommand", () => {
  test("the query rides through as ?q=, joined from the variadic argument", async () => {
    await searchCommand({ json: false, limit: undefined, query: "hospital records" });

    expect(lastPath).toBe("/api/v1/search/archive?q=hospital+records");
  });

  test("--limit is appended when set", async () => {
    await searchCommand({ json: false, limit: 5, query: "break" });

    expect(lastPath).toBe("/api/v1/search/archive?q=break&limit=5");
  });

  test("a certified hit leads with its coordinate; an uncertified one gets the — fallback", async () => {
    apiResponse = {
      entities: [],
      ok: true,
      results: [
        { artists: ["Break"], certified: true, logId: "241.7.3A", title: "Lit One", trackId: "t1" },
        { artists: ["Quiet One"], certified: false, title: "Quiet Tune", trackId: "t2" },
      ],
    };
    await searchCommand({ json: false, limit: undefined, query: "break" });

    const text = output();
    expect(text).toContain("241.7.3A  Break — Lit One");
    // The uncertified row leads with the — fallback in the (padded) coordinate
    // column and carries no coordinate of its own.
    expect(text).toMatch(/^— +Quiet One — Quiet Tune$/m);
  });

  test("entity hits print with their page links", async () => {
    apiResponse = {
      entities: [
        { kind: "artist", name: "Break", slug: "break" },
        { kind: "label", name: "Metalheadz", slug: "metalheadz" },
      ],
      ok: true,
      results: [],
    };
    await searchCommand({ json: false, limit: undefined, query: "break" });

    const text = output();
    expect(text).toContain("Artist  Break  https://www.fluncle.com/artist/break");
    expect(text).toContain("Label  Metalheadz  https://www.fluncle.com/label/metalheadz");
  });

  test("a resolved coordinate/entity prints a jump line", async () => {
    apiResponse = {
      entities: [],
      ok: true,
      redirect: "/log/241.7.3A",
      results: [],
    };
    await searchCommand({ json: false, limit: undefined, query: "241.7.3A" });

    expect(output()).toContain("Jump to https://www.fluncle.com/log/241.7.3A");
  });

  test("no matches prints one plain line naming the query", async () => {
    await searchCommand({ json: false, limit: undefined, query: "zzzznope" });

    expect(output()).toBe('Nothing in the archive matches "zzzznope".');
  });

  test("--json passes the whole envelope through", async () => {
    apiResponse = { degraded: false, entities: [], kind: "empty", ok: true, results: [] };
    await searchCommand({ json: true, limit: undefined, query: "break" });

    const payload = jsonCalls[0] as { ok: boolean; kind: string };
    expect(payload.ok).toBe(true);
    expect(payload.kind).toBe("empty");
  });
});
