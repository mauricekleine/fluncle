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
 *   bun run skills:install            # install all local skills
 *   bun run skills:install --dry-run  # print the commands without running them
 */
import { readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = join(import.meta.dir, "..");
const skillsDir = join(repoRoot, "packages", "skills");
const agents = ["claude-code", "codex"];
const dryRun = process.argv.includes("--dry-run");

const skillDirs = readdirSync(skillsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(skillsDir, entry.name, "SKILL.md")))
  .map((entry) => entry.name)
  .sort();

if (skillDirs.length === 0) {
  console.error(
    `No skills found under ${relative(repoRoot, skillsDir)} (expected directories containing a SKILL.md).`,
  );
  process.exit(1);
}

console.log(`Installing ${skillDirs.length} local skill(s) for: ${agents.join(", ")}\n`);

const failures: string[] = [];

for (const [index, name] of skillDirs.entries()) {
  const skillPath = `./${relative(repoRoot, join(skillsDir, name))}`;
  const args = ["skills", "add", skillPath, "-y", ...agents.flatMap((agent) => ["-a", agent])];

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
  process.exit(0);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} skill(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}

console.log(`\nDone — installed ${skillDirs.length} skill(s).`);
