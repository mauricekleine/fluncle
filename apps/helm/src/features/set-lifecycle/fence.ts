// The media-path fence. Every operator-supplied path that reaches a spawn (the
// upload's --video, distribute's --video/--audio) must REALPATH-resolve inside
// the scan roots — ~/Movies by default, extended by FLUNCLE_HELM_MEDIA_DIRS
// (colon-separated) — or it is refused before any argv is assembled. Realpath on
// BOTH sides kills traversal (`..` segments) and symlink escapes alike: a link
// inside a root that points outside resolves outside and is refused. The pure
// containment test is what the tests pin; only realpath touches the disk.

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

/** The scan roots: ~/Movies, plus FLUNCLE_HELM_MEDIA_DIRS (colon-separated). */
export function mediaRoots(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string[] {
  const roots = [join(home, "Movies")];

  for (const dir of (env.FLUNCLE_HELM_MEDIA_DIRS ?? "").split(":")) {
    const trimmed = dir.trim();

    if (trimmed.length > 0) {
      roots.push(resolve(trimmed));
    }
  }

  return roots;
}

/** Pure containment: is `resolvedPath` one of `resolvedRoots` or inside one? */
export function isInsideRoot(resolvedPath: string, resolvedRoots: readonly string[]): boolean {
  return resolvedRoots.some((root) => resolvedPath === root || resolvedPath.startsWith(root + sep));
}

export type FenceResult = { ok: true; path: string } | { ok: false };

/**
 * Fence one operator-supplied media path. Admits it only when it realpath-
 * resolves inside a scan root, and returns the RESOLVED path — the argv ships
 * what the fence verified, not what the request said. A path that is relative,
 * unreadable, or resolves outside every root is refused.
 */
export function fenceMediaPath(raw: string, roots: readonly string[] = mediaRoots()): FenceResult {
  if (!isAbsolute(raw)) {
    return { ok: false };
  }

  let real: string;

  try {
    real = realpathSync(raw);
  } catch {
    return { ok: false };
  }

  const realRoots: string[] = [];

  for (const root of roots) {
    try {
      realRoots.push(realpathSync(root));
    } catch {
      // A configured root that does not exist fences nothing in.
    }
  }

  return isInsideRoot(real, realRoots) ? { ok: true, path: real } : { ok: false };
}
