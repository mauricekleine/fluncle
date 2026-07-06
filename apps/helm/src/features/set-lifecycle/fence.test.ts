import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fenceMediaPath, isInsideRoot, mediaRoots } from "./fence";

function makeRoot(): { outside: string; root: string } {
  const base = mkdtempSync(join(tmpdir(), "helm-fence-"));
  const root = join(base, "Movies");
  const outside = join(base, "outside");

  mkdirSync(root);
  mkdirSync(outside);

  return { outside, root };
}

describe("mediaRoots", () => {
  test("defaults to ~/Movies", () => {
    expect(mediaRoots({}, "/Users/op")).toEqual(["/Users/op/Movies"]);
  });

  test("FLUNCLE_HELM_MEDIA_DIRS extends, colon-separated, blanks dropped", () => {
    expect(
      mediaRoots({ FLUNCLE_HELM_MEDIA_DIRS: "/Volumes/sets: :/Volumes/masters" }, "/Users/op"),
    ).toEqual(["/Users/op/Movies", "/Volumes/sets", "/Volumes/masters"]);
  });
});

describe("isInsideRoot (pure containment)", () => {
  test("the root itself and its children are inside; siblings and prefixes are not", () => {
    expect(isInsideRoot("/a/Movies", ["/a/Movies"])).toBe(true);
    expect(isInsideRoot("/a/Movies/set.mov", ["/a/Movies"])).toBe(true);
    expect(isInsideRoot("/a/Movies-evil/set.mov", ["/a/Movies"])).toBe(false);
    expect(isInsideRoot("/a/outside/set.mov", ["/a/Movies"])).toBe(false);
    expect(isInsideRoot("/a", ["/a/Movies"])).toBe(false);
  });
});

describe("fenceMediaPath", () => {
  test("a legit scanned file is admitted, resolved", () => {
    const { root } = makeRoot();
    const file = join(root, "set.mov");

    writeFileSync(file, "footage");

    const fenced = fenceMediaPath(file, [root]);

    expect(fenced).toEqual({ ok: true, path: realpathSync(file) });
  });

  test("a traversal (`..`) out of the root is refused", () => {
    const { outside, root } = makeRoot();
    const escape = join(outside, "loot.mov");

    writeFileSync(escape, "loot");

    expect(fenceMediaPath(join(root, "..", "outside", "loot.mov"), [root])).toEqual({ ok: false });
  });

  test("a symlink inside the root pointing outside is refused", () => {
    const { outside, root } = makeRoot();
    const target = join(outside, "secret.mov");
    const link = join(root, "looks-legit.mov");

    writeFileSync(target, "secret");
    symlinkSync(target, link);

    expect(fenceMediaPath(link, [root])).toEqual({ ok: false });
  });

  test("relative and nonexistent paths are refused", () => {
    const { root } = makeRoot();

    expect(fenceMediaPath("Movies/set.mov", [root])).toEqual({ ok: false });
    expect(fenceMediaPath(join(root, "nope.mov"), [root])).toEqual({ ok: false });
  });

  test("a missing configured root fences nothing in", () => {
    const { root } = makeRoot();
    const file = join(root, "set.mov");

    writeFileSync(file, "footage");

    expect(fenceMediaPath(file, ["/nonexistent/root"])).toEqual({ ok: false });
  });
});
