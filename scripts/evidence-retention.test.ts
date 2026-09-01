import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// The retained-evidence CONTRACT: selected deterministic E2E retains named evidence for shipped
// main commits for 30 days, while the separately scheduled discovery walk retains its record for
// the public-repository ceiling of 90 days. The directories are gitignored on purpose
// (apps/web/tests/e2e/README.md), so a missing artifact must fail instead of silently turning
// evidence into a claim with nothing behind it.

const root = join(import.meta.dir, "..");
const workflowDir = join(root, ".github", "workflows");

const SHIPPED_EVIDENCE = [
  "apps/web/.dev/front-door/",
  "apps/web/.dev/track-journey/",
  "apps/web/.dev/search/",
  "apps/web/.dev/discovery-events/",
] as const;

type Upload = {
  always: boolean;
  condition?: string;
  ifNoFiles?: string;
  name?: string;
  path?: string;
  retention?: number;
};

/** Every `upload-artifact` step in a workflow, read off the YAML text (the repo keeps no YAML parser). */
function uploads(file: string): Upload[] {
  const text = readFileSync(join(workflowDir, file), "utf8");
  const steps = text.split(/\n\s*- name:/).slice(1);

  return steps
    .filter((step) => step.includes("actions/upload-artifact@"))
    .map((step) => ({
      always: /^\s*if:\s*always\(\)/m.test(step),
      condition: /^\s*if:\s*(.+)$/m.exec(step)?.[1],
      ifNoFiles: /^\s*if-no-files-found:\s*(\S+)/m.exec(step)?.[1],
      name: /^\s*name:\s*(\S+)/m.exec(step)?.[1],
      path: /^\s*path:\s*(\S+)/m.exec(step)?.[1],
      retention: Number(/^\s*retention-days:\s*(\d+)/m.exec(step)?.[1]),
    }));
}

describe("retained browser evidence", () => {
  test.each(SHIPPED_EVIDENCE)(
    "%s is retained for selected shipped-main runs and never empty",
    (path) => {
      const file = "quality-checks.yml";
      const upload = uploads(file).find((candidate) => candidate.path === path);

      expect(upload, `${file} uploads ${String(path)}`).toBeDefined();
      expect(upload?.retention).toBe(30);
      expect(upload?.always).toBe(true);
      expect(upload?.condition).toContain("github.event_name == 'push'");
      expect(upload?.condition).toContain("github.ref == 'refs/heads/main'");
      expect(upload?.condition).toContain("steps.classify.outputs.e2e == 'true'");
      expect(upload?.ifNoFiles).toBe("error");
    },
  );

  test("the discovery walk is retained for 90 days on every run and never empty", () => {
    const upload = uploads("discovery-walk.yml").find(
      (candidate) => candidate.path === "apps/web/.dev/discovery-walk/",
    );

    expect(upload).toBeDefined();
    expect(upload?.retention).toBe(90);
    expect(upload?.always).toBe(true);
    expect(upload?.ifNoFiles).toBe("error");
  });

  test("the discovery walk runs the committed script against the served product on PRs and after a deploy", () => {
    const text = readFileSync(join(workflowDir, "discovery-walk.yml"), "utf8");

    expect(text).toContain("run: bun run walk:discovery");
    expect(text).toMatch(/^\s*pull_request:/m);
    expect(text).toMatch(/workflows:\s*\["Post-deploy Probe"\]/);
    expect(text).toContain("github.event.workflow_run.conclusion == 'success'");
    // The summary lands on the run page even when a journey failed.
    expect(text).toContain('summary.md >> "$GITHUB_STEP_SUMMARY"');
  });

  test("the walk script and its summary renderer are what the package alias runs", () => {
    const pkg = JSON.parse(readFileSync(join(root, "apps/web/package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts["walk:discovery"]).toBe("bun run scripts/discovery-walk.ts");
    expect(readdirSync(join(root, "apps/web/scripts"))).toEqual(
      expect.arrayContaining(["discovery-walk.ts", "discovery-walk-summary.ts"]),
    );
  });
});
