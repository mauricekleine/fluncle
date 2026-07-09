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

describe("buildAllFindingsPlan", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  const text = (body: string): Response => new Response(body);
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

  test("enumerates every /log/<logId> from the sitemap, then enriches each", async () => {
    // A sitemap listing three findings (plus noise that must NOT be scraped as a logId), one
    // of which the public track route can't resolve to a coordinate (skipped, not fabricated).
    const sitemap = [
      "<urlset>",
      "<url><loc>https://www.fluncle.com/log/019.F.1A</loc></url>",
      "<url><loc>https://www.fluncle.com/log/011.9.8I</loc></url>",
      "<url><loc>https://www.fluncle.com/log/007.8.1B</loc></url>",
      "<url><loc>https://www.fluncle.com/mixtapes</loc></url>",
      "</urlset>",
    ].join("");

    // Every fetch in plan.ts passes a template-literal string URL, so the mock types its
    // arg as `string` (the whole mock is cast via `unknown` to the wider `fetch` signature).
    globalThis.fetch = mock(async (url: string): Promise<Response> => {
      if (url.endsWith("/sitemap.xml")) {
        return text(sitemap);
      }
      if (url.includes("/api/tracks/")) {
        const id = decodeURIComponent(url.split("/api/tracks/")[1]);
        // 007.8.1B has no minted coordinate → the route returns a track with no logId → skipped.
        if (id === "007.8.1B") {
          return json({ track: { artists: ["Ghost"], title: "unminted" } });
        }
        return json({
          track: { artists: [`Artist ${id}`], durationMs: 1000, logId: id, title: `T ${id}` },
        });
      }
      if (url.endsWith("/props.json")) {
        return json({ palette: { accent: "#abcdef" }, seed: 7, track: {} });
      }
      // scene.json + composition.tsx absent → enrich marks the entry non-replayable.
      return notFound();
    }) as unknown as typeof fetch;

    const plan = await buildAllFindingsPlan();

    // Two of the three sitemap findings resolve; the unminted one is dropped, not invented.
    expect(plan.map((p) => p.logId).sort()).toEqual(["011.9.8I", "019.F.1A"]);
    const first = plan.find((p) => p.logId === "019.F.1A");
    expect(first?.title).toBe("T 019.F.1A");
    expect(first?.artists).toEqual(["Artist 019.F.1A"]);
    expect(first?.palette?.accent).toBe("#abcdef");
    expect(first?.seed).toBe(7);
    expect(first?.replay?.replayable).toBe(false); // no composition.tsx on R2
  });

  test("a non-OK sitemap THROWS — fail fast + loud, never a silent dead show", async () => {
    globalThis.fetch = mock(async (): Promise<Response> => notFound()) as unknown as typeof fetch;
    const error = await capture(() => buildAllFindingsPlan());
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/sitemap fetch returned 404/);
  });

  test("a thrown fetch (network fault / 403) THROWS, naming the cause", async () => {
    globalThis.fetch = mock(async (): Promise<Response> => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const error = await capture(() => buildAllFindingsPlan());
    expect((error as Error).message).toMatch(/sitemap fetch failed/);
  });

  test("a sitemap with findings but NONE resolving THROWS (empty pool, no dead show)", async () => {
    // The sitemap lists a finding, but the public track route 404s it → no members → empty pool.
    globalThis.fetch = mock(async (url: string): Promise<Response> => {
      if (url.endsWith("/sitemap.xml")) {
        return text("<url><loc>https://www.fluncle.com/log/019.F.1A</loc></url>");
      }
      return notFound();
    }) as unknown as typeof fetch;
    const error = await capture(() => buildAllFindingsPlan());
    expect((error as Error).message).toMatch(/pool is empty/);
  });
});
