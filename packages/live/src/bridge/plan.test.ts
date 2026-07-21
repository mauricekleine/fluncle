// The plan-ref routing: `--plan` takes a mixtape COORDINATE (`NNN.G.CC`) OR a plan HANDLE
// (a galaxy slug — the normal live flow). The shape decides which resolver runs; the
// wrong call silently loads the wrong set, so the shape-detection + candidate selection is
// pure and tested directly (no network / no admin token).

import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  buildAllFindingsPlan,
  classifyPlanRef,
  isAllPlan,
  isLogId,
  isMixtapeCoordinate,
  matchPlanByHandle,
  parseDotenv,
} from "./plan.ts";

describe("isLogId", () => {
  test("real Fluncle coordinates match (findings + a mixtape)", () => {
    expect(isLogId("011.9.8I")).toBe(true);
    expect(isLogId("019.F.1A")).toBe(true); // a mixtape logId (F galaxy)
    expect(isLogId("007.8.1B")).toBe(true);
    expect(isLogId("032.0.4L")).toBe(true);
  });

  test("a galaxy-slug plan handle never matches", () => {
    expect(isLogId("dark-aurora-roller")).toBe(false);
    expect(isLogId("rolling-deep")).toBe(false);
  });

  test("near-misses and junk are not coordinates", () => {
    expect(isLogId("12.3.45")).toBe(false); // two leading digits
    expect(isLogId("011.9.8")).toBe(false); // one-char cell
    expect(isLogId("")).toBe(false);
    expect(isLogId("abc")).toBe(false);
  });

  test("surrounding whitespace is tolerated", () => {
    expect(isLogId("  019.F.1A  ")).toBe(true);
  });
});

describe("classifyPlanRef", () => {
  test("a coordinate routes to the mixtape-logId resolver", () => {
    expect(classifyPlanRef("019.F.1A")).toEqual({ kind: "logId", value: "019.F.1A" });
  });

  test("anything else routes to the plan-handle resolver (the live flow)", () => {
    expect(classifyPlanRef("dark-aurora-roller")).toEqual({
      kind: "handle",
      value: "dark-aurora-roller",
    });
  });

  test("the value is trimmed before it is routed", () => {
    expect(classifyPlanRef("  019.F.1A ")).toEqual({ kind: "logId", value: "019.F.1A" });
    expect(classifyPlanRef(" dark-aurora-roller ")).toEqual({
      kind: "handle",
      value: "dark-aurora-roller",
    });
  });
});

describe("matchPlanByHandle", () => {
  const plans = [
    { hasVideo: false, id: "p1", title: "dark-aurora-roller" },
    { hasVideo: false, id: "p2", title: "rolling-deep" },
  ];

  test("finds the plan whose galaxy-slug handle matches", () => {
    expect(matchPlanByHandle(plans, "dark-aurora-roller")?.id).toBe("p1");
  });

  test("comparison is case / space / underscore-insensitive", () => {
    expect(matchPlanByHandle(plans, "Dark Aurora Roller")?.id).toBe("p1");
    expect(matchPlanByHandle(plans, "dark_aurora_roller")?.id).toBe("p1");
  });

  test("no matching handle → null (buildPlan then holds + falls to the fixture)", () => {
    expect(matchPlanByHandle(plans, "no-such-plan")).toBeNull();
  });

  test("a TAKE (hasVideo) is never a plan, even on a title collision", () => {
    const withTake = [{ hasVideo: true, id: "t1", title: "dark-aurora-roller" }, ...plans];
    expect(matchPlanByHandle(withTake, "dark-aurora-roller")?.id).toBe("p1");
  });
});

describe("parseDotenv", () => {
  test("reads KEY=VALUE, strips quotes, skips comments + blanks", () => {
    const env = parseDotenv(
      ["# a comment", "", 'FLUNCLE_API_TOKEN="tok-123"', "FLUNCLE_API_BASE_URL=https://x.dev"].join(
        "\n",
      ),
    );
    expect(env.FLUNCLE_API_TOKEN).toBe("tok-123");
    expect(env.FLUNCLE_API_BASE_URL).toBe("https://x.dev");
  });

  test("a value containing '=' keeps everything after the first '='", () => {
    expect(parseDotenv("K=a=b=c").K).toBe("a=b=c");
  });
});

describe("isAllPlan", () => {
  test("the RANDOM-VJ sentinel matches, case- and whitespace-insensitively", () => {
    expect(isAllPlan("all")).toBe(true);
    expect(isAllPlan("ALL")).toBe(true);
    expect(isAllPlan("  All  ")).toBe(true);
  });

  test("everything else (a coordinate, a handle, nothing) is not VJ mode", () => {
    expect(isAllPlan("019.F.1A")).toBe(false);
    expect(isAllPlan("dark-aurora-roller")).toBe(false);
    expect(isAllPlan("allnighter")).toBe(false); // not the bare sentinel
    expect(isAllPlan(undefined)).toBe(false);
  });
});

describe("isMixtapeCoordinate", () => {
  test("the `F`-galaxy coordinate is a mixtape; a numeric galaxy is a finding", () => {
    expect(isMixtapeCoordinate("019.F.1A")).toBe(true); // Fluncle's own mixtape
    expect(isMixtapeCoordinate("019.1.7X")).toBe(false);
    expect(isMixtapeCoordinate("011.9.8I")).toBe(false);
  });

  test("is case- and whitespace-tolerant, and rejects non-coordinates", () => {
    expect(isMixtapeCoordinate("  019.f.1a ")).toBe(true);
    expect(isMixtapeCoordinate("dark-aurora-roller")).toBe(false);
    expect(isMixtapeCoordinate("")).toBe(false);
  });
});

describe("buildAllFindingsPlan", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  const notFound = (): Response => new Response("no", { status: 404 });

  // Await a call and return whatever it throws (or null) — bun's `.rejects` matcher reads as a
  // non-thenable to the type-aware linter, so capture the error directly (as track.test.ts does).
  const capture = async (run: () => Promise<unknown>): Promise<unknown> => {
    try {
      await run();
      return null;
    } catch (error) {
      return error;
    }
  };

  type TrackFeedRowBody = { logId: string; title: string; artists: string[]; durationMs: number };
  type TrackFeedPageBody = { tracks: TrackFeedRowBody[]; nextCursor?: string };

  /** A mock that serves the paginated feed from a cursor→page map, plus the R2 enrich fetches. */
  const feedMock = (
    pages: Record<string, TrackFeedPageBody>,
  ): ((url: string) => Promise<Response>) => {
    return async (url: string): Promise<Response> => {
      const u = new URL(url);
      if (u.pathname === "/api/v1/findings") {
        const cursor = u.searchParams.get("cursor") ?? "";
        const page = pages[cursor];
        return page ? json(page) : notFound();
      }
      if (u.pathname.endsWith("/props.json")) {
        return json({ palette: { accent: "#abcdef" }, seed: 7, track: {} });
      }
      // scene.json + composition.tsx absent → enrich marks the entry non-replayable.
      return notFound();
    };
  };

  test("drains the feed across pages, excludes the mixtape, and enriches each finding", async () => {
    // Page 1 (no cursor) carries the `F`-galaxy MIXTAPE + one finding, then points to page 2.
    globalThis.fetch = mock(
      feedMock({
        "": {
          nextCursor: "cursor==2", // base64-ish, contains `=` → must survive URL-encoding
          tracks: [
            { artists: ["Fluncle"], durationMs: 500, logId: "019.F.1A", title: "Mixtape" },
            { artists: ["A1"], durationMs: 1000, logId: "039.2.2E", title: "T1" },
          ],
        },
        "cursor==2": {
          tracks: [{ artists: ["A2"], durationMs: 2000, logId: "011.9.8I", title: "T2" }],
        },
      }),
    ) as unknown as typeof fetch;

    const plan = await buildAllFindingsPlan();

    // Both findings ride; the mixtape (019.F.1A) is filtered out of the VJ pool.
    expect(plan.map((p) => p.logId).sort()).toEqual(["011.9.8I", "039.2.2E"]);
    const first = plan.find((p) => p.logId === "039.2.2E");
    expect(first?.title).toBe("T1");
    expect(first?.artists).toEqual(["A1"]);
    expect(first?.palette?.accent).toBe("#abcdef"); // enrich still hits found.fluncle.com
    expect(first?.seed).toBe(7);
    expect(first?.replay?.replayable).toBe(false); // no composition.tsx on R2
  });

  test("a repeating cursor bails instead of paging forever", async () => {
    // The server keeps handing back the same cursor — the safety rail must break the loop.
    globalThis.fetch = mock(
      feedMock({
        "": {
          nextCursor: "loop",
          tracks: [{ artists: [], durationMs: 1, logId: "039.2.2E", title: "T" }],
        },
        loop: {
          nextCursor: "loop",
          tracks: [{ artists: [], durationMs: 1, logId: "007.8.1B", title: "T" }],
        },
      }),
    ) as unknown as typeof fetch;
    const error = await capture(() => buildAllFindingsPlan());
    expect((error as Error).message).toMatch(/repeating cursor/);
  });

  test("a non-OK page THROWS — fail fast + loud, never a silent dead show", async () => {
    globalThis.fetch = mock(async (): Promise<Response> => notFound()) as unknown as typeof fetch;
    const error = await capture(() => buildAllFindingsPlan());
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/\/api\/v1\/findings returned 404/);
  });

  test("a thrown fetch (network fault / 403) THROWS, naming the cause", async () => {
    globalThis.fetch = mock(async (): Promise<Response> => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const error = await capture(() => buildAllFindingsPlan());
    expect((error as Error).message).toMatch(/\/api\/v1\/findings fetch failed/);
  });

  test("a feed of only the mixtape THROWS (empty pool after exclusion, no dead show)", async () => {
    globalThis.fetch = mock(
      feedMock({
        "": {
          tracks: [{ artists: ["Fluncle"], durationMs: 1, logId: "019.F.1A", title: "Mixtape" }],
        },
      }),
    ) as unknown as typeof fetch;
    const error = await capture(() => buildAllFindingsPlan());
    expect((error as Error).message).toMatch(/pool is empty/);
  });
});
