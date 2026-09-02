import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

  test("the protected context always reports and aggregates every selected lane", () => {
    expect(at(quality, "on", "pull_request", "paths")).toBeUndefined();
    expect(at(quality, "on", "pull_request", "paths-ignore")).toBeUndefined();
    expect(at(quality, "on", "push", "paths")).toBeUndefined();
    expect(at(quality, "on", "push", "paths-ignore")).toBeUndefined();
    expect(at(quality, "jobs", "gate", "name")).toBe("Lint, Format, and Typecheck");
    expect(at(quality, "jobs", "gate", "needs")).toEqual(["core", "e2e"]);
    expect(at(quality, "jobs", "gate", "if")).toBe("always()");
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

  test("generated quality artifacts stay outside the checkout", () => {
    expect(qualitySource).not.toMatch(/(?:--output|--plan) \.quality-plan\.json/);
    expect(qualitySource).not.toContain("--metrics .quality-metrics.jsonl");
    expect(qualitySource.match(/--output "\$RUNNER_TEMP\/quality-plan\.json"/g)).toHaveLength(2);
    expect(qualitySource).toContain('--metrics "$RUNNER_TEMP/quality-metrics.jsonl"');
    expect(qualitySource).toContain('--plan "$RUNNER_TEMP/quality-plan.json"');
  });

  test("skills drift and native contracts retain explicit owners", () => {
    expect(qualitySource).toContain("--lane skills");
    expect(qualitySource).toContain("--lane go-ssh");
    expect(qualitySource).toContain("--lane go-dns");
    expect(qualitySource).toContain("--lane sonar");
    expect(workflowFiles()).not.toContain("skills-sync.yml");
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

  test("releases consume exact-SHA Quality completion without calling Quality again", () => {
    const releases = workflow("cli-release.yml");
    const releasesSource = source("cli-release.yml");
    expect(at(releases, "on", "workflow_run", "workflows")).toEqual(["Quality Checks"]);
    expect(releasesSource).toContain("github.event.workflow_run.head_sha");
    expect(releasesSource).not.toContain("uses: ./.github/workflows/quality-checks.yml");
    expect(releasesSource).toContain("bun-darwin-arm64");
    expect(releasesSource).toContain("x86_64-unknown-linux-musl");
    expect(releasesSource).toContain("statically linked|static-pie linked");
  });

  test("post-deploy has event initiation plus a dynamic bounded fallback", () => {
    const deploy = workflow("post-deploy-probe.yml");
    const deploySource = source("post-deploy-probe.yml");
    expect(at(deploy, "on", "repository_dispatch", "types")).toEqual(["cloudflare-workers-build"]);
    expect(at(deploy, "on", "push", "paths-ignore")).toBeUndefined();
    expect(deploySource).toContain("resolve-deploy.mjs");
    expect(deploySource).toContain("deadline=1200");
    expect(deploySource).toContain("deadline=180");
    expect(deploySource.indexOf("Resolve event and deploy watch-path decision")).toBeLessThan(
      deploySource.indexOf("Checkout correlated deploy code"),
    );
  });

  test("post-deploy keeps every pushed SHA while deduplicating one dispatched build", () => {
    const deploy = workflow("post-deploy-probe.yml");
    const concurrencyGroup = at(deploy, "concurrency", "group");

    expect(at(deploy, "concurrency", "cancel-in-progress")).toBe(true);
    expect(concurrencyGroup).toBe(
      "post-deploy-${{ github.event_name == 'push' && github.sha || github.event.client_payload.build_uuid || inputs.build_uuid || github.run_id }}",
    );
    expect(concurrencyGroup).not.toContain("github.event_name == 'push' && 'fallback'");
  });
});
