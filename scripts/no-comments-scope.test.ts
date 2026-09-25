import { expect, test } from "bun:test";

import { inScope, noCommentsScope, noCommentsScopePatterns } from "./no-comments-scope";

test("root and nested web lint configs enforce no-comments globally", async () => {
  expect(await noCommentsScopePatterns()).toEqual(["**", "apps/web/**"]);
  const scope = await noCommentsScope();
  expect(inScope(".github/workflows/quality-checks.yml", scope)).toBe(true);
  expect(inScope("apps/web/.oxlintrc.json", scope)).toBe(true);
});
