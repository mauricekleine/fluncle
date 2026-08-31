// THE FRONT DOOR RENDERS THE ARCHIVE, NEVER A MOCK OF IT.
//
// `/` is the surface most likely to drift back toward a comp: it is the page a design pass reaches
// for first, and a hard-coded row is the cheapest way to make one band look right. This is the
// build-fail net against that. It is a SOURCE SCAN — the same shape as `-root-unfurl.test.ts`,
// which pins the root's meta by reading the file — because the property is about what the modules
// are allowed to IMPORT, and no runtime assertion can see an import that was never made.
//
// Two rails, both stated as absolutes:
//
//   1. Every front-door module reads from the app's real modules only. A design-system exhibit, a
//      fixture catalog, a sample/mock/stub/demo/seed module, or anything reaching outside `src/`
//      is refused — a section that renders from one is a picture of the archive, not the archive.
//   2. No route registers a `/concepts` path. The exhibit that word names is a design-workflow
//      tool, not a product surface, and a route file is the one way it could ever reach production.
//
// Neither rail is satisfied by the tree happening to be clean today; both are here so it stays that
// way when the next pass adds a band.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..");
const frontDoorDir = join(srcRoot, "components", "front-door");

/** Every `.ts`/`.tsx` file under a directory, recursively. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);

    if (statSync(full).isDirectory()) {
      return sourceFiles(full);
    }

    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

/** Every module specifier a file imports (static `import … from "x"` and dynamic `import("x")`). */
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

  return specifiers;
}

// The modules the front door is built from: its own components plus the route that mounts them.
const FRONT_DOOR_MODULES = [
  ...sourceFiles(frontDoorDir),
  join(here, "index.tsx"),
  join(here, "-front-door-data.ts"),
];

/**
 * A specifier that would mean the page is rendering something other than the live archive. Matched
 * on the SEGMENT, so `@/lib/format` is fine while `@/lib/sample-findings` is not, and a package
 * whose name merely contains one of these words is not caught by accident.
 */
const FIXTURE_WORDS = [
  "concept",
  "concepts",
  "demo",
  "dummy",
  "example-data",
  "fake",
  "fixture",
  "fixtures",
  "mock",
  "mocks",
  "placeholder-data",
  "sample",
  "samples",
  "seed",
  "stub",
  "stubs",
];

function looksLikeFixture(specifier: string): boolean {
  return specifier.split(/[/.]/).some((segment) => FIXTURE_WORDS.includes(segment.toLowerCase()));
}

describe("the front door's sources", () => {
  it("scans a real set of modules (the scanner is pointed at something)", () => {
    expect(FRONT_DOOR_MODULES.length).toBeGreaterThanOrEqual(7);
  });

  it.each(FRONT_DOOR_MODULES.map((file) => [file.slice(srcRoot.length + 1), file] as const))(
    "%s imports no fixture, mock, sample, or concept module",
    (_name, file) => {
      const offenders = importsOf(file).filter((specifier) => looksLikeFixture(specifier));

      expect(
        offenders,
        `${file} imports ${offenders.join(", ")} — every band on the front door renders from a live production primitive`,
      ).toEqual([]);
    },
  );

  it.each(FRONT_DOOR_MODULES.map((file) => [file.slice(srcRoot.length + 1), file] as const))(
    "%s reaches only into the app's own source tree",
    (_name, file) => {
      // A relative specifier that climbs out of `src/` is the other way a held exhibit could be
      // wired in (the design-workflow tooling lives outside the app entirely).
      const escaping = importsOf(file).filter((specifier) => specifier.startsWith("../../.."));

      expect(escaping, `${file} reaches outside src/ via ${escaping.join(", ")}`).toEqual([]);
    },
  );
});

describe("the route tree", () => {
  it("registers no /concepts route", () => {
    // The exhibit that word names is a design-workflow tool. A file route is the one way it could
    // ever be served, so the scan is over every route file's own `createFileRoute` path.
    const routes = sourceFiles(here).filter((file) => !/[.]test[.]tsx?$/.test(file));
    const offenders = routes.filter((file) =>
      /createFileRoute\(\s*"\/concepts/.test(readFileSync(file, "utf8")),
    );

    expect(offenders, `these register a /concepts route: ${offenders.join(", ")}`).toEqual([]);
  });

  it("has a route tree that names no /concepts path", () => {
    // The generated tree is the authority on what the Worker actually serves — a route registered
    // from anywhere would appear here.
    const tree = readFileSync(join(srcRoot, "routeTree.gen.ts"), "utf8");

    expect(tree).not.toContain("/concepts");
  });
});
