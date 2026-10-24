import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { parse } from "yaml";

type Step = { if?: string; name: string; run?: string };
const quality = parse(
  readFileSync(join(import.meta.dir, "../../.github/workflows/quality-checks.yml"), "utf8"),
);

function laneExecutions(leg: string) {
  const steps: Step[] = quality.jobs.core_lanes?.steps ?? [];
  const outputs = Object.fromEntries(
    [
      "turbo",
      "scripts",
      "label_triage_python",
      "go_ssh",
      "go_dns",
      "sonar",
      "migrations",
      "workflows",
    ].map((key) => [key, "true"]),
  );
  return steps
    .filter(
      (step) =>
        step.run?.includes("--lane ") &&
        (!step.if ||
          runInNewContext(step.if, {
            always: () => true,
            matrix: { leg },
            steps: { classify: { outputs } },
            success: () => true,
          })),
    )
    .map((step) => /--lane ([\w-]+)/.exec(step.run ?? "")?.[1])
    .sort((a, b) => (a ?? "").localeCompare(b ?? ""));
}

describe("parallel core evidence", () => {
  test("the full classifier plan runs every core lane exactly once across hosted legs", () => {
    expect(quality.jobs.core_lanes?.strategy).toEqual({
      "fail-fast": false,
      matrix: { leg: ["packages", "scripts", "native"] },
    });
    expect(quality.jobs.core_lanes?.["runs-on"]).toBe("ubuntu-latest");
    expect(laneExecutions("packages")).toEqual(["packages", "static", "workflows"]);
    expect(laneExecutions("scripts")).toEqual(["label-triage-python", "scripts"]);
    expect(laneExecutions("native")).toEqual(["go-dns", "go-ssh", "sonar"]);
  });

  test.each(["success", "failure", "cancelled", "skipped", ""])(
    "the protected core result enforces matrix result %s",
    (state) => {
      expect(quality.jobs.core?.needs).toEqual(["pr_state", "core_lanes"]);
      expect(quality.jobs.gate?.needs).toBe("pr_state");
      const step: Step | undefined = quality.jobs.core?.steps.find(
        (step: Step) => step.name === "Conclude selected core lanes",
      );
      expect(step?.run).toBeString();
      const result = spawnSync("bash", ["-c", step?.run ?? "exit 9"], {
        encoding: "utf8",
        env: { ...process.env, CORE_RESULT: state },
      });
      expect(result.status, result.stderr).toBe(state === "success" ? 0 : 1);
    },
  );
});
