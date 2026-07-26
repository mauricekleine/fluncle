#!/usr/bin/env bun
/**
 * Install every local Fluncle skill under packages/skills into the agent
 * toolchains, per AGENTS.md → "Agent Skills":
 *
 *   npx skills add ./packages/skills/<skill-path> -y -a claude-code -a codex
 *
 * A directory counts as a skill when it contains a SKILL.md. Installs run
 * sequentially because `skills add` mutates the shared skills-lock.json, and
 * parallel writes would race on it.
 *
 * Usage:
 *   bun run skills:install               # install all local skills, then reconcile
 *   bun run skills:install --dry-run     # print the commands without running them
 *   bun run skills:install --check-only  # reconcile only (no install; seconds, not minutes)
 */
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = join(import.meta.dir, "..");
const skillsDir = join(repoRoot, "packages", "skills");
const lockPath = join(repoRoot, "skills-lock.json");
const agentsSkillsDir = join(repoRoot, ".agents", "skills");
const claudeSkillsDir = join(repoRoot, ".claude", "skills");
const agents = ["claude-code", "codex"];
// Pin the `skills` CLI version. The lockfile stores a per-skill `computedHash` the CLI
// produces, so an unpinned `npx skills` lets CI resolve a newer version than a dev ran
// locally — a changed hash then makes the skills-sync drift guard (.github/workflows/
// skills-sync.yml) fail non-deterministically. Pinning makes `skills:install`
// byte-identical everywhere (local, CI, every agent). Bump deliberately.
const skillsCli = "skills@1.5.15";

export type LockEntry = { source?: string; sourceType?: string };
export type SkillsLock = { skills?: Record<string, LockEntry> };

/**
 * Rewrite every LOCAL skill's `source` from a machine-absolute path
 * (…/Projects/fluncle/packages/skills/foo) to a repo-relative one
 * (packages/skills/foo). We hand `skills add` a relative path, but the CLI
 * absolutizes it into the lock — so without this the committed lockfile bakes in
 * one machine's home path, which AGENTS.md forbids ("NEVER commit … local
 * /Users/… paths").
 *
 * Pure and idempotent: it mutates the passed lock object and reports whether
 * anything moved, so the rewrite is unit-testable without touching disk.
 */
export function rewriteLockSources(lock: SkillsLock, root: string): boolean {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  let changed = false;
  for (const entry of Object.values(lock.skills ?? {})) {
    if (entry.sourceType === "local" && entry.source?.startsWith(prefix)) {
      entry.source = entry.source.slice(prefix.length);
      changed = true;
    }
  }
  return changed;
}

/**
 * Disk wrapper around `rewriteLockSources`. Runs after every install below, and
 * standalone via `bun run skills:install --normalize-only` to heal the committed file.
 */
function normalizeLockSources(): void {
  if (!existsSync(lockPath)) {
    return;
  }
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as SkillsLock;
  if (rewriteLockSources(lock, repoRoot)) {
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    console.log("Normalized local skills-lock sources to repo-relative paths.");
  }
}

export type ReconcileInput = {
  /** Every key under `skills` in skills-lock.json, with its entry. */
  lockSkills: Record<string, LockEntry>;
  /** Directory names under .agents/skills (the copies an agent actually reads). */
  installedSkills: string[];
  /** Directory names under packages/skills that hold a SKILL.md (first-party sources). */
  packageSkills: string[];
  /** .claude/skills entries: name → the symlink target, or null when it is a real directory. */
  claudeLinks: Record<string, string | null>;
};

/**
 * The reconciliation the skills-sync drift guard could not see. Its guard only asks
 * "did regenerating packages/skills move the working tree?", which stays green while
 * the three views of a skill disagree: a lock entry with no installed copy (the agent
 * silently never reads the skill), an installed copy with no lock entry (a vendored
 * copy nobody can trace to a source), a local lock entry pointing at a deleted
 * packages/skills directory, or a real directory under .claude/skills instead of the
 * symlink every other skill gets (two copies that drift apart — edit one, the other
 * agent reads the stale one).
 *
 * Pure: returns one human-readable problem per line so both the local run and the CI
 * job fail with the same actionable list.
 */
export function findSkillPlumbingProblems({
  claudeLinks,
  installedSkills,
  lockSkills,
  packageSkills,
}: ReconcileInput): string[] {
  const problems: string[] = [];
  const lockNames = Object.keys(lockSkills).sort();
  const installed = new Set(installedSkills);
  const packaged = new Set(packageSkills);

  for (const name of lockNames) {
    if (!installed.has(name)) {
      problems.push(
        `"${name}" is in skills-lock.json but has no copy at .agents/skills/${name} — no agent can read it. Install it (\`npx skills add <source>\`) or drop the lock entry.`,
      );
    }
  }
  for (const name of [...installed].sort()) {
    if (!(name in lockSkills)) {
      problems.push(
        `.agents/skills/${name} has no skills-lock.json entry — its source is untraceable. Reinstall it through \`npx skills add\` so the lock records where it came from.`,
      );
    }
  }
  for (const name of lockNames) {
    const entry = lockSkills[name];
    if (entry?.sourceType !== "local") {
      continue;
    }
    const expected = `packages/skills/${name}`;
    if (entry.source !== expected) {
      problems.push(
        `"${name}" is a local skill whose lock source is "${entry.source ?? "(missing)"}" — expected "${expected}" (run \`bun run skills:install --normalize-only\`).`,
      );
    } else if (!packaged.has(name)) {
      problems.push(
        `"${name}" is locked to ${expected}, but no such directory with a SKILL.md exists — the source was moved or deleted.`,
      );
    }
  }
  for (const [name, target] of Object.entries(claudeLinks).sort(([a], [b]) => a.localeCompare(b))) {
    const expected = `../../.agents/skills/${name}`;
    if (target === null) {
      problems.push(
        `.claude/skills/${name} is a real directory, not a symlink to ${expected} — Claude and Codex then read two copies that drift. Delete it and reinstall the skill.`,
      );
    } else if (target !== expected) {
      problems.push(`.claude/skills/${name} points at "${target}" — expected "${expected}".`);
    }
  }

  return problems;
}

/** Read the four views off disk and fail loudly when they disagree. */
function assertSkillPlumbingReconciles(): void {
  const lock = existsSync(lockPath)
    ? (JSON.parse(readFileSync(lockPath, "utf8")) as SkillsLock)
    : {};
  const dirNames = (dir: string): string[] =>
    existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
          .map((entry) => entry.name)
      : [];

  const claudeLinks: Record<string, string | null> = {};
  for (const name of dirNames(claudeSkillsDir)) {
    const path = join(claudeSkillsDir, name);
    claudeLinks[name] = lstatSync(path).isSymbolicLink() ? readlinkSync(path) : null;
  }

  const problems = findSkillPlumbingProblems({
    claudeLinks,
    installedSkills: dirNames(agentsSkillsDir),
    lockSkills: lock.skills ?? {},
    packageSkills: findPackageSkills(),
  });

  if (problems.length === 0) {
    console.log(
      "Skill plumbing reconciles: skills-lock.json ↔ .agents/skills ↔ .claude/skills symlinks.",
    );
    return;
  }

  console.error(`\nSkill plumbing is out of sync (${problems.length} problem(s)):`);
  for (const problem of problems) {
    console.error(`  ✗ ${problem}`);
  }
  console.error(
    "\nA skill that is locked but not installed is a skill no agent reads — an edit to it goes nowhere.",
  );
  process.exit(1);
}

/**
 * Strip run artifacts (Python bytecode, macOS Finder files) from the skill
 * sources before installing. The skills CLI hashes the whole directory into the
 * lock's `computedHash`, so a stray gitignored `__pycache__/` left behind by
 * running a skill script bakes in a hash that CI's clean checkout can never
 * reproduce — and the skills-sync drift guard fails on every push after.
 */
function sweepJunk(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__pycache__") {
        rmSync(p, { force: true, recursive: true });
        console.log(`Swept ${relative(repoRoot, p)} (run artifact; breaks the lock hash).`);
        continue;
      }
      sweepJunk(p);
    } else if (entry.name === ".DS_Store" || entry.name.endsWith(".pyc")) {
      rmSync(p, { force: true });
      console.log(`Swept ${relative(repoRoot, p)} (run artifact; breaks the lock hash).`);
    }
  }
}

function findPackageSkills(): string[] {
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(skillsDir, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
}

function main(): void {
  const dryRun = process.argv.includes("--dry-run");
  const normalizeOnly = process.argv.includes("--normalize-only");
  const checkOnly = process.argv.includes("--check-only");

  if (normalizeOnly) {
    normalizeLockSources();
    return;
  }

  if (checkOnly) {
    assertSkillPlumbingReconciles();
    return;
  }

  const skillDirs = findPackageSkills();

  if (skillDirs.length === 0) {
    console.error(
      `No skills found under ${relative(repoRoot, skillsDir)} (expected directories containing a SKILL.md).`,
    );
    process.exit(1);
  }

  if (!dryRun) {
    sweepJunk(skillsDir);
  }

  console.log(`Installing ${skillDirs.length} local skill(s) for: ${agents.join(", ")}\n`);

  const failures: string[] = [];

  for (const [index, name] of skillDirs.entries()) {
    const skillPath = `./${relative(repoRoot, join(skillsDir, name))}`;
    const args = [skillsCli, "add", skillPath, "-y", ...agents.flatMap((agent) => ["-a", agent])];

    console.log(`[${index + 1}/${skillDirs.length}] npx ${args.join(" ")}`);
    if (dryRun) {
      continue;
    }

    const result = spawnSync("npx", args, { cwd: repoRoot, stdio: "inherit" });
    if (result.status !== 0) {
      failures.push(name);
      console.error(`  ✗ failed to install "${name}" (exit ${result.status ?? "signal"})`);
    }
  }

  if (dryRun) {
    console.log("\nDry run complete — no changes made.");
    return;
  }

  normalizeLockSources();

  if (failures.length > 0) {
    console.error(`\n${failures.length} skill(s) failed: ${failures.join(", ")}`);
    process.exit(1);
  }

  console.log(`\nDone — installed ${skillDirs.length} skill(s).`);

  // Last, so both this run and the CI job inherit the check: every skill the lock
  // claims must actually be installed, and vice versa.
  assertSkillPlumbingReconciles();
}

if (import.meta.main) {
  main();
}
