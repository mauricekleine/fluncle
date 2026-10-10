import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readPackageGraph, repositoryRoot } from "./classifier.mjs";

const EXCLUSIONS = [
  {
    prefix: "tools/oxlint/anti-slop/",
    reason: "Pinned upstream plugin source, maintained byte-for-byte with its vendor revision.",
  },
  {
    prefix: ".agents/skills/remotion-best-practices/rules/assets/",
    reason: "Vendored documentation examples, never built, imported, or executed by Fluncle.",
  },
  {
    path: ".deepsec/deepsec.config.ts",
    reason:
      "Scanner configuration for the standalone pnpm project; its dependencies stay outside the root install.",
  },
  {
    path: "apps/raycast/raycast-env.d.ts",
    reason: "Raycast-generated declarations consumed by its source program when referenced.",
  },
  {
    path: "apps/web/src/routeTree.gen.ts",
    reason:
      "TanStack-generated route registry carries the generator's @ts-nocheck directive; imported route types remain available.",
  },
];

function coverageReport(tracked, programs) {
  const covered = new Set(Object.values(programs).flat());
  const excluded = tracked.flatMap((path) => {
    const exclusion = EXCLUSIONS.find((candidate) =>
      candidate.path ? candidate.path === path : path.startsWith(candidate.prefix),
    );
    return exclusion ? [{ path, reason: exclusion.reason }] : [];
  });
  const excludedPaths = new Set(excluded.map(({ path }) => path));
  return {
    covered: tracked.filter((path) => covered.has(path) && !excludedPaths.has(path)),
    excluded,
    programs,
    tracked,
    uncovered: tracked.filter((path) => !covered.has(path) && !excludedPaths.has(path)),
  };
}

function output(program, args, root) {
  const result = spawnSync(program, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(result.error?.message ?? (result.stderr + result.stdout).trim());
  }
  return result.stdout;
}

function measureCoverage(root = repositoryRoot()) {
  const tracked = output("git", ["ls-files", "-z"], root)
    .split("\0")
    .filter((path) => /\.(?:[cm]?ts|tsx)$/.test(path))
    .sort();
  const programs = {};
  for (const workspace of readPackageGraph(root).values()) {
    const manifest = JSON.parse(
      readFileSync(resolve(root, workspace.path, "package.json"), "utf8"),
    );
    const script = manifest.scripts?.typecheck ?? "";
    for (const command of script.split("&&")) {
      const args = Array.from(command.matchAll(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g), (match) =>
        match[0].replace(/"([^"]*)"|'([^']*)'/g, "$1$2"),
      ).flatMap((argument) => {
        const option = argument.match(/^(--cwd|--tsconfig-override)=(.*)$/);
        return option ? [option[1], option[2]] : [argument];
      });
      if (args[0] !== "bun" || !args.includes("--check")) {
        continue;
      }
      const cwdIndex = args.indexOf("--cwd");
      const configIndex = args.indexOf("--tsconfig-override");
      const cwd = cwdIndex < 0 ? "." : args[cwdIndex + 1];
      const project = configIndex < 0 ? "tsconfig.json" : args[configIndex + 1];
      if (!cwd || !project) {
        throw new Error(`Missing project path in typecheck command: ${command.trim()}`);
      }
      const config = resolve(root, workspace.path, cwd, project);
      const configPath = relative(root, config).replaceAll("\\", "/");
      if (programs[configPath]) {
        continue;
      }
      programs[configPath] = output(
        resolve(root, "node_modules/.bin/tsc"),
        ["--noEmit", "--listFilesOnly", "--project", config],
        root,
      )
        .split(/\r?\n/)
        .filter((file) => file.startsWith(`${root}/`) && !file.includes("/node_modules/"))
        .map((file) => relative(root, file).replaceAll("\\", "/"));
    }
  }
  return coverageReport(tracked, programs);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const report = measureCoverage();
    const reportPath = process.argv[2];
    if (reportPath) {
      writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    }
    process.stdout.write(
      `TypeScript coverage: ${report.covered.length}/${report.tracked.length} covered, ${report.excluded.length} explicit exclusions, ${report.uncovered.length} uncovered.\n`,
    );
    if (report.uncovered.length > 0) {
      throw new Error(
        `TypeScript files outside the gated programs:\n${report.uncovered.join("\n")}`,
      );
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
