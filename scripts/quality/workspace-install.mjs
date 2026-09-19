#!/usr/bin/env node
/**
 * THE FRESH-WORKTREE TRAP, AND WHY IT IS SILENT.
 *
 * A worktree lives UNDER the main checkout (`.claude/worktrees/<id>`), and Node resolves a bare
 * specifier by walking `node_modules` upwards. So a worktree that has not run its own install does
 * not fail to resolve `@fluncle/*` — it resolves them from the MAIN checkout, two directories up.
 * Typecheck then passes against another branch's contracts, lint reads another branch's plugins,
 * and every one of those greens is about code this worktree does not contain. Nothing warns,
 * because from the resolver's point of view nothing is wrong.
 *
 * The check is therefore not "does `node_modules` exist" but the thing that actually matters:
 * does a workspace package resolve INSIDE this checkout. That one question catches the missing
 * install, a half-linked `node_modules`, and a stray parent install alike.
 */
import { existsSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { repositoryRoot } from "./classifier.mjs";

/** A workspace package every lane depends on, so its link is a fair proxy for the whole install. */
const PROBE = "@fluncle/registry";

export function workspaceInstallProblem(root = repositoryRoot(), probe = PROBE) {
  let resolved;
  try {
    resolved = fileURLToPath(import.meta.resolve(probe));
  } catch {
    return `\`${probe}\` does not resolve at all from ${root}.`;
  }

  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
    return `\`${probe}\` resolves to ${resolved}, which is OUTSIDE ${root} — this checkout is reading another one's install.`;
  }

  if (!existsSync(`${root}${sep}node_modules${sep}.bin`)) {
    return `${relative(process.cwd(), root) || "."}/node_modules has no \`.bin\`, so this checkout has no install of its own.`;
  }

  return null;
}

// Only when RUN, never when imported — `preflight.mjs` imports the predicate above and must not
// inherit an exit from doing so.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const problem = workspaceInstallProblem();

  if (problem) {
    process.stderr.write(
      `\nThis checkout has no install of its own.\n\n  ${problem}\n\n` +
        "A git worktree sits inside the main checkout, so an uninstalled one silently resolves\n" +
        "`@fluncle/*` from the main checkout's node_modules — and then typechecks, lints and tests\n" +
        "green against code that is not in this branch. Run the install before trusting any of it:\n\n" +
        "  bun install --frozen-lockfile\n\n",
    );
    process.exit(1);
  }
}
