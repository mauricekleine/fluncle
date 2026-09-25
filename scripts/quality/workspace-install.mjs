#!/usr/bin/env node

import { existsSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { repositoryRoot } from "./classifier.mjs";

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
