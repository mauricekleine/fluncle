import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const QUALITY_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(QUALITY_DIRECTORY, "../..");
const WATCH_PATHS = JSON.parse(
  readFileSync(join(QUALITY_DIRECTORY, "deploy-watch-paths.json"), "utf8"),
);

const FULL_FILES = new Set([
  ".gitignore",
  ".claude/settings.json",
  ".codex/hooks.json",
  ".husky/pre-commit",
  ".mcp.json",
  ".oxfmtrc.json",
  ".oxlintrc.json",
  ".prettierignore",
  "bun.lock",
  "bunfig.toml",
  "opencode.json",
  "package.json",
  "renovate.json",
  "tsconfig.json",
  "turbo.json",
]);

const DOCUMENT_FILES = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "DESIGN.md",
  "LICENSE",
  "LORE.md",
  "NOTICE",
  "PRODUCT.md",
  "README.md",
  "VOICE.md",
]);

const FULL_DIRECTORIES = [".deepsec/", ".superset/", "patches/", "tools/"];
const WORKFLOW_DIRECTORIES = [".github/"];
const SCRIPT_DIRECTORIES = ["scripts/", ".husky/", ".claude/hooks/", ".codex/hooks/"];
const QUALITY_HARNESS_DIRECTORIES = ["scripts/quality/"];
const SKILL_DIRECTORIES = ["packages/skills/", ".agents/skills/", ".claude/skills/"];

function normalizePath(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isWithin(path, directory) {
  const normalizedDirectory = directory.replace(/\/$/, "");
  return path === normalizedDirectory || path.startsWith(`${normalizedDirectory}/`);
}

function readPackageGraph(root) {
  const packages = new Map();

  for (const workspaceRoot of ["apps", "packages"]) {
    const absoluteWorkspaceRoot = join(root, workspaceRoot);
    if (!existsSync(absoluteWorkspaceRoot)) {
      continue;
    }

    for (const entry of readdirSync(absoluteWorkspaceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      const packagePath = `${workspaceRoot}/${entry.name}`;
      const manifestPath = join(root, packagePath, "package.json");
      if (!existsSync(manifestPath)) {
        continue;
      }

      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (typeof manifest.name !== "string") {
        continue;
      }

      const dependencyNames = new Set();
      for (const field of [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
      ]) {
        for (const dependencyName of Object.keys(manifest[field] ?? {})) {
          dependencyNames.add(dependencyName);
        }
      }

      packages.set(manifest.name, {
        dependencies: dependencyNames,
        name: manifest.name,
        path: packagePath,
      });
    }
  }

  return packages;
}

function impactedPackages(changedPackageNames, packages) {
  const impacted = new Set(changedPackageNames);
  let grew = true;

  while (grew) {
    grew = false;
    for (const candidate of packages.values()) {
      if (impacted.has(candidate.name)) {
        continue;
      }

      if ([...candidate.dependencies].some((dependency) => impacted.has(dependency))) {
        impacted.add(candidate.name);
        grew = true;
      }
    }
  }

  return impacted;
}

export function cloudflareExcludePatterns() {
  return [
    ...WATCH_PATHS.excludedDirectories.map((directory) => `${directory}/*`),
    ...WATCH_PATHS.excludedFiles,
  ];
}

export function triggersWorkerBuild(path) {
  const normalized = normalizePath(path);
  if (WATCH_PATHS.excludedFiles.includes(normalized)) {
    return false;
  }

  return !WATCH_PATHS.excludedDirectories.some((directory) => isWithin(normalized, directory));
}

function allTypeScriptPackages(packages) {
  return [...packages.keys()].filter((name) => name !== "@fluncle/dns" && name !== "@fluncle/ssh");
}

function packageForPath(path, packages) {
  return [...packages.values()].find((candidate) => isWithin(path, candidate.path));
}

function isGlobalConfiguration(path) {
  return FULL_FILES.has(path) || FULL_DIRECTORIES.some((directory) => path.startsWith(directory));
}

function isDocument(path) {
  return DOCUMENT_FILES.has(path) || path.startsWith("docs/") || path.startsWith(".impeccable/");
}

export function classifyPaths(paths, options = {}) {
  const root = resolve(options.root ?? DEFAULT_ROOT);
  const packages = readPackageGraph(root);
  const changedFiles = [...new Set(paths.map(normalizePath).filter(Boolean))].sort(compareText);
  const changedPackageNames = new Set();
  const reasons = new Set();
  const unknownFiles = [];
  const lanes = {
    docs: false,
    e2e: false,
    goDns: false,
    goSsh: false,
    migrations: false,
    scripts: false,
    skills: false,
    sonar: false,
    static: changedFiles.length > 0,
    workflows: false,
  };
  const release = { cli: false, sonar: false };
  let full = options.forceFull === true;

  if (full) {
    reasons.add(options.fullReason ?? "explicit full backstop");
  }

  for (const path of changedFiles) {
    let matched = false;

    if (isGlobalConfiguration(path)) {
      full = true;
      reasons.add(`global configuration: ${path}`);
      matched = true;
    }

    if (QUALITY_HARNESS_DIRECTORIES.some((directory) => path.startsWith(directory))) {
      full = true;
      reasons.add(`quality harness: ${path}`);
      matched = true;
    }

    if (WORKFLOW_DIRECTORIES.some((directory) => path.startsWith(directory))) {
      full = true;
      lanes.workflows = true;
      reasons.add(`workflow topology: ${path}`);
      matched = true;
    }

    if (isDocument(path)) {
      lanes.docs = true;
      matched = true;
    }

    if (
      SCRIPT_DIRECTORIES.some((directory) => path.startsWith(directory)) ||
      path.startsWith("docs/agents/hermes/scripts/")
    ) {
      lanes.scripts = true;
      matched = true;
    }

    if (
      SKILL_DIRECTORIES.some((directory) => path.startsWith(directory)) ||
      path === "skills-lock.json"
    ) {
      lanes.skills = true;
      matched = true;
    }

    if (path === ".gitleaks.toml") {
      matched = true;
    }

    if (isWithin(path, "apps/ssh")) {
      lanes.goSsh = true;
      matched = true;
    }

    if (isWithin(path, "apps/dns")) {
      lanes.goDns = true;
      matched = true;
    }

    if (isWithin(path, "apps/sonar")) {
      lanes.sonar = true;
      release.sonar = true;
      matched = true;
    }

    if (isWithin(path, "apps/cli")) {
      release.cli =
        release.cli ||
        path === "apps/cli/package.json" ||
        (path.startsWith("apps/cli/src/") && !path.endsWith(".test.ts"));
    }

    if (path.startsWith("apps/web/drizzle/")) {
      lanes.migrations = true;
    }

    const packageMatch = packageForPath(path, packages);
    if (packageMatch) {
      if (packageMatch.name !== "@fluncle/dns" && packageMatch.name !== "@fluncle/ssh") {
        changedPackageNames.add(packageMatch.name);
      }
      matched = true;
    }

    if (path.startsWith("apps/") || path.startsWith("packages/")) {
      matched = matched || packageMatch !== undefined;
    }

    if (path.startsWith(".agents/") || path.startsWith(".claude/") || path.startsWith(".codex/")) {
      matched = true;
    }

    if (!matched) {
      unknownFiles.push(path);
      full = true;
      reasons.add(`unknown path: ${path}`);
    }
  }

  let selectedPackages = impactedPackages(changedPackageNames, packages);
  if (full) {
    selectedPackages = new Set(allTypeScriptPackages(packages));
    Object.assign(lanes, {
      e2e: true,
      goDns: true,
      goSsh: true,
      migrations: true,
      scripts: true,
      skills: true,
      sonar: true,
      static: true,
      workflows: true,
    });
  }

  if (selectedPackages.has("@fluncle/web")) {
    lanes.e2e = true;
  }

  if (changedFiles.length === 0 && !full) {
    full = true;
    reasons.add("empty change set fails closed");
    selectedPackages = new Set(allTypeScriptPackages(packages));
    Object.assign(lanes, {
      e2e: true,
      goDns: true,
      goSsh: true,
      migrations: true,
      scripts: true,
      skills: true,
      sonar: true,
      static: true,
      workflows: true,
    });
  }

  const deploy = changedFiles.some(triggersWorkerBuild);
  const plan = {
    base: options.base ?? null,
    changedFiles,
    deploy,
    full,
    head: options.head ?? null,
    lanes,
    packages: [...selectedPackages].sort(compareText),
    reasons: [...reasons].sort(compareText),
    release,
    unknownFiles: unknownFiles.sort(compareText),
    version: 1,
  };

  return plan;
}

export function repositoryRoot() {
  return DEFAULT_ROOT;
}

export function relativeToRepository(path, root = DEFAULT_ROOT) {
  return relative(root, path).split(sep).join("/");
}
