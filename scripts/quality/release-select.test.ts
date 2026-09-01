import { describe, expect, test } from "bun:test";
import { classifyPaths } from "./classifier.mjs";

describe("release selection contracts", () => {
  test("CLI tests do not mint a release but shipping source does", () => {
    expect(classifyPaths(["apps/cli/src/client.test.ts"]).release.cli).toBe(false);
    expect(classifyPaths(["apps/cli/src/client.ts"]).release.cli).toBe(true);
  });

  test("Sonar changes retain both validation and release proof", () => {
    const plan = classifyPaths(["apps/sonar/src/server.rs"]);
    expect(plan.lanes.sonar).toBe(true);
    expect(plan.release.sonar).toBe(true);
  });
});
