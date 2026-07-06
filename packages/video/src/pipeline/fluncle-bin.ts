// Resolving the `fluncle` CLI for pipeline spawns. Doctrine (the render-queue
// prompt's hard rail): the pipeline talks to the INSTALLED standalone binary,
// never the from-source workspace CLI. But `bun run` prefixes PATH with
// node_modules/.bin, where the workspace shim shadows the installed binary —
// the exact failure the 027.9.5H re-render hit. So spawns resolve explicitly:
// FLUNCLE_BIN (operator override) → ~/.local/bin/fluncle (the installer's
// home) → bare `fluncle` on a PATH with every node_modules/.bin segment
// stripped, so the shim can never win.

import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/** The resolved `fluncle` binary for pipeline spawnSync calls. */
export function fluncleBin(): string {
  const override = process.env.FLUNCLE_BIN;
  if (override) {
    return override;
  }

  const home = process.env.HOME;
  if (home) {
    const installed = join(home, ".local", "bin", "fluncle");
    try {
      accessSync(installed, constants.X_OK);
      return installed;
    } catch {
      // fall through to PATH resolution
    }
  }

  return "fluncle";
}

/** A spawn env whose PATH cannot resolve the node_modules/.bin workspace shim. */
export function fluncleSpawnEnv(): NodeJS.ProcessEnv {
  const path = (process.env.PATH ?? "")
    .split(delimiter)
    .filter((segment) => !segment.includes(join("node_modules", ".bin")))
    .join(delimiter);

  return { ...process.env, PATH: path };
}
