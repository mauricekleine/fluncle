import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const coverage = process.env.FLUNCLE_VITEST_COVERAGE ?? "true";
const arguments_ = process.argv.slice(2);

function finish(result: ReturnType<typeof spawnSync>) {
  if (result.signal) {
    process.kill(process.pid, result.signal);
  }
  process.exit(result.status ?? 1);
}

if (
  process.env.FLEET_CPU_CAP === "1" &&
  process.env.FLEET_BOAT_CHECK !== "0" &&
  arguments_.length === 0 &&
  (coverage === "true" || coverage === "false")
) {
  const result = spawnSync("hyperspeed-boat-check", ["--repo", root, "--coverage", coverage], {
    stdio: "inherit",
  });
  if (!result.error) {
    finish(result);
  }
  if ((result.error as NodeJS.ErrnoException).code !== "ENOENT") {
    throw result.error;
  }
}

finish(
  spawnSync(
    "node",
    [
      "../../node_modules/vitest/vitest.mjs",
      "run",
      `--coverage.enabled=${coverage}`,
      ...arguments_,
    ],
    { stdio: "inherit" },
  ),
);
