import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bangersCount, findingsCount, tracksCount } from "./format";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, "..");
const routes = join(srcRoot, "routes");

const FRONT_DOOR_MODULE = join(srcRoot, "lib", "front-door.ts");

const PUBLIC_RESPONSE_EMITTERS: readonly string[] = [
  join(srcRoot, "lib", "server", "orpc.ts"),
  join(srcRoot, "lib", "server", "agent-discovery.ts"),
  join(routes, "rss[.]xml.ts"),
  join(routes, "atom[.]xml.ts"),
  join(routes, "feed[.]json.ts"),
  join(routes, "podcast[.]xml.ts"),
  join(routes, "fresh[.]xml.ts"),
  join(routes, "fresh[.]json.ts"),
  join(routes, "artist.$slug.fresh[.]xml.ts"),
  join(routes, "label.$slug.fresh[.]xml.ts"),
  join(routes, "oembed.ts"),
  join(routes, "embed.$logId.ts"),
  join(routes, "sitemap[.]xml.ts"),
  join(routes, "sitemap.$shard.ts"),
];

const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

function resolveSpecifier(specifier: string, fromFile: string): string | undefined {
  let base: string;

  if (specifier.startsWith("@/")) {
    base = join(srcRoot, specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    base = resolve(dirname(fromFile), specifier);
  } else {
    return undefined;
  }

  for (const extension of ["", ...EXTENSIONS]) {
    const candidate = base + extension;

    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }

  for (const extension of EXTENSIONS) {
    const candidate = join(base, `index${extension}`);

    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }

  return undefined;
}

function importsOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const specifiers: string[] = [];

  for (const match of source.matchAll(/\bfrom\s+"([^"]+)"/g)) {
    if (match[1]) {
      specifiers.push(match[1]);
    }
  }

  for (const match of source.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g)) {
    if (match[1]) {
      specifiers.push(match[1]);
    }
  }

  for (const match of source.matchAll(/^\s*import\s+"([^"]+)"/gm)) {
    if (match[1]) {
      specifiers.push(match[1]);
    }
  }

  return specifiers;
}

function reachableFrom(entry: string): Map<string, string[]> {
  const trail = new Map<string, string[]>([[entry, [entry]]]);
  const queue: string[] = [entry];

  while (queue.length > 0) {
    const file = queue.shift();

    if (!file) {
      continue;
    }

    const path = trail.get(file) ?? [file];

    for (const specifier of importsOf(file)) {
      const next = resolveSpecifier(specifier, file);

      if (!next || trail.has(next) || /[.](?:test|spec)[.]tsx?$/.test(next)) {
        continue;
      }

      trail.set(next, [...path, next]);
      queue.push(next);
    }
  }

  return trail;
}

describe("the front door's count formatting is isolated from every published response", () => {
  it("points the scan at emitters that all exist (a typo'd path would pass vacuously)", () => {
    const missing = PUBLIC_RESPONSE_EMITTERS.filter((file) => !existsSync(file));

    expect(missing, `these emitters were not found: ${missing.join(", ")}`).toEqual([]);
  });

  it.each(PUBLIC_RESPONSE_EMITTERS.map((file) => [relative(srcRoot, file), file] as const))(
    "%s cannot reach lib/front-door.ts",
    (_name, entry) => {
      const trail = reachableFrom(entry);
      const path = trail.get(FRONT_DOOR_MODULE);

      expect(
        path === undefined,
        `${relative(srcRoot, entry)} reaches the front door's formatting via:\n  ${(path ?? [])
          .map((file) => relative(srcRoot, file))
          .join("\n  → ")}\nA published response body must not be reformatted by a page's needs.`,
      ).toBe(true);
    },
  );

  it("proves the scan can actually see the front door (the walk is not silently empty)", () => {
    const trail = reachableFrom(join(routes, "index.tsx"));

    expect(trail.get(FRONT_DOOR_MODULE)).toBeDefined();
    expect(trail.size).toBeGreaterThan(10);
  });
});

describe("the shared counts render ungrouped, which is the byte shape published responses carry", () => {
  it("counts findings with no thousands separator", () => {
    expect(findingsCount(1)).toBe("1 finding");
    expect(findingsCount(38)).toBe("38 findings");
    expect(findingsCount(1234)).toBe("1234 findings");
    expect(findingsCount(1_234_567)).toBe("1234567 findings");
  });

  it("counts tracks with no thousands separator", () => {
    expect(tracksCount(1)).toBe("1 track");
    expect(tracksCount(9876)).toBe("9876 tracks");
  });

  it("counts bangers with no thousands separator", () => {
    expect(bangersCount(1)).toBe("1 banger");
    expect(bangersCount(5432)).toBe("5432 bangers");
  });
});
