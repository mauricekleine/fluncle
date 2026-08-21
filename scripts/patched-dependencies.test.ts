import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// bun keys `patchedDependencies` by EXACT version ("pkg@1.2.3") while the catalog ranges
// float ("~1.2.3") — so a routine bump silently orphans the key and the patch stops applying,
// with no error anywhere. That failure mode is invisible until runtime (for the Remotion
// patch: a crash inside every bundle, discovered at render time). This test turns a detached
// patch into a red deploy gate: every patch key must still resolve in bun.lock, and every
// patch's marker must actually be present in the installed package.

const root = join(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  patchedDependencies?: Record<string, string>;
};
const lock = readFileSync(join(root, "bun.lock"), "utf8");

const entries = Object.entries(pkg.patchedDependencies ?? {});

describe("patchedDependencies", () => {
  it("has at least the Remotion TS7 patch (drop this test only with the last patch)", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  for (const [key, patchPath] of entries) {
    const at = key.lastIndexOf("@");
    const name = key.slice(0, at);
    const version = key.slice(at + 1);

    it(`${key} still resolves in bun.lock (a version bump must re-key the patch)`, () => {
      expect(lock).toContain(`"${name}@${version}"`);
    });

    it(`${key} is actually applied in node_modules`, () => {
      // Every fluncle patch marks its edit with this literal so application is verifiable.
      const marker = "PATCHED (fluncle)";
      const patch = readFileSync(join(root, patchPath), "utf8");
      expect(patch).toContain(marker);
      // The files the patch touches, from its `+++ b/<path>` headers.
      const touched = [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1] ?? "");
      expect(touched.length).toBeGreaterThan(0);
      const applied = touched.some((file) =>
        readFileSync(join(root, "node_modules", name, file), "utf8").includes(marker),
      );
      expect(applied, `${key}: no touched file carries the marker — patch detached`).toBe(true);
    });
  }

  it("keeps shadcn usable while rejecting the SDK's broken root export", () => {
    const sdkPackage = JSON.parse(
      readFileSync(
        join(root, "node_modules", "@modelcontextprotocol", "sdk", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(Object.keys(sdkPackage.exports ?? {})).toEqual([
      "./client",
      "./server",
      "./validation",
      "./validation/ajv",
      "./validation/cfworker",
      "./experimental",
      "./experimental/tasks",
      "./*",
    ]);

    const shadcn = spawnSync(
      "bun",
      [join(root, "node_modules", "shadcn", "dist", "index.js"), "--help"],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    expect(shadcn.status, shadcn.stderr).toBe(0);
    expect(shadcn.stdout).toContain("Usage: shadcn");

    const sdkSubpaths = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        [
          'await import("@modelcontextprotocol/sdk/server/index.js")',
          'await import("@modelcontextprotocol/sdk/server/stdio.js")',
          'await import("@modelcontextprotocol/sdk/types.js")',
        ].join(";"),
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(sdkSubpaths.status, sdkSubpaths.stderr).toBe(0);

    const sdkRoot = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        [
          'try { await import("@modelcontextprotocol/sdk") }',
          "catch (error) { console.error(error); process.exit(23) }",
          "process.exit(0)",
        ].join("\n"),
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(sdkRoot.status).toBe(23);
    expect(sdkRoot.stderr).toContain("Cannot find module '@modelcontextprotocol/sdk'");
  });
});
