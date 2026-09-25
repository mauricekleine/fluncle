import { describe, expect, test } from "bun:test";

import { buildBioBody } from "./admin-artists";

const BIO = "A drum and bass producer with a long run of releases behind them.";

describe("buildBioBody", () => {
  test("sends the bio alone by default — no dryRun, no finalAttempt, no promptVersion", () => {
    expect(buildBioBody({ bio: BIO })).toEqual({ bio: BIO });
  });

  test("omits finalAttempt entirely when it is false or undefined", () => {
    expect(buildBioBody({ bio: BIO, finalAttempt: false })).toEqual({ bio: BIO });
    expect(buildBioBody({ bio: BIO, finalAttempt: undefined })).toEqual({ bio: BIO });
  });

  test("sends finalAttempt ONLY when the caller asked for it", () => {
    expect(buildBioBody({ bio: BIO, finalAttempt: true })).toEqual({
      bio: BIO,
      finalAttempt: true,
    });
  });

  test("carries the dry run and the prompt-version provenance alongside it", () => {
    expect(buildBioBody({ bio: BIO, dryRun: true, finalAttempt: true, promptVersion: 0 })).toEqual({
      bio: BIO,
      dryRun: true,
      finalAttempt: true,
      promptVersion: 0,
    });
  });
});
