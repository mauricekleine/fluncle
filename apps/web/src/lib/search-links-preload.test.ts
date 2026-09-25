import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = new URL("..", import.meta.url).pathname;

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);

    if (statSync(path).isDirectory()) {
      return sources(path);
    }

    return path.endsWith(".tsx") && !path.endsWith(".test.tsx") ? [path] : [];
  });
}

describe("a link into /search never preloads", () => {
  it("holds every Link built by searchPagePath or similarSearchHref to preload={false}", () => {
    const offenders: string[] = [];

    for (const path of sources(root)) {
      const source = readFileSync(path, "utf8");

      for (const match of source.matchAll(
        /<Link\b[^>]*?(searchPagePath|similarSearchHref)\([^>]*?>/gs,
      )) {
        if (!match[0].includes("preload={false}")) {
          offenders.push(relative(root, path));
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
