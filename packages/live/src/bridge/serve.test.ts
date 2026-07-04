// The plan-arg contract: `run show` passes `--plan <id>`, but the bridge can also be
// driven with a bare positional id or `FLUNCLE_PLAN_MIXTAPE`. parsePlanArg is the one
// place that reconciles all three — regressing it is how a requested plan silently
// became the literal "--plan" (and fell to the fixture). Pure, so it tests directly.

import { describe, expect, test } from "bun:test";

import { parsePlanArg } from "./serve";

describe("parsePlanArg", () => {
  test("flag form — `--plan <id>` (the shape run show passes)", () => {
    expect(parsePlanArg(["--plan", "019.F.1A"])).toBe("019.F.1A");
  });

  test("positional form — a bare id", () => {
    expect(parsePlanArg(["019.F.1A"])).toBe("019.F.1A");
  });

  test("env form — nothing on the argv falls back to FLUNCLE_PLAN_MIXTAPE", () => {
    expect(parsePlanArg([], "019.F.1A")).toBe("019.F.1A");
  });

  test("absent — no argv, no env → undefined (buildPlan then serves the fixture floor)", () => {
    expect(parsePlanArg([], undefined)).toBeUndefined();
  });

  test("the flag wins over the env fallback", () => {
    expect(parsePlanArg(["--plan", "020.F.2B"], "019.F.1A")).toBe("020.F.2B");
  });

  test("a dangling `--plan` with no value falls through to the env, not the literal flag", () => {
    expect(parsePlanArg(["--plan"], "019.F.1A")).toBe("019.F.1A");
  });

  test("an unrelated flag is skipped; a later positional id still resolves", () => {
    expect(parsePlanArg(["--one-mac", "019.F.1A"])).toBe("019.F.1A");
  });
});
