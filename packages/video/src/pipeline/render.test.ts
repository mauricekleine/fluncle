// Coverage for the bundle cache key. The bundle bakes a COPY of public/ at
// bundle() time, so the key MUST fold in public/ — otherwise a re-render reuses a
// bundle whose baked audio is stale/missing (the ship-delete → 404 trap). These
// lock that: a change under EITHER input tree invalidates the key, a missing tree
// is a no-op, and an unchanged pair of trees is stable.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { hashBundleInputs } from "./render";

let root: string;
let srcDir: string;
let publicDir: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "fluncle-bundlekey-"));
  srcDir = path.join(root, "src");
  publicDir = path.join(root, "public");
  mkdirSync(srcDir, { recursive: true });
  mkdirSync(publicDir, { recursive: true });
  writeFileSync(path.join(srcDir, "comp.tsx"), "export const A = 1;");
  writeFileSync(path.join(publicDir, "track.m4a"), "AAAA");
});

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
});

describe("hashBundleInputs — the bundle cache key", () => {
  test("is stable for an unchanged pair of input trees", () => {
    expect(hashBundleInputs([srcDir, publicDir])).toBe(hashBundleInputs([srcDir, publicDir]));
  });

  test("a change under public/ (the audio asset) invalidates the key", () => {
    const before = hashBundleInputs([srcDir, publicDir]);
    // Restore/replace the audio with different content — a re-render must NOT reuse
    // the bundle whose baked public/ held the old bytes.
    writeFileSync(path.join(publicDir, "track.m4a"), "BBBBBBBB");
    const after = hashBundleInputs([srcDir, publicDir]);
    expect(after).not.toBe(before);
  });

  test("removing a public/ asset invalidates the key (the ship-delete case)", () => {
    const withAudio = hashBundleInputs([srcDir, publicDir]);
    rmSync(path.join(publicDir, "track.m4a"));
    const withoutAudio = hashBundleInputs([srcDir, publicDir]);
    expect(withoutAudio).not.toBe(withAudio);
    // Put it back so later assertions have a stable base.
    writeFileSync(path.join(publicDir, "track.m4a"), "BBBBBBBB");
  });

  test("a change under src/ still invalidates the key", () => {
    const before = hashBundleInputs([srcDir, publicDir]);
    writeFileSync(path.join(srcDir, "comp.tsx"), "export const A = 2; // edited");
    expect(hashBundleInputs([srcDir, publicDir])).not.toBe(before);
  });

  test("a missing input tree is a no-op (no throw), not counted", () => {
    const missing = path.join(root, "does-not-exist");
    expect(hashBundleInputs([srcDir, missing])).toBe(hashBundleInputs([srcDir]));
  });

  test("dotfiles and node_modules are ignored", () => {
    const base = hashBundleInputs([srcDir, publicDir]);
    writeFileSync(path.join(publicDir, ".DS_Store"), "junk");
    mkdirSync(path.join(publicDir, "node_modules"), { recursive: true });
    writeFileSync(path.join(publicDir, "node_modules", "x.js"), "junk");
    expect(hashBundleInputs([srcDir, publicDir])).toBe(base);
  });
});
