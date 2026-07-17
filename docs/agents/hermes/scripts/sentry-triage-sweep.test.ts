// Unit tests for the pure logic in sentry-triage-sweep.ts — the parts that decide WHAT gets
// triaged and HOW the stateless loop reads its markers. The box scripts are self-contained (they
// cannot import the workspace) and live outside any package's test runner, so this file uses
// `bun:test` and is run directly:
//
//   bun test docs/agents/hermes/scripts/sentry-triage-sweep.test.ts
//
// The network functions take an injectable `fetchFn`, so `listUnresolvedIssues` (the windowing +
// pagination) is exercised here against a canned two-page response — no real Sentry call.

import { describe, expect, test } from "bun:test";
import {
  compactIssue,
  extractFrames,
  FILE_MARKER,
  filterNewIssues,
  filterRecentlyMerged,
  FIX_MARKER,
  listUnresolvedIssues,
  parseLedgerIds,
  parseMarkerIds,
  parseNextCursor,
  type CompactIssue,
} from "./sentry-triage-sweep";

describe("parseMarkerIds — the PR-body contract", () => {
  const body = `Fixes the crash.\n\nSentry-Issue: 4507111\nSentry-Issue: #4507222\nsentry-issue: 4507333\n`;

  test("reads every Sentry-Issue ref (case-insensitive, tolerant of a leading #)", () => {
    expect(parseMarkerIds(body, FIX_MARKER)).toEqual(["4507111", "4507222", "4507333"]);
  });

  test("keeps the two markers disjoint — a fix ref is never read as a filed ref", () => {
    const ledgerBody = "Filed for review.\n\nSentry-Filed: 900\nSentry-Filed: 901\n";
    expect(parseMarkerIds(ledgerBody, FILE_MARKER)).toEqual(["900", "901"]);
    // The ledger PR carries NO Sentry-Issue line, so reconcile never resolves a filed issue.
    expect(parseMarkerIds(ledgerBody, FIX_MARKER)).toEqual([]);
  });

  test("dedupes repeated refs", () => {
    expect(parseMarkerIds("Sentry-Issue: 7\nSentry-Issue: 7\n", FIX_MARKER)).toEqual(["7"]);
  });
});

describe("parseLedgerIds — the invisible dedupe marker", () => {
  test("reads the sentry_id out of committed ledger rows", () => {
    const ledger = `| 2026-07-18 | fluncle-web | FLUNCLE-WEB-1A | boom | needs a human | open | url | <!-- sentry_id:4507999 --> |
| 2026-07-18 | fluncle-worker | FLUNCLE-WORKER-2B | bang | risky | open | url | <!-- sentry_id: 4508000 --> |`;
    expect(parseLedgerIds(ledger)).toEqual(["4507999", "4508000"]);
  });

  test("no markers → no ids (a fresh ledger is not covered)", () => {
    expect(parseLedgerIds("| filed | project | ... |\n")).toEqual([]);
  });
});

describe("filterNewIssues — the dedupe gate", () => {
  const issue = (id: string, count = 0): CompactIssue => ({
    count,
    culprit: "",
    firstSeen: "",
    id,
    lastSeen: "",
    level: "error",
    permalink: "",
    project: "fluncle-web",
    shortId: `S-${id}`,
    title: "t",
    type: "",
    value: "",
  });

  test("drops issues already covered by an open PR or the ledger", () => {
    const all = [issue("1"), issue("2"), issue("3")];
    const covered = new Set(["2"]);
    expect(filterNewIssues(all, covered).map((i) => i.id)).toEqual(["1", "3"]);
  });

  test("an empty covered set passes everything through", () => {
    const all = [issue("1"), issue("2")];
    expect(filterNewIssues(all, new Set()).map((i) => i.id)).toEqual(["1", "2"]);
  });
});

describe("filterRecentlyMerged — reconcile only resolves fresh merges", () => {
  const now = Date.parse("2026-07-18T03:30:00Z");
  const WINDOW = 48 * 60 * 60_000;
  const pr = (number: number, mergedAt: string | null) => ({
    body: `Sentry-Issue: ${number}`,
    headRefName: `sentry-triage/x-${number}`,
    mergedAt,
    number,
    url: `https://github.com/x/pull/${number}`,
  });

  test("keeps a PR merged inside the window, drops one merged before it", () => {
    const fresh = pr(1, "2026-07-17T20:00:00Z"); // ~7.5h ago
    const stale = pr(2, "2026-07-10T00:00:00Z"); // 8 days ago — a regression here must re-surface
    const kept = filterRecentlyMerged([fresh, stale], now, WINDOW);
    expect(kept.map((p) => p.number)).toEqual([1]);
  });

  test("drops a PR with no mergedAt (an open PR that slipped into the list)", () => {
    expect(filterRecentlyMerged([pr(3, null)], now, WINDOW)).toEqual([]);
  });

  test("the boundary is inclusive — exactly windowMs old still counts", () => {
    const edge = pr(4, new Date(now - WINDOW).toISOString());
    expect(filterRecentlyMerged([edge], now, WINDOW).map((p) => p.number)).toEqual([4]);
  });

  test("an unparseable mergedAt is dropped, never resolved", () => {
    expect(filterRecentlyMerged([pr(5, "not-a-date")], now, WINDOW)).toEqual([]);
  });
});

describe("compactIssue — normalizing the Sentry list shape", () => {
  test("pulls the error type + value out of metadata and coerces count", () => {
    const raw = {
      count: "42",
      culprit: "renderRow(app/row.tsx)",
      firstSeen: "2026-07-01T00:00:00Z",
      id: "4507111",
      lastSeen: "2026-07-18T00:00:00Z",
      level: "error",
      metadata: { type: "TypeError", value: "Cannot read properties of undefined" },
      permalink: "https://de.sentry.io/organizations/fluncle/issues/4507111/",
      shortId: "FLUNCLE-WEB-1A",
      title: "TypeError: Cannot read properties of undefined",
    };
    const c = compactIssue(raw, "fluncle-web");
    expect(c.count).toBe(42);
    expect(c.type).toBe("TypeError");
    expect(c.value).toBe("Cannot read properties of undefined");
    expect(c.project).toBe("fluncle-web");
  });

  test("falls back to the culprit when metadata.value is absent, and defaults level", () => {
    const c = compactIssue({ culprit: "boot()", id: "9" }, "fluncle-worker");
    expect(c.value).toBe("boot()");
    expect(c.level).toBe("error");
    expect(c.count).toBe(0);
  });
});

describe("parseNextCursor — bounded pagination", () => {
  test("returns the next cursor when results=true", () => {
    const link =
      '<https://de.sentry.io/...>; rel="previous"; results="false"; cursor="0:0:1", ' +
      '<https://de.sentry.io/...>; rel="next"; results="true"; cursor="0:100:0"';
    expect(parseNextCursor(link)).toBe("0:100:0");
  });

  test("stops when the next page has results=false", () => {
    const link = '<...>; rel="next"; results="false"; cursor="0:100:0"';
    expect(parseNextCursor(link)).toBeUndefined();
  });

  test("no Link header → no next page", () => {
    expect(parseNextCursor(null)).toBeUndefined();
  });
});

describe("extractFrames — the crash-site hint", () => {
  test("keeps only in-app frames, deepest last", () => {
    const event = {
      entries: [
        {
          data: {
            values: [
              {
                stacktrace: {
                  frames: [
                    { filename: "node_modules/x.js", function: "vendor", inApp: false, lineNo: 1 },
                    { filename: "src/a.ts", function: "a", inApp: true, lineNo: 10 },
                    { filename: "src/b.ts", function: "b", inApp: true, lineNo: 22 },
                  ],
                },
              },
            ],
          },
          type: "exception",
        },
      ],
    };
    expect(extractFrames(event)).toEqual([
      { file: "src/a.ts", function: "a", line: 10 },
      { file: "src/b.ts", function: "b", line: 22 },
    ]);
  });

  test("a payload with no exception entry yields no frames", () => {
    expect(extractFrames({ entries: [{ type: "message" }] })).toEqual([]);
  });
});

describe("listUnresolvedIssues — pagination + compaction against an injected fetch", () => {
  function pageResponse(rows: unknown[], nextCursor?: string): Response {
    const link = nextCursor
      ? `<x>; rel="next"; results="true"; cursor="${nextCursor}"`
      : `<x>; rel="next"; results="false"; cursor="0:0:0"`;
    return new Response(JSON.stringify(rows), { headers: { link }, status: 200 });
  }

  test("walks every page and compacts each row", async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string | URL | Request) => {
      const u = typeof url === "string" ? url : url instanceof URL ? url.href : "";
      calls.push(u);
      if (!u.includes("cursor=")) {
        return pageResponse([{ id: "1", metadata: { type: "E" }, shortId: "A-1" }], "0:100:0");
      }
      return pageResponse([{ id: "2", metadata: { type: "E" }, shortId: "A-2" }]);
    }) as typeof fetch;

    const issues = await listUnresolvedIssues("fluncle-web", "tok", { fetchFn });
    expect(issues.map((i) => i.id)).toEqual(["1", "2"]);
    expect(calls.length).toBe(2); // one follow-up page, then stop
    expect(calls[0]).toContain("/projects/fluncle/fluncle-web/issues/");
    expect(calls[0]).toContain("is%3Aunresolved");
  });

  test("throws on a non-OK response so the driver records the per-project error", async () => {
    const fetchFn = (async () => new Response("forbidden", { status: 403 })) as typeof fetch;
    let message = "";
    try {
      await listUnresolvedIssues("fluncle-web", "bad", { fetchFn });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("403");
  });
});
