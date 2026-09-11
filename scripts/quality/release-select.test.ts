import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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

  test("Hermes pin drift follows the published release workflow name", () => {
    const producerWorkflow = readFileSync(
      new URL("../../.github/workflows/cli-release.yml", import.meta.url),
      "utf8",
    );
    const producerNameMatch = producerWorkflow.match(/^name:\s*(.+)$/m);
    expect(producerNameMatch).not.toBeNull();
    if (!producerNameMatch) {
      throw new Error("CLI release workflow must declare a top-level name");
    }

    const consumerWorkflow = readFileSync(
      new URL("../../.github/workflows/hermes-pin-drift.yml", import.meta.url),
      "utf8",
    );

    const producerName = producerNameMatch[1].trim();
    expect(consumerWorkflow).toContain(`workflows: ["${producerName}"]`);
  });
});
