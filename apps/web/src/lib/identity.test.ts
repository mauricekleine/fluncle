import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vitest";
import { fluncleDescription, fluncleMetaDescription, fluncleTagline } from "./identity";

const APP_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function readPublicAsset(name: string): string {
  return readFileSync(join(APP_ROOT, "public", name), "utf8");
}

describe("the canonical entity description", () => {
  it("is quoted verbatim by public/llms.txt", () => {
    const blockquote = readPublicAsset("llms.txt")
      .split("\n")
      .find((line) => line.startsWith("> "));

    expect(blockquote).toBe(`> ${fluncleDescription}`);
  });

  it("is quoted verbatim by public/manifest.webmanifest", () => {
    const manifest: unknown = JSON.parse(readPublicAsset("manifest.webmanifest"));
    const description =
      typeof manifest === "object" && manifest !== null
        ? (manifest as Record<string, unknown>).description
        : undefined;

    expect(description).toBe(fluncleDescription);
  });
});

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

const TAGLINE_SITES = [
  "apps/cli/packaging/homebrew/fluncle.rb",
  "apps/cli/scripts/build-npm.ts",
  "apps/cli/src/brand.ts",
  "apps/ssh/main.go",
  "apps/web/public/humans.txt",
  "apps/web/public/llms.txt",
  "apps/web/public/manifest.webmanifest",
  "apps/web/src/components/nav/nav-footer.tsx",
  "apps/web/src/lib/identity.ts",
  "apps/web/src/lib/server/bluesky.ts",
  "apps/web/src/lib/server/orpc.ts",
  "apps/web/src/routes/__root.tsx",
  "apps/web/src/routes/atom[.]xml.ts",
  "apps/web/src/routes/feed[.]json.ts",
  "apps/web/src/routes/findings.tsx",
  "apps/web/src/routes/radio.tsx",
  "apps/web/src/routes/rss[.]xml.ts",
  "apps/web/vite.config.ts",
  "packages/video/src/remotion/journey/close-card.tsx",
  "packages/video/src/set-video/set-composition.tsx",
];

const SCAN_ROOTS = ["apps", "packages"];

const SKIPPED_DIRECTORIES = new Set([
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",

  "playwright-report",
  "skills",
  "target",
  "test-results",
]);

const SCANNED_EXTENSIONS = [
  ".css",
  ".go",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mdx",
  ".rb",
  ".ts",
  ".tsx",
  ".txt",
  ".webmanifest",
];

function looseTagline(): RegExp {
  const shape = fluncleTagline
    .split(/\s+/)
    .map((word) =>
      word === "&" ? "(?:&(?:amp;)?|and)" : word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("\\s+");

  return new RegExp(shape, "gi");
}

function collectFiles(root: string, files: string[]): void {
  for (const entry of readdirSync(join(REPO_ROOT, root), { withFileTypes: true })) {
    const child = `${root}/${entry.name}`;

    if (entry.isDirectory()) {
      if (!entry.name.startsWith(".") && !SKIPPED_DIRECTORIES.has(entry.name)) {
        collectFiles(child, files);
      }
      continue;
    }

    if (
      !/\.test\./.test(entry.name) &&
      SCANNED_EXTENSIONS.some((ext) => entry.name.endsWith(ext))
    ) {
      files.push(child);
    }
  }
}

function codeWithoutComments(file: string, source: string): string {
  if (!/\.[cm]?[jt]sx?$/.test(file)) {
    return source;
  }
  const comments = parseSync(file, source).comments;
  let code = "";
  let cursor = 0;
  for (const comment of comments) {
    code += source.slice(cursor, comment.start);
    code += " ".repeat(comment.end - comment.start);
    cursor = comment.end;
  }
  return code + source.slice(cursor);
}

function taglineMatches(): { file: string; text: string }[] {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    collectFiles(root, files);
  }

  const matches: { file: string; text: string }[] = [];
  for (const file of files) {
    const source = readFileSync(join(REPO_ROOT, file), "utf8");
    for (const match of codeWithoutComments(file, source).matchAll(looseTagline())) {
      matches.push({ file, text: match[0].replace(/&amp;/g, "&") });
    }
  }

  return matches;
}

describe("the canonical tagline", () => {
  it("opens both identity strings", () => {
    expect(fluncleDescription.startsWith(`${fluncleTagline}.`)).toBe(true);
    expect(fluncleMetaDescription.startsWith(`${fluncleTagline}.`)).toBe(true);
  });

  it("is spelled out in exactly the files that are pinned to it", () => {
    const found = [...new Set(taglineMatches().map(({ file }) => file))].sort();

    expect(found).toEqual([...TAGLINE_SITES].sort());
  });

  it("is spelled the same way at every one of them", () => {
    const drifted = taglineMatches()
      .filter(({ text }) => text !== fluncleTagline && text !== fluncleTagline.toLowerCase())
      .map(({ file, text }) => `${file} ${JSON.stringify(text)}`);

    expect(drifted).toEqual([]);
  });
});
