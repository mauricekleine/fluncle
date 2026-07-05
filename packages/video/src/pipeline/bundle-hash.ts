// The bundle input fingerprint — a pure fs hash of the two trees Remotion's
// webpack bundle (and therefore every render off it) is a function of:
//
//   1. src/     — the composition code (pipeline + remotion, including the
//                 gitignored workbench/ compositions root.tsx auto-registers).
//   2. public/  — bundle() COPIES public/ into the bundle output, and renderMedia
//                 serves staticFile() from that baked copy (the preview audio,
//                 public/<trackId>.m4a, lives here), so the bundle depends on it.
//
// Extracted from render.ts so BOTH the render bundle cache (render.ts) AND ship's
// square-artifact cache (ship.ts) key off the SAME mechanism — without ship pulling
// in the heavy @remotion/* import graph render.ts carries at module load.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const SRC_DIR = path.resolve(import.meta.dirname, "..");
const PUBLIC_DIR = path.resolve(import.meta.dirname, "../../public");

/**
 * A stable hash of every file under the given input trees (relative path + mtime
 * + size) — what Remotion's webpack bundle is a pure function of. Any edit to
 * src/ (including a workbench/ composition drop-in) OR to public/ (a
 * changed/restored/evicted staticFile asset — the preview audio) changes the
 * hash, so a stale bundle is never reused; correctness comes first, caching is
 * opportunistic. Each tree's path is folded in so a same-named file under a
 * different root can't collide. A missing tree contributes nothing (no throw).
 * Exported for the cache-key regression test.
 */
export function hashBundleInputs(dirs: string[]): string {
  const hash = createHash("sha256");

  for (const dir of dirs) {
    if (!existsSync(dir)) {
      continue;
    }
    const files: string[] = [];
    const walk = (current: string): void => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) {
          continue;
        }
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          files.push(full);
        }
      }
    };
    walk(dir);
    files.sort();

    hash.update(`\0root:${dir}\0`);
    for (const file of files) {
      const stat = statSync(file);
      hash.update(path.relative(dir, file));
      hash.update(String(stat.mtimeMs));
      hash.update(String(stat.size));
    }
  }

  return hash.digest("hex").slice(0, 16);
}

/**
 * The current bundle input fingerprint — hashBundleInputs over src/ + public/, the
 * exact pair the webpack bundle (and every render off it) is a pure function of.
 * The render bundle cache and ship's square-artifact cache both call this so they
 * invalidate on the same edits.
 */
export function bundleInputsHash(): string {
  return hashBundleInputs([SRC_DIR, PUBLIC_DIR]);
}
