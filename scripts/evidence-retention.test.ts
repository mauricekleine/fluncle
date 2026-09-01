import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// The retained-evidence CONTRACT: every browser-evidence directory a spec or the discovery walk
// writes under the gitignored `apps/web/.dev/` is uploaded by a workflow as a run artifact for
// the 90-day ceiling a public repo allows, on every run (green or red), and an empty directory
// fails the upload. The directories are gitignored on purpose (apps/web/tests/e2e/README.md), so
// the artifact IS the durable home — a workflow edit that drops one, shortens its retention, or
// makes it green-only would silently turn evidence into a claim with nothing behind it.

const root = join(import.meta.dir, "..");
const workflowDir = join(root, ".github", "workflows");

/** The evidence directories and the workflow that must retain each. */
const EVIDENCE = [
  ["apps/web/.dev/front-door/", "e2e.yml"],
  ["apps/web/.dev/track-journey/", "e2e.yml"],
  ["apps/web/.dev/search/", "e2e.yml"],
  ["apps/web/.dev/discovery-events/", "e2e.yml"],
  ["apps/web/.dev/discovery-walk/", "discovery-walk.yml"],
] as const;

type Upload = {
  always: boolean;
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
      always: /^\s*if:\s*always\(\)\s*$/m.test(step),
      ifNoFiles: /^\s*if-no-files-found:\s*(\S+)/m.exec(step)?.[1],
      name: /^\s*name:\s*(\S+)/m.exec(step)?.[1],
      path: /^\s*path:\s*(\S+)/m.exec(step)?.[1],
      retention: Number(/^\s*retention-days:\s*(\d+)/m.exec(step)?.[1]),
    }));
}

describe("retained browser evidence", () => {
  test.each(EVIDENCE)(
    "%s is uploaded by %s for 90 days on every run, and never empty",
    (path, file) => {
      const upload = uploads(file).find((candidate) => candidate.path === path);

      expect(upload, `${file} uploads ${path}`).toBeDefined();
      expect(upload?.retention).toBe(90);
      expect(upload?.always).toBe(true);
      expect(upload?.ifNoFiles).toBe("error");
    },
  );

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
