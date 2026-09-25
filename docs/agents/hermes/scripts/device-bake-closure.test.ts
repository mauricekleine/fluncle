import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const DOCKERFILE = join(REPO_ROOT, "docs", "agents", "hermes", "Dockerfile");
const BAKED_ROOT = "/opt/hermes-device/";

const ENTRIES = [
  "apps/web/scripts/derive-device-db.ts",
  "apps/web/scripts/lib/device-db-derivation.ts",
] as const;

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^;]*?\sfrom\s+["']([^"']+)["']/g;

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

function bakedPaths(dockerfile: string): Set<string> {
  const baked = new Set<string>();

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
