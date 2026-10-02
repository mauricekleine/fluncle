import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { classifyPaths, cloudflareExcludePatterns, triggersWorkerBuild } from "./classifier.mjs";
import { commandsForLane } from "./run-lane.mjs";

describe("dependency-closure classifier", () => {
  test("an empty change set fails closed unless the caller proves a comparison base", () => {
    expect(classifyPaths([]).full).toBe(true);

    const local = classifyPaths([], { emptyChangeSet: "pass" });
    expect(local.full).toBe(false);
    expect(local.packages).toEqual([]);
    expect(local.lanes.e2e).toBe(false);
    expect(local.lanes.static).toBe(false);
    expect(
      [
        "static",
        "packages",
        "scripts",
        "label-triage-python",
        "go-ssh",
        "go-dns",
        "sonar",
        "workflows",
        "e2e",
      ].flatMap((lane) => commandsForLane(local, lane)),
    ).toEqual([]);
  });

  test("a CLI-only change excludes web E2E and includes the CLI", () => {
    const plan = classifyPaths(["apps/cli/src/commands/recent.ts"]);

    expect(plan.lanes.e2e).toBe(false);
    expect(plan.packages).toContain("@fluncle/cli");
    expect(plan.packages).not.toContain("@fluncle/web");
    expect(plan.release.cli).toBe(true);
  });

  test("shared contracts select every dependent including public web", () => {
    const plan = classifyPaths(["packages/contracts/src/orpc/tracks.ts"]);

    expect(plan.packages).toEqual(
      expect.arrayContaining([
        "@fluncle/cli",
        "@fluncle/extension",
        "@fluncle/mobile",
        "@fluncle/video",
        "@fluncle/web",
        "fluncle-raycast",
      ]),
    );
    expect(plan.lanes.e2e).toBe(true);
  });

  test("web migrations preserve migration and deterministic browser contracts", () => {
    const plan = classifyPaths(["apps/web/drizzle/0099_example.sql"]);

    expect(plan.lanes.migrations).toBe(true);
    expect(plan.lanes.e2e).toBe(true);
    expect(plan.packages).toContain("@fluncle/web");
  });

  test("Go, Rust, extension, mobile, Raycast, and media stay isolated", () => {
    const cases = [
      ["apps/ssh/main.go", "goSsh"],
      ["apps/dns/main.go", "goDns"],
      ["apps/sonar/src/main.rs", "sonar"],
    ] as const;

    for (const [path, lane] of cases) {
      const plan = classifyPaths([path]);
      expect(plan.lanes[lane], path).toBe(true);
      expect(plan.lanes.e2e, path).toBe(false);
    }

    for (const [path, packageName] of [
      ["apps/extension/src/background.ts", "@fluncle/extension"],
      ["apps/mobile/app/index.tsx", "@fluncle/mobile"],
      ["apps/raycast/src/recent.tsx", "fluncle-raycast"],
      ["packages/media/src/index.ts", "@fluncle/media"],
    ]) {
      const plan = classifyPaths([path]);
      expect(plan.packages, path).toContain(packageName);
      expect(plan.lanes.e2e, path).toBe(false);
    }
  });

  test("standalone scripts select their dedicated checks", () => {
    expect(classifyPaths(["docs/agents/hermes/scripts/crawl-sweep.ts"]).lanes.scripts).toBe(true);
  });

  test("label-triage scripts select Python without forcing the full matrix", () => {
    for (const path of [
      "packages/skills/fluncle-label-triage/scripts/merge-round.py",
      "packages/skills/fluncle-label-triage/scripts/tests/test_merge_verify.py",
      "packages/skills/fluncle-label-triage/scripts/triage-workflow.js",
      ".agents/skills/fluncle-label-triage/scripts/merge-round.py",
    ]) {
      const plan = classifyPaths([path]);
      expect(plan.full, path).toBe(false);
      expect(plan.unknownFiles, path).toEqual([]);
      expect(plan.lanes.e2e, path).toBe(false);
      expect(commandsForLane(plan, "label-triage-python"), path).toEqual([
        { args: ["run", "test:label-triage:python"], options: {}, program: "bun" },
      ]);
    }
  });

  test("unrelated owned paths exclude label-triage Python", () => {
    for (const path of [
      "docs/label-entity.md",
      "apps/cli/src/cli.ts",
      "apps/web/src/routes/index.tsx",
      "scripts/ux-capture.ts",
      ".agents/skills/other/scripts/helper.py",
    ]) {
      expect(commandsForLane(classifyPaths([path]), "label-triage-python"), path).toEqual([]);
    }
  });

  test("scheduled and explicit full backstops include label-triage Python", () => {
    expect(
      classifyPaths(["docs/label-entity.md"], { forceFull: true }).lanes.labelTriagePython,
    ).toBe(true);
    expect(classifyPaths([]).lanes.labelTriagePython).toBe(true);
  });

  test("the pipeline evaluator selects web checks for its web integration consumer", () => {
    const plan = classifyPaths(["docs/agents/hermes/scripts/pipeline-watch-evaluate.ts"]);
    expect(plan.full).toBe(false);
    expect(plan.lanes.scripts).toBe(true);
    expect(plan.lanes.e2e).toBe(true);
    expect(plan.packages).toContain("@fluncle/web");
  });

  test("discovery capture selects scripts without public-web E2E", () => {
    const plan = classifyPaths([
      "scripts/ux-capture.ts",
      "scripts/ux-capture/report.ts",
      "scripts/ux-capture/report.test.ts",
    ]);

    expect(plan.full).toBe(false);
    expect(plan.unknownFiles).toEqual([]);
    expect(plan.lanes.scripts).toBe(true);
    expect(plan.lanes.e2e).toBe(false);
  });

  test("workflow, lockfile, root config, harness, and unknown paths fail closed", () => {
    for (const path of [
      ".github/workflows/quality-checks.yml",
      ".claude/settings.json",
      ".codex/hooks.json",
      ".husky/pre-commit",
      "bun.lock",
      "scripts/quality/classifier.mjs",
      "turbo.json",
      "new-top-level-surface/file.ts",
    ]) {
      const plan = classifyPaths([path]);
      expect(plan.full, path).toBe(true);
      expect(plan.lanes.e2e, path).toBe(true);
      expect(plan.lanes.goDns, path).toBe(true);
      expect(plan.lanes.sonar, path).toBe(true);
      expect(plan.lanes.labelTriagePython, path).toBe(true);
    }

    expect(
      classifyPaths(["apps/sonar/src/main.rs", "apps/new-unowned/surface.ts"]).unknownFiles,
    ).toEqual(["apps/new-unowned/surface.ts"]);
  });

  test("worktree setup files run only the static lane", () => {
    const plan = classifyPaths([".config/wt.toml", ".worktreeinclude"]);

    expect(plan.full).toBe(false);
    expect(plan.unknownFiles).toEqual([]);
    expect(plan.packages).toEqual([]);
    expect(plan.lanes).toEqual({
      docs: false,
      e2e: false,
      goDns: false,
      goSsh: false,
      labelTriagePython: false,
      migrations: false,
      scripts: false,
      sonar: false,
      static: true,
      workflows: false,
    });
  });

  test("documentation does not run public-web E2E", () => {
    const plan = classifyPaths(["docs/search.md"]);
    expect(plan.lanes.docs).toBe(true);
    expect(plan.lanes.e2e).toBe(false);
    expect(plan.packages).toEqual([]);
  });
});

describe("Cloudflare deploy watch paths", () => {
  test("the committed Cloudflare pattern list is deterministic", () => {
    expect(cloudflareExcludePatterns()).toContain("docs/*");
    expect(cloudflareExcludePatterns()).toContain(".github/*");
    expect(cloudflareExcludePatterns()).toContain("AGENTS.md");
    expect(new Set(cloudflareExcludePatterns()).size).toBe(cloudflareExcludePatterns().length);
  });

  test("excluded-only changes skip deploy while product and unknown paths deploy", () => {
    expect(triggersWorkerBuild("docs/search.md")).toBe(false);
    expect(triggersWorkerBuild("apps/cli/src/cli.ts")).toBe(false);
    expect(triggersWorkerBuild("apps/web/src/routes/index.tsx")).toBe(true);
    expect(triggersWorkerBuild("packages/contracts/src/orpc/tracks.ts")).toBe(true);
    expect(triggersWorkerBuild("packages/new-shared/src/index.ts")).toBe(true);
  });

  test("an agent-skill-only change is an expected deploy skip, never a waited-for build", () => {
    const skillsOnly = [
      ".agents/skills/fluncle-rfc-writer/SKILL.md",
      ".claude/skills/fluncle-rfc-writer",
      "packages/skills/fluncle-rfc-writer/SKILL.md",
      "packages/skills/fluncle-rfc-writer/references/rfc-template.md",
      "skills-lock.json",
    ];

    for (const path of skillsOnly) {
      expect(triggersWorkerBuild(path)).toBe(false);
    }
    expect(classifyPaths(skillsOnly).deploy).toBe(false);
    expect(classifyPaths(skillsOnly).full).toBe(true);
    expect(cloudflareExcludePatterns()).toEqual(
      expect.arrayContaining(["packages/skills/*", "skills-lock.json"]),
    );
  });

  test("agent-skill sources stay outside every workspace the Worker can build", () => {
    const repositoryRoot = join(import.meta.dir, "..", "..");

    expect(existsSync(join(repositoryRoot, "packages/skills/package.json"))).toBe(false);
    expect(existsSync(join(repositoryRoot, ".agents/package.json"))).toBe(false);
  });

  test("Cloudflare bypasses watch paths for empty, 3000-file, and 20-commit pushes", () => {
    expect(classifyPaths([]).deploy).toBe(true);
    expect(
      classifyPaths(Array.from({ length: 3_000 }, (_, index) => `docs/${index}.md`)).deploy,
    ).toBe(true);
    expect(classifyPaths(["docs/only.md"], { commitCount: 20 }).deploy).toBe(true);
    expect(classifyPaths(["docs/only.md"], { commitCount: 19 }).deploy).toBe(false);
  });
});
