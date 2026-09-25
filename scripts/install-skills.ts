#!/usr/bin/env bun

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

const skillsCli = "skills@1.5.15";

export type LockEntry = { source?: string; sourceType?: string };
export type SkillsLock = { skills?: Record<string, LockEntry> };

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
  lockSkills: Record<string, LockEntry>;

  installedSkills: string[];

  packageSkills: string[];

  claudeLinks: Record<string, string | null>;
};

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
        `"${name}" is in skills-lock.json but has no copy at .agents/skills/${name} — no agent can read it. Install it (\`bunx skills add <source>\`) or drop the lock entry.`,
      );
    }
  }
  for (const name of [...installed].sort()) {
    if (!(name in lockSkills)) {
      problems.push(
        `.agents/skills/${name} has no skills-lock.json entry — its source is untraceable. Reinstall it through \`bunx skills add\` so the lock records where it came from.`,
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

function assertInstalledContentMatches(): void {
  const failures: string[] = [];
  for (const name of findPackageSkills()) {
    const result = spawnSync(
      "diff",
      ["--recursive", "--brief", join(skillsDir, name), join(agentsSkillsDir, name)],
      { encoding: "utf8" },
    );
    if (result.status !== 0) {
      failures.push(result.stdout.trim() || result.stderr.trim() || name);
    }
  }
  if (failures.length > 0) {
    console.error(`Installed skill content differs from canonical source:\n${failures.join("\n")}`);
    process.exit(1);
  }
  console.log("Installed skill content matches every canonical package source.");
}

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
  const verify = process.argv.includes("--verify");

  if (normalizeOnly) {
    normalizeLockSources();
    return;
  }

  if (checkOnly) {
    assertSkillPlumbingReconciles();
    return;
  }

  if (verify) {
    assertSkillPlumbingReconciles();
    assertInstalledContentMatches();
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

    console.log(`[${index + 1}/${skillDirs.length}] bunx ${args.join(" ")}`);
    if (dryRun) {
      continue;
    }

    const result = spawnSync("bunx", args, { cwd: repoRoot, stdio: "inherit" });
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

  assertSkillPlumbingReconciles();
}

if (import.meta.main) {
  main();
}
