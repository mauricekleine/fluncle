import { describe, expect, test } from "bun:test";
import { classifyPaths, cloudflareExcludePatterns, triggersWorkerBuild } from "./classifier.mjs";

describe("dependency-closure classifier", () => {
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

  test("Go, Rust, extension, mobile, Raycast, media, and skills stay isolated", () => {
    const cases = [
      ["apps/ssh/main.go", "goSsh"],
      ["apps/dns/main.go", "goDns"],
      ["apps/sonar/src/main.rs", "sonar"],
      ["packages/skills/fluncle-maintenance/SKILL.md", "skills"],
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

  test("script and generated-skill surfaces select their dedicated checks", () => {
    expect(classifyPaths(["docs/agents/hermes/scripts/crawl-sweep.ts"]).lanes.scripts).toBe(true);
    expect(classifyPaths([".agents/skills/example/SKILL.md"]).lanes.skills).toBe(true);
    const installer = classifyPaths(["scripts/install-skills.ts"]);
    expect(installer.lanes.scripts).toBe(true);
    expect(installer.lanes.skills).toBe(true);
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
    }

    expect(
      classifyPaths(["apps/sonar/src/main.rs", "apps/new-unowned/surface.ts"]).unknownFiles,
    ).toEqual(["apps/new-unowned/surface.ts"]);
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

  test("Cloudflare bypasses watch paths for empty, 3000-file, and 20-commit pushes", () => {
    expect(classifyPaths([]).deploy).toBe(true);
    expect(
      classifyPaths(Array.from({ length: 3_000 }, (_, index) => `docs/${index}.md`)).deploy,
    ).toBe(true);
    expect(classifyPaths(["docs/only.md"], { commitCount: 20 }).deploy).toBe(true);
    expect(classifyPaths(["docs/only.md"], { commitCount: 19 }).deploy).toBe(false);
  });
});
