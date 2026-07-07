// The plan-arg contract: `run show` passes `--plan <id>`, but the bridge can also be
// driven with a bare positional id or `FLUNCLE_PLAN_MIXTAPE`. parsePlanArg is the one
// place that reconciles all three — regressing it is how a requested plan silently
// became the literal "--plan" (and fell to the fixture). Pure, so it tests directly.

import { describe, expect, test } from "bun:test";

import { type AdminAuth } from "./plan";
import { parsePlanArg, shouldFingerprintFullSong } from "./serve";

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

describe("shouldFingerprintFullSong", () => {
  // The Tier-A swap is gated: full song ONLY when a token AND the flag are both present.
  // This keeps merging Tier-A a live-path no-op until the operator flips the flag after
  // the M5 accuracy re-tune — a token alone (which the M5 always has) must NOT flip it.
  const auth: AdminAuth = { base: "https://www.fluncle.com", token: "t" };

  test("token + flag on → full song", () => {
    expect(shouldFingerprintFullSong(auth, "1")).toBe(true);
    expect(shouldFingerprintFullSong(auth, "true")).toBe(true);
    expect(shouldFingerprintFullSong(auth, "TRUE")).toBe(true); // case-insensitive
  });

  test("token + no flag → preview (the default, the merge no-op)", () => {
    expect(shouldFingerprintFullSong(auth, undefined)).toBe(false);
    expect(shouldFingerprintFullSong(auth, "")).toBe(false);
    expect(shouldFingerprintFullSong(auth, "0")).toBe(false);
    expect(shouldFingerprintFullSong(auth, "yes")).toBe(false); // only 1/true count as on
  });

  test("no token + flag on → preview (no credential to authorize the private fetch)", () => {
    expect(shouldFingerprintFullSong(null, "1")).toBe(false);
    expect(shouldFingerprintFullSong(null, "true")).toBe(false);
  });

  test("neither → preview", () => {
    expect(shouldFingerprintFullSong(null, undefined)).toBe(false);
  });
});
