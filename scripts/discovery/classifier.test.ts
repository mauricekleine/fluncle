import { expect, test } from "bun:test";

import { classifyPaths } from "../quality/classifier.mjs";

test("style spike uses the repository scripts quality lane", () => {
  const plan = classifyPaths(["scripts/discovery/style_spike.py"]);

  expect(plan.lanes.scripts).toBe(true);
  expect(plan.full).toBe(false);
  expect(plan.lanes.e2e).toBe(false);
  expect(plan.unknownFiles).toEqual([]);
});
