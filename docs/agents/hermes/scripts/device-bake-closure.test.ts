// THE DEVICE DERIVER'S BAKE LIST IS A HAND-WRITTEN IMPORT CLOSURE — this test keeps it honest.
//
// The Dockerfile bakes `apps/web/scripts/derive-device-db.ts` and its imports under
// /opt/hermes-device/<repo path> by naming every file in a COPY list. Nothing else connects that
// list to the deriver's actual imports: a module gaining `import … from "../../src/lib/server/x"`
// still typechecks, still passes every test, and bakes into an image whose hourly device-mirror
// run dies on `Cannot find module` — the run ledger shows it, /status shows it, but only after the
// rebake. So this walks the deriver's RELATIVE import closure from the repository and asserts each
// resolved file has a COPY into the baked tree at the same repository-relative path.
//
//   bun test docs/agents/hermes/scripts/device-bake-closure.test.ts

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const DOCKERFILE = join(REPO_ROOT, "docs", "agents", "hermes", "Dockerfile");
const BAKED_ROOT = "/opt/hermes-device/";
/** The deriver entry the image runs (`DEVICE_DERIVE_SCRIPT`) and the flat shim's target. */
const ENTRIES = [
  "apps/web/scripts/derive-device-db.ts",
  "apps/web/scripts/lib/device-db-derivation.ts",
] as const;

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^;]*?\sfrom\s+["']([^"']+)["']/g;

/** Resolve a relative specifier to a repository-relative `.ts` path, or null for a package. */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) {
    return null;
  }
  const base = resolve(REPO_ROOT, dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(candidate) && candidate.endsWith(".ts")) {
      return relative(REPO_ROOT, candidate);
    }
  }
  throw new Error(`${fromFile}: cannot resolve "${specifier}" to a .ts file`);
}

/** Every repository-relative file the entries import, transitively, relative imports only. */
function importClosure(entries: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.shift();
    if (file === undefined || seen.has(file)) {
      continue;
    }
    seen.add(file);
    const source = readFileSync(join(REPO_ROOT, file), "utf8");
    for (const match of source.matchAll(IMPORT_RE)) {
      const target = resolveSpecifier(file, match[1] ?? "");
      if (target !== null) {
        queue.push(target);
      }
    }
  }
  return seen;
}

/** Each `COPY <src>… <dest>` into the baked tree, as the repository paths it lands at. */
function bakedPaths(dockerfile: string): Set<string> {
  const baked = new Set<string>();
  // Join backslash continuations so a multi-source COPY reads as one line.
  const flat = dockerfile.replace(/\\\n\s*/g, " ");
  for (const line of flat.split("\n")) {
    const words = line.trim().split(/\s+/);
    if (words[0] !== "COPY" || words.length < 3) {
      continue;
    }
    const dest = words[words.length - 1] ?? "";
    if (!dest.startsWith(BAKED_ROOT)) {
      continue;
    }
    const sources = words.slice(1, -1).filter((word) => !word.startsWith("--"));
    for (const source of sources) {
      // A directory destination (trailing slash) keeps the file's basename; a file destination
      // names the baked path outright. Either way the baked path must equal the repo path.
      const landed = dest.endsWith("/") ? `${dest}${source.split("/").pop() ?? ""}` : dest;
      baked.add(landed.slice(BAKED_ROOT.length));
    }
  }
  return baked;
}

describe("the baked device deriver", () => {
  const dockerfile = readFileSync(DOCKERFILE, "utf8");
  const baked = bakedPaths(dockerfile);
  const closure = importClosure(ENTRIES);

  test("every file in its import closure is baked at its repository-relative path", () => {
    const missing = [...closure].filter((file) => !baked.has(file));
    expect(missing).toEqual([]);
  });

  test("the closure walk actually sees the sideways import into apps/web/src", () => {
    // The tripwire's own tripwire: the derivation reaches into src/lib, so a walk that found only
    // the scripts/ files would be a walk that had stopped following relative imports.
    expect([...closure].some((file) => file.startsWith("apps/web/src/lib/"))).toBe(true);
  });

  test("the flat /opt/hermes-scripts copy is a shim onto the baked tree, not a second deriver", () => {
    expect(dockerfile).toContain(
      `export * from "/opt/hermes-device/apps/web/scripts/lib/device-db-derivation";`,
    );
    const flatCopies = dockerfile
      .replace(/\\\n\s*/g, " ")
      .split("\n")
      .filter((line) =>
        /^COPY\s.*apps\/web\/scripts\/lib\/device-db-derivation\.ts\s.*\/opt\/hermes-scripts\/?$/.test(
          line.trim(),
        ),
      );
    expect(flatCopies).toEqual([]);
  });
});
