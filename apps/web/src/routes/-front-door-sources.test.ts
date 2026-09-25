import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..");
const frontDoorDir = join(srcRoot, "components", "front-door");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);

    if (statSync(full).isDirectory()) {
      return sourceFiles(full);
    }

    return /\.tsx?$/.test(entry) ? [full] : [];
  });
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

  return specifiers;
}

const FRONT_DOOR_MODULES = [
  ...sourceFiles(frontDoorDir),
  join(here, "index.tsx"),
  join(here, "-front-door-data.ts"),
];

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
      const escaping = importsOf(file).filter((specifier) => specifier.startsWith("../../.."));

      expect(escaping, `${file} reaches outside src/ via ${escaping.join(", ")}`).toEqual([]);
    },
  );
});

describe("the route tree", () => {
  it("registers no /concepts route", () => {
    const routes = sourceFiles(here).filter((file) => !/[.]test[.]tsx?$/.test(file));
    const offenders = routes.filter((file) =>
      /createFileRoute\(\s*"\/concepts/.test(readFileSync(file, "utf8")),
    );

    expect(offenders, `these register a /concepts route: ${offenders.join(", ")}`).toEqual([]);
  });

  it("has a route tree that names no /concepts path", () => {
    const tree = readFileSync(join(srcRoot, "routeTree.gen.ts"), "utf8");

    expect(tree).not.toContain("/concepts");
  });
});
