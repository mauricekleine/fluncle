// The CLI ↔ naming-conventions parity gate.
//
// docs/naming-conventions.md §1.1 is a HAND-maintained snapshot of the `fluncle` tree, and
// §6 sends every new public operation there to find its precedent — so a command with no row
// is the one case the checklist exists for, and the one that rots first. The API half of the
// same document is already gated (`orpc-coverage`, `orpc-auth-coverage`, `orpc-naming`); this
// is the CLI half's net.
//
// The check is name-presence in BOTH directions, mirroring the shape of
// packages/registry/src/doctrine-parity.test.ts. Every runnable command must be named by one of
// ITS OWN group's rows, and every name a row spells must still be a real command. Scoping to the
// group is what makes the first half real — an unscoped search would let some other group's row
// spelling the same verb answer for a leaf that has no row — and the second half is what catches
// a RENAME, which is the convention's whole subject. It stays presence-only on purpose: it
// catches the failures that actually happen without freezing the doc's prose or column wording.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Command } from "commander";

import { createProgram } from "./cli";

// This file lives at apps/cli/src/, so the repo root is three directories up.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const conventionsPath = join(repoRoot, "docs", "naming-conventions.md");

/** The §1.1 CLI table, sliced off the heading that owns it. */
function readCliSection(): string {
  const doc = readFileSync(conventionsPath, "utf8");
  const start = doc.indexOf("### 1.1 CLI");
  const end = doc.indexOf("### 1.2", start);

  if (start === -1 || end === -1) {
    throw new Error("docs/naming-conventions.md: §1.1 CLI section not found");
  }

  return doc.slice(start, end);
}

/**
 * Every runnable command path in the tree, excluding Commander's own `help`. Only leaves are
 * collected: a group node carries no operation of its own, and a group that lost its rows
 * surfaces as every one of its leaves going missing at once.
 */
function commandPaths(command: Command, prefix: string): string[] {
  return command.commands.flatMap((sub) => {
    if (sub.name() === "help") {
      return [];
    }

    const path = `${prefix} ${sub.name()}`.trim();
    if (sub.commands.length > 0) {
      return commandPaths(sub, path);
    }

    // An alias is a real invocation (`recent` is documented as "alias `list`"), so it counts
    // as a name the doc may legitimately spell.
    return [path, ...sub.aliases().map((alias) => `${prefix} ${alias}`.trim())];
  });
}

/**
 * The names a table cell holds. A cell is written as the command plus its usage tail
 * (`tracks similar [idOrLogId]`, `enrich --queue`), so only the leading run of plain words in
 * each backtick span counts, and each prefix of that run is treated as named too.
 */
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

/**
 * Group → the leaf names its own rows list. A group lives in a row's first cell and its
 * subcommands in the second, so the map is what makes coverage scoped: `repair` under
 * `admin receipts` is not answered by some other group's row that happens to say `repair`.
 * Root commands (`(root)`, the hidden `tracks` group) collect under the empty group.
 */
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

/**
 * A leaf (`admin receipts repair`) is covered when one of its group's rows names it — bare
 * (`repair`), suffixed, or written out in full. The hidden `tracks` group writes the full path
 * in its command cell, every `admin` group writes the bare subcommand, and a leaf that is its
 * own group cell (`admin queue`) is named by that cell with a `(bare)` command.
 */
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
        // A cell names either the leaf alone or the whole path; only the longest
        // spelling is a claim, since a prefix of a real path is a group, not a command.
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
