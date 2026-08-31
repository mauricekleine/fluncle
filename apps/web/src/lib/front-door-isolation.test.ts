// THE FRONT DOOR'S FORMATTING NEVER REACHES A PUBLISHED RESPONSE BODY.
//
// `/` is a page, and a page may print a number however it reads best. A FEED, an oEmbed payload, an
// embed document, a sitemap and an `/api/v1` response are different: their bytes are a contract with
// callers Fluncle cannot see, so a formatting change there is a breaking change nobody asked for.
//
// That boundary is easy to cross by accident, because the tempting move is to put the nicer
// formatter in `lib/format.ts` where everything already imports from. `findingsCount` alone travels
// a long way from there — `lib/graph-prose.ts` carries it into `graphSignatureLine`, which
// `lib/server/graph-preview.ts` feeds to the `get_graph_preview` op, which `packages/contracts`
// publishes as `GET /api/v1/graph/{kind}/{slug}`; and `lib/server/agent-discovery.ts` carries it into
// the generated markdown homepage and `llms-full.txt`. None of those is a page.
//
// So the front door keeps its own grouping in `lib/front-door.ts`, and this file is the net that
// keeps it there. Two rails, both stated as absolutes:
//
//   1. No public response emitter can reach `lib/front-door.ts` — proved on the transitive import
//      graph, not by reading the imports at the top of each file.
//   2. `lib/format.ts`'s shared counts render UNGROUPED, which is the exact byte shape those
//      emitters published before the front door existed.
//
// Neither rail is satisfied by the tree happening to be clean today; both are here so it stays that
// way when the next surface wants a prettier number.

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bangersCount, findingsCount, tracksCount } from "./format";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, "..");
const routes = join(srcRoot, "routes");

/** The module the front door's grouping lives in — the thing that must stay unreachable. */
const FRONT_DOOR_MODULE = join(srcRoot, "lib", "front-door.ts");

/**
 * Every surface whose response BYTES are a published contract, as its entry module.
 *
 * `lib/server/orpc.ts` is the whole `/api/v1` surface in one entry: it mounts the router, so its
 * transitive graph is every public and admin op's handler. The rest are file-route emitters — the
 * feeds, the two embed surfaces, and both halves of the sitemap — plus `agent-discovery.ts`, which
 * generates the markdown homepage and `llms-full.txt` for agents.
 */
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

/** Resolve one import specifier to a file under `src/`, or null when it leaves the app. */
function resolveSpecifier(specifier: string, fromFile: string): string | undefined {
  let base: string;

  if (specifier.startsWith("@/")) {
    base = join(srcRoot, specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    base = resolve(dirname(fromFile), specifier);
  } else {
    // A bare package specifier: outside the app's own tree, so outside this scan.
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

/** Every module specifier a file imports — static, side-effect, and dynamic alike. */
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

/**
 * Walk an entry module's transitive import graph, recording the path that first reached each file.
 * A DYNAMIC import counts: `await import("./x")` inside a handler still puts `x` in the response's
 * code path, which is the thing under test.
 */
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
    // The control: the route that DOES render the front door must reach the module every emitter
    // above must not. Without this, a broken resolver would make every assertion above pass.
    const trail = reachableFrom(join(routes, "index.tsx"));

    expect(trail.get(FRONT_DOOR_MODULE)).toBeDefined();
    expect(trail.size).toBeGreaterThan(10);
  });
});

describe("the shared counts render ungrouped, which is the byte shape published responses carry", () => {
  // `findingsCount` reaches `GET /api/v1/graph/{kind}/{slug}` (graph-prose → graph-preview →
  // the get_graph_preview op) and the generated markdown homepage. These pin the exact strings, so
  // adding a thousands separator here fails the build rather than quietly changing a response body.
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
