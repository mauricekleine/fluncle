import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { parseDocument } from "yaml";

const WORKFLOW_DIRECTORY = join(import.meta.dir, "../../.github/workflows");

function workflowFiles() {
  return readdirSync(WORKFLOW_DIRECTORY)
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .sort();
}

function source(file: string) {
  return readFileSync(join(WORKFLOW_DIRECTORY, file), "utf8");
}

function workflow(file: string): unknown {
  const document = parseDocument(source(file), { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(document.errors.map((error) => error.message).join("\n"));
  }
  return document.toJS();
}

function at(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

describe("GitHub Actions syntax", () => {
  test("every workflow parses as YAML 1.2 with unique keys", () => {
    for (const file of workflowFiles()) {
      expect(() => workflow(file), file).not.toThrow();
    }
  });

  test("third-party actions are pinned to immutable commits", () => {
    for (const file of workflowFiles()) {
      for (const line of source(file).split("\n")) {
        const action = line.match(/^\s*uses:\s*([^#\s]+)/)?.[1];
        if (!action || action.startsWith("./")) {
          continue;
        }
        expect(action, `${file}: ${line.trim()}`).toMatch(/@[0-9a-f]{40}$/);
      }
    }
  });
});

describe("quality topology", () => {
  const quality = workflow("quality-checks.yml");
  const qualitySource = source("quality-checks.yml");

  test("draft pull requests skip runners until readiness without changing protected contexts", () => {
    const draftEvents = [
      "opened",
      "reopened",
      "synchronize",
      "ready_for_review",
      "converted_to_draft",
    ];
    const draftGuard =
      "github.event_name != 'pull_request' || github.event.pull_request.draft == false";

    for (const file of ["quality-checks.yml", "gitleaks.yml", "dependency-audit.yml"]) {
      expect(at(workflow(file), "on", "pull_request", "types")).toEqual(draftEvents);
    }

    expect(at(quality, "jobs", "core", "if")).toBe(draftGuard);
    expect(at(quality, "jobs", "e2e", "if")).toBe(draftGuard);
    expect(at(quality, "jobs", "gate", "if")).toBe(`always() && (${draftGuard})`);
    expect(at(workflow("gitleaks.yml"), "jobs", "scan", "if")).toBe(draftGuard);
    expect(at(workflow("dependency-audit.yml"), "jobs", "audit", "if")).toBe(draftGuard);
  });

  test("the protected context always reports and aggregates every selected lane", () => {
    expect(at(quality, "on", "pull_request", "paths")).toBeUndefined();
    expect(at(quality, "on", "pull_request", "paths-ignore")).toBeUndefined();
    expect(at(quality, "on", "push", "paths")).toBeUndefined();
    expect(at(quality, "on", "push", "paths-ignore")).toBeUndefined();
    expect(at(quality, "jobs", "gate", "name")).toBe("Lint, Format, and Typecheck");
    expect(at(quality, "jobs", "gate", "needs")).toEqual(["core", "e2e"]);
    expect(at(quality, "jobs", "gate", "if")).toBe(
      "always() && (github.event_name != 'pull_request' || github.event.pull_request.draft == false)",
    );
  });

  test("public E2E is classifier-selected but remains the complete suite", () => {
    expect(at(quality, "jobs", "e2e")).toBeDefined();
    expect(qualitySource).toContain("steps.classify.outputs.e2e == 'true'");
    expect(qualitySource).toContain("--lane e2e");
    expect(qualitySource).not.toContain("--only-changed");
    expect(workflowFiles()).not.toContain("e2e.yml");
    expect(qualitySource).toContain("name: discovery-events");
    expect(qualitySource).toContain("path: apps/web/.dev/discovery-events/");
  });

  test("cache writes are bounded to trusted main and Bun cache is absent", () => {
    expect(qualitySource).not.toContain("~/.bun/install/cache");
    expect(qualitySource).not.toContain("turbo-${{ runner.os }}-${{ github.sha }}");
    expect(qualitySource).toContain("actions/cache/restore@");
    expect(qualitySource).toContain("actions/cache/save@");
    expect(qualitySource).toContain("github.event_name == 'push'");
    expect(qualitySource).toContain("github.ref == 'refs/heads/main'");
    const coreSteps = at(quality, "jobs", "core", "steps") as Array<Record<string, unknown>>;
    const setupGo = coreSteps.find((step) => step.name === "Setup Go");
    expect(at(setupGo, "with", "cache")).toBe(false);
  });

  test("Python setup and evidence use the classifier-selected lane", () => {
    const coreSteps = at(quality, "jobs", "core", "steps") as Array<Record<string, unknown>>;
    const setup = coreSteps.find((step) => step.name === "Setup uv for label-triage Python tests");
    const run = coreSteps.find((step) => step.name === "Run label-triage Python tests");
    const guard = "steps.classify.outputs.label_triage_python == 'true'";
    expect(at(setup, "if")).toBe(guard);
    expect(at(setup, "with", "version")).toMatch(/^\d+\.\d+\.\d+$/);
    expect(at(setup, "with", "enable-cache")).toBe(false);
    expect(at(run, "if")).toBe(guard);
    expect(at(run, "run")).toContain("--lane label-triage-python");
    expect(coreSteps.indexOf(setup as Record<string, unknown>)).toBeLessThan(
      coreSteps.indexOf(run as Record<string, unknown>),
    );
  });

  test("generated quality artifacts stay outside the checkout", () => {
    expect(qualitySource).not.toMatch(/(?:--output|--plan) \.quality-plan\.json/);
    expect(qualitySource).not.toContain("--metrics .quality-metrics.jsonl");
    expect(qualitySource.match(/--output "\$RUNNER_TEMP\/quality-plan\.json"/g)).toHaveLength(2);
    expect(qualitySource).toContain('--metrics "$RUNNER_TEMP/quality-metrics.jsonl"');
    expect(qualitySource).toContain('--plan "$RUNNER_TEMP/quality-plan.json"');
  });

  test("native contracts retain explicit owners", () => {
    expect(qualitySource).toContain("--lane go-ssh");
    expect(qualitySource).toContain("--lane go-dns");
    expect(qualitySource).toContain("--lane sonar");
  });
});

describe("security, release, and deploy topology", () => {
  test("full-history secret scanning and both dependency-audit invocations remain", () => {
    const leaks = workflow("gitleaks.yml");
    expect(at(leaks, "jobs", "scan", "name")).toBe("Scan git history for committed secrets");
    expect(source("gitleaks.yml")).toContain("fetch-depth: 0");

    const auditSource = source("dependency-audit.yml");
    expect(auditSource).toContain("bun audit --json");
    expect(auditSource).toContain("bun run audit");
  });

  test("dependency audit always reports its context and runs fully outside PRs", () => {
    const audit = workflow("dependency-audit.yml");
    expect(at(audit, "on", "pull_request", "paths")).toBeUndefined();
    expect(at(audit, "on", "pull_request", "paths-ignore")).toBeUndefined();
    expect(at(audit, "on", "push", "branches")).toEqual(["main"]);
    expect(at(audit, "on", "workflow_dispatch")).toBeDefined();
    expect(at(audit, "on", "schedule")).toBeDefined();
    expect(at(audit, "jobs", "audit", "name")).toBe("Audit bun.lock dependencies");
    const steps = at(audit, "jobs", "audit", "steps") as Array<Record<string, unknown>>;
    for (const name of ["Setup Bun", "Report audit findings", "Audit dependencies"]) {
      expect(steps.find((step) => step.name === name)?.if).toBe(
        "github.event_name != 'pull_request' || steps.dependencies.outputs.changed == 'true'",
      );
    }
    expect(steps.find((step) => step.name === "Report unchanged dependencies")?.if).toBe(
      "github.event_name == 'pull_request' && steps.dependencies.outputs.changed == 'false'",
    );
  });

  test("dependency selection executes against the PR merge-base diff", () => {
    const steps = at(workflow("dependency-audit.yml"), "jobs", "audit", "steps") as Array<
      Record<string, unknown>
    >;
    const script = steps.find((step) => step.id === "dependencies")?.run;
    if (typeof script !== "string") {
      throw new Error("dependency detection step is missing");
    }
    const root = mkdtempSync(join(tmpdir(), "dependency-diff-"));
    const env = {
      ...process.env,
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "Fixture",
    };
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: root, encoding: "utf8", env });
      if (result.status !== 0) {
        throw new Error(result.stderr);
      }
      return result.stdout.trim();
    };
    try {
      git("init", "--quiet");
      writeFileSync(join(root, "README.md"), "base");
      git("add", ".");
      const base = git("commit-tree", git("write-tree"), "-m", "base");
      for (const [path, expected] of [
        ["README.md", false],
        ["bun.lock", true],
        ["package.json", true],
        ["apps/web/package.json", true],
        ["packages/a space/package.json", true],
        ["apps/web/package.json.backup", false],
      ] as const) {
        git("read-tree", "--reset", "-u", base);
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), "changed");
        git("add", path);
        const head = git("commit-tree", git("write-tree"), "-p", base, "-m", "change");
        const output = join(root, "output");
        writeFileSync(output, "");
        const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], {
          cwd: root,
          encoding: "utf8",
          env: { ...env, BASE_SHA: base, GITHUB_OUTPUT: output, HEAD_SHA: head, RUNNER_TEMP: root },
        });
        expect(result.status, result.stderr).toBe(0);
        expect(readFileSync(output, "utf8"), path).toBe(`changed=${expected}\n`);
      }
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("releases consume exact-SHA Quality completion without calling Quality again", () => {
    const releases = workflow("cli-release.yml");
    const releasesSource = source("cli-release.yml");
    expect(at(releases, "on", "workflow_run", "workflows")).toEqual(["Quality Checks"]);
    expect(releasesSource).toContain("github.event.workflow_run.head_sha");
    expect(releasesSource).not.toContain("uses: ./.github/workflows/quality-checks.yml");
    expect(releasesSource).toContain("bun-darwin-arm64");
    expect(releasesSource).toContain("x86_64-unknown-linux-musl");
    expect(releasesSource).toContain("statically linked|static-pie linked");
    expect(releasesSource).toContain("ldd dist/sonar > dist/sonar.ldd 2>&1 || true");
    expect(releasesSource).not.toContain("if ldd dist/sonar");
    expect(releasesSource).toContain(
      'gh api --method PATCH "repos/${GITHUB_REPOSITORY}/git/refs/tags/${RELEASE_TAG}"',
    );
    expect(releasesSource).toContain('gh api --method POST "repos/${GITHUB_REPOSITORY}/git/refs"');
    expect(releasesSource).toContain("-F force=true");
    expect(releasesSource).not.toContain('git push -f origin "refs/tags/$RELEASE_TAG"');
  });

  test("post-deploy supports main pushes and manual probes with bounded polling", () => {
    const deploy = workflow("post-deploy-probe.yml");
    const deploySource = source("post-deploy-probe.yml");
    expect(Object.keys(at(deploy, "on") as Record<string, unknown>).sort()).toEqual([
      "push",
      "workflow_dispatch",
    ]);
    expect(at(deploy, "on", "push", "paths-ignore")).toBeUndefined();
    expect(deploySource).toContain("resolve-deploy.mjs");
    expect(deploySource).toContain("deadline=1200");
    expect(deploySource).toContain("deadline=180");
    expect(deploySource.indexOf("Resolve event and deploy watch-path decision")).toBeLessThan(
      deploySource.indexOf("Checkout correlated deploy code"),
    );
  });

  test("post-deploy keeps every pushed SHA while deduplicating one manual build", () => {
    const deploy = workflow("post-deploy-probe.yml");
    const concurrencyGroup = at(deploy, "concurrency", "group");

    expect(at(deploy, "concurrency", "cancel-in-progress")).toBe(true);
    expect(concurrencyGroup).toBe(
      "post-deploy-${{ github.event_name == 'push' && github.sha || inputs.build_uuid || github.run_id }}",
    );
    expect(concurrencyGroup).not.toContain("github.event_name == 'push' && 'fallback'");
  });
});
