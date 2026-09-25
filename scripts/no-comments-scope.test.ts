import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { noCommentsScopePatterns, REPOSITORY } from "./no-comments-scope";

describe("no-comments rollout scope", () => {
  test("apps/web paths live in the web config, where its nested oxlint config enforces them", async () => {
    const root = Bun.JSONC.parse(await readFile(`${REPOSITORY}.oxlintrc.json`, "utf8")) as {
      overrides?: { files?: string[]; rules?: Record<string, string> }[];
    };
    const rootPatterns = (root.overrides ?? [])
      .filter((entry) => entry.rules?.["no-comments/no-comments"] === "error")
      .flatMap((entry) => entry.files ?? []);

    expect(rootPatterns.filter((pattern) => pattern.startsWith("apps/web/"))).toEqual([]);
  });

  test("the gates see web-scoped paths under their repository-relative names", async () => {
    const patterns = await noCommentsScopePatterns();
    const web = Bun.JSONC.parse(await readFile(`${REPOSITORY}apps/web/.oxlintrc.json`, "utf8")) as {
      overrides?: { files?: string[] }[];
    };
    const webPatterns = (web.overrides ?? []).flatMap((entry) => entry.files ?? []);

    for (const pattern of webPatterns) {
      expect(patterns).toContain(`apps/web/${pattern}`);
    }
  });
});
