import { expect, test } from "bun:test";
import { join } from "node:path";

test("reboot status HTTP contract", () => {
  const result = Bun.spawnSync([
    "python3",
    "-B",
    "-m",
    "unittest",
    "discover",
    "-s",
    join(import.meta.dir, "../packages/skills/fluncle-hetzner-ops/scripts/tests"),
  ]);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
}, 15_000);
