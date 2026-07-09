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
import { readdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = join(import.meta.dir, "..");
const skillsDir = join(repoRoot, "packages", "skills");
const lockPath = join(repoRoot, "skills-lock.json");
const agents = ["claude-code", "codex"];
// Pin the `skills` CLI version. The lockfile stores a per-skill `computedHash` the CLI
// produces, so an unpinned `npx skills` lets CI resolve a newer version than a dev ran
// locally — a changed hash then makes the skills-sync drift guard (.github/workflows/
// skills-sync.yml) fail non-deterministically. Pinning makes `skills:install`
// byte-identical everywhere (local, CI, every agent). Bump deliberately.
const skillsCli = "skills@1.5.15";
const dryRun = process.argv.includes("--dry-run");
const normalizeOnly = process.argv.includes("--normalize-only");

/**
 * Rewrite every LOCAL skill's `source` in skills-lock.json from a machine-absolute
 * path (…/Projects/fluncle/packages/skills/foo) to a repo-relative one
 * (packages/skills/foo). We hand `skills add` a relative path, but the CLI
 * absolutizes it into the lock — so without this the committed lockfile bakes in
 * one machine's home path, which AGENTS.md forbids ("NEVER commit … local
 * /Users/… paths"). Idempotent; runs after every install below, and standalone
 * via `bun run skills:install --normalize-only` to heal the committed file.
 */
function normalizeLockSources(): void {
  if (!existsSync(lockPath)) {
    return;
  }
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as {
    skills?: Record<string, { source?: string; sourceType?: string }>;
  };
  const prefix = `${repoRoot}/`;
  let changed = false;
  for (const entry of Object.values(lock.skills ?? {})) {
    if (entry.sourceType === "local" && entry.source?.startsWith(prefix)) {
      entry.source = entry.source.slice(prefix.length);
      changed = true;
    }
  }
  if (changed) {
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    console.log("Normalized local skills-lock sources to repo-relative paths.");
  }
}

if (normalizeOnly) {
  normalizeLockSources();
  process.exit(0);
}

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
  process.exit(0);
}

normalizeLockSources();

if (failures.length > 0) {
  console.error(`\n${failures.length} skill(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}

console.log(`\nDone — installed ${skillDirs.length} skill(s).`);
