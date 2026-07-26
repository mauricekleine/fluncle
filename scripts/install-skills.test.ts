// Unit tests for install-skills.ts — the skills install plumbing.
//
// Two things are worth pinning here, both because they fail SILENTLY otherwise:
//   1. the lock-source normalizer (a machine-absolute /Users/… path in the committed
//      lockfile is a topology leak AGENTS.md forbids, and nothing else catches it), and
//   2. the reconciliation between skills-lock.json, .agents/skills, packages/skills, and
//      the .claude/skills symlinks — the desync the skills-sync drift guard stays green
//      through, where an edited skill is simply never read.
//
// Runs outside any package's test runner (bun:test), like the hermes script tests:
//   bun test --cwd scripts

import { describe, expect, test } from "bun:test";
import { findSkillPlumbingProblems, rewriteLockSources, type SkillsLock } from "./install-skills";

describe("rewriteLockSources", () => {
  test("rewrites a machine-absolute local source to repo-relative", () => {
    const lock: SkillsLock = {
      skills: {
        "fluncle-video": {
          source: "/Users/someone/Projects/fluncle/packages/skills/fluncle-video",
          sourceType: "local",
        },
      },
    };

    expect(rewriteLockSources(lock, "/Users/someone/Projects/fluncle")).toBe(true);
    expect(lock.skills?.["fluncle-video"]?.source).toBe("packages/skills/fluncle-video");
  });

  test("normalizes identically from a worktree checkout path", () => {
    const root = "/Users/someone/Projects/fluncle/.claude/worktrees/wf_abc";
    const lock: SkillsLock = {
      skills: { taste: { source: `${root}/packages/skills/taste`, sourceType: "local" } },
    };

    expect(rewriteLockSources(lock, root)).toBe(true);
    expect(lock.skills?.taste?.source).toBe("packages/skills/taste");
  });

  test("is idempotent and leaves github sources alone", () => {
    const lock: SkillsLock = {
      skills: {
        shadcn: { source: "shadcn/ui", sourceType: "github" },
        taste: { source: "packages/skills/taste", sourceType: "local" },
      },
    };

    expect(rewriteLockSources(lock, "/Users/someone/Projects/fluncle")).toBe(false);
    expect(lock.skills?.taste?.source).toBe("packages/skills/taste");
    expect(lock.skills?.shadcn?.source).toBe("shadcn/ui");
  });

  test("tolerates a trailing slash on the repo root and an empty lock", () => {
    const lock: SkillsLock = {
      skills: { taste: { source: "/repo/packages/skills/taste", sourceType: "local" } },
    };

    expect(rewriteLockSources(lock, "/repo/")).toBe(true);
    expect(lock.skills?.taste?.source).toBe("packages/skills/taste");
    expect(rewriteLockSources({}, "/repo")).toBe(false);
  });
});

describe("findSkillPlumbingProblems", () => {
  const clean = {
    claudeLinks: {
      shadcn: "../../.agents/skills/shadcn",
      taste: "../../.agents/skills/taste",
    },
    installedSkills: ["shadcn", "taste"],
    lockSkills: {
      shadcn: { source: "shadcn/ui", sourceType: "github" },
      taste: { source: "packages/skills/taste", sourceType: "local" },
    },
    packageSkills: ["taste"],
  };

  test("passes when lock, installed copies, sources and symlinks agree", () => {
    expect(findSkillPlumbingProblems(clean)).toEqual([]);
  });

  test("flags a locked skill with no installed copy (the agent never reads it)", () => {
    const problems = findSkillPlumbingProblems({
      ...clean,
      installedSkills: ["shadcn"],
      packageSkills: ["taste"],
    });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(".agents/skills/taste");
  });

  test("flags an installed copy with no lock entry (untraceable source)", () => {
    const problems = findSkillPlumbingProblems({
      ...clean,
      claudeLinks: { ...clean.claudeLinks, vendored: "../../.agents/skills/vendored" },
      installedSkills: [...clean.installedSkills, "vendored"],
    });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("no skills-lock.json entry");
  });

  test("flags a local lock entry whose packages/skills source is gone", () => {
    const problems = findSkillPlumbingProblems({ ...clean, packageSkills: [] });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("packages/skills/taste");
  });

  test("flags a local lock entry left on a machine-absolute source", () => {
    const problems = findSkillPlumbingProblems({
      ...clean,
      lockSkills: {
        ...clean.lockSkills,
        taste: {
          source: "/Users/someone/Projects/fluncle/packages/skills/taste",
          sourceType: "local",
        },
      },
    });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("--normalize-only");
  });

  test("flags a real .claude/skills directory and a wrong symlink target", () => {
    const problems = findSkillPlumbingProblems({
      ...clean,
      claudeLinks: { shadcn: "../../.agents/skills/elsewhere", taste: null },
    });

    expect(problems).toHaveLength(2);
    expect(problems.join("\n")).toContain("is a real directory");
    expect(problems.join("\n")).toContain("elsewhere");
  });
});
