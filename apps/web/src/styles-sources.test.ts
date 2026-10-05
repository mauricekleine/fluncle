import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcRoot = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(srcRoot, "..");
const uiRoot = resolve(webRoot, "../../packages/ui/src");

function excludedSources(): RegExp[] {
  const css = readFileSync(join(srcRoot, "styles.css"), "utf8");

  return [...css.matchAll(/^@source not "([^"]+)";$/gm)].flatMap(([, path]) => {
    if (path === undefined) {
      return [];
    }

    const absolute = resolve(srcRoot, path);
    const pattern = absolute
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/]*");

    return [new RegExp(`^${pattern}(/|$)`)];
  });
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);

    if (statSync(path).isDirectory()) {
      return sourceFiles(path);
    }

    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

function resolveImport(from: string, specifier: string): string | undefined {
  if (specifier.startsWith("@/")) {
    return join(srcRoot, specifier.slice(2));
  }

  if (specifier.startsWith("@fluncle/ui/")) {
    return join(uiRoot, specifier.slice("@fluncle/ui/".length));
  }

  if (specifier.startsWith("#components/")) {
    return join(uiRoot, "components", specifier.slice("#components/".length));
  }

  if (specifier.startsWith(".")) {
    return resolve(dirname(from), specifier);
  }

  return undefined;
}

function importsOf(file: string): string[] {
  const code = readFileSync(file, "utf8");
  const specifiers = [
    ...code.matchAll(/\bfrom\s+"([^"]+)"/g),
    ...code.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g),
  ].flatMap(([, specifier]) => (specifier === undefined ? [] : [specifier]));

  return specifiers.flatMap((specifier) => resolveImport(file, specifier) ?? []);
}

describe("the public stylesheet's sources", () => {
  const excluded = excludedSources();
  const isExcluded = (path: string) => excluded.some((pattern) => pattern.test(path));

  it("skips the operator workspace and the docs hub", () => {
    expect(isExcluded(join(srcRoot, "routes/admin/index.tsx"))).toBe(true);
    expect(isExcluded(join(srcRoot, "components/admin/admin-shell.tsx"))).toBe(true);
    expect(isExcluded(join(srcRoot, "routes/docs.tsx"))).toBe(true);
    expect(isExcluded(join(uiRoot, "components/sidebar.tsx"))).toBe(true);
    expect(isExcluded(join(srcRoot, "routes/index.tsx"))).toBe(false);
    expect(isExcluded(join(uiRoot, "components/button.tsx"))).toBe(false);
  });

  it("never lets public code import a source it skips, which would render without its utilities", () => {
    const publicFiles = [...sourceFiles(srcRoot), ...sourceFiles(uiRoot)].filter(
      (file) => !isExcluded(file) && !file.startsWith(join(srcRoot, "test")),
    );
    const leaks = publicFiles.flatMap((file) =>
      importsOf(file)
        .filter((target) => isExcluded(target) || isExcluded(`${target}.tsx`))
        .map((target) => `${relative(webRoot, file)} -> ${relative(webRoot, target)}`),
    );

    expect(leaks).toStrictEqual([]);
  });
});
