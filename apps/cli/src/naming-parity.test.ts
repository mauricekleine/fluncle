import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Command } from "commander";

import { createProgram } from "./cli";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const conventionsPath = join(repoRoot, "docs", "naming-conventions.md");

function readCliSection(): string {
  const doc = readFileSync(conventionsPath, "utf8");
  const start = doc.indexOf("### 1.1 CLI");
  const end = doc.indexOf("### 1.2", start);

  if (start === -1 || end === -1) {
    throw new Error("docs/naming-conventions.md: §1.1 CLI section not found");
  }

  return doc.slice(start, end);
}

function commandPaths(command: Command, prefix: string): string[] {
  return command.commands.flatMap((sub) => {
    if (sub.name() === "help") {
      return [];
    }

    const path = `${prefix} ${sub.name()}`.trim();
    if (sub.commands.length > 0) {
      return commandPaths(sub, path);
    }

    return [path, ...sub.aliases().map((alias) => `${prefix} ${alias}`.trim())];
  });
}

function namesIn(cell: string): Set<string> {
  const named = new Set<string>();

  for (const match of cell.matchAll(/`([^`]+)`/g)) {
    const words: string[] = [];
    for (const token of (match[1] ?? "").replace(/^fluncle\s+/, "").split(/\s+/)) {
      if (!/^[a-z][a-z0-9-]*$/.test(token)) {
        break;
      }
      words.push(token);
      named.add(words.join(" "));
    }
  }

  return named;
}

function documentedGroups(section: string): Map<string, Set<string>> {
  const groups = new Map<string, Set<string>>();

  for (const line of section.split("\n")) {
    if (!line.startsWith("|") || /^\|[\s-]*-{3}/.test(line)) {
      continue;
    }

    const cells = line.split("|").map((cell) => cell.trim());
    const [, groupCell = "", commandCell = ""] = cells;
    if (groupCell === "Group") {
      continue;
    }

    const group = groupCell.match(/`([^`]+)`/)?.[1]?.replace(/^fluncle\s+/, "") ?? "";
    const named = groups.get(group) ?? new Set<string>();

    for (const name of namesIn(commandCell)) {
      named.add(name);
    }
    groups.set(group, named);
  }

  return groups;
}

function isDocumented(groups: Map<string, Set<string>>, path: string): boolean {
  if (groups.has(path)) {
    return true;
  }

  const words = path.split(" ");
  const leaf = words.at(-1) ?? path;

  for (let cut = words.length - 1; cut >= 0; cut--) {
    const named = groups.get(words.slice(0, cut).join(" "));
    if (named?.has(path) || named?.has(words.slice(cut).join(" ")) || named?.has(leaf)) {
      return true;
    }
  }

  return false;
}

describe("docs/naming-conventions.md §1.1 and the real CLI tree agree", () => {
  test("every command has a row", () => {
    const named = documentedGroups(readCliSection());
    const missing = commandPaths(createProgram(), "").filter((path) => !isDocumented(named, path));

    expect(missing).toEqual([]);
  });

  test("every row names a command that still exists", () => {
    const real = new Set(commandPaths(createProgram(), ""));
    const stale: string[] = [];

    for (const [group, named] of documentedGroups(readCliSection())) {
      for (const name of named) {
        const path = name.startsWith(group) ? name : `${group} ${name}`.trim();
        if (
          !real.has(path) &&
          !real.has(name) &&
          ![...real].some((c) => c.startsWith(`${path} `))
        ) {
          stale.push(`${group || "(root)"} → ${name}`);
        }
      }
    }

    expect(stale).toEqual([]);
  });
});
