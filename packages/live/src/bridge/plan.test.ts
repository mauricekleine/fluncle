// The plan-ref routing: `--plan` takes a mixtape COORDINATE (`NNN.G.CC`) OR a plan HANDLE
// (a galaxy slug — the normal live flow). The shape decides which resolver runs; the
// wrong call silently loads the wrong set, so the shape-detection + candidate selection is
// pure and tested directly (no network / no admin token).

import { describe, expect, test } from "bun:test";

import { classifyPlanRef, isLogId, matchPlanByHandle, parseDotenv } from "./plan.ts";

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
