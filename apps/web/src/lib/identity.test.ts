// The entity description is "reused verbatim; edit it here or nowhere" (see
// ./identity.ts, and VOICE.md §7's Meta description row). Every TypeScript surface
// honours that by importing the constant — home/about/reach heads, the MCP server
// card, agent-discovery's markdown, the JSON-LD.
//
// Two surfaces cannot import it, because they are static assets served straight off
// disk: `public/llms.txt` (the plain-language map every LLM and crawler reads) and
// `public/manifest.webmanifest` (the installed PWA's description). Both hold a
// HAND-COPIED duplicate of the same sentence, and nothing checked that the copies
// still matched — so an edit to `fluncleDescription` would silently leave the two
// most machine-read surfaces quoting the previous entity description.
//
// This is that check. It asserts equality, not containment: a paraphrase is exactly
// the failure the verbatim rule exists to prevent, and containment would pass one.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fluncleDescription, fluncleMetaDescription, fluncleTagline } from "./identity";

const APP_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function readPublicAsset(name: string): string {
  return readFileSync(join(APP_ROOT, "public", name), "utf8");
}

describe("the canonical entity description", () => {
  it("is quoted verbatim by public/llms.txt", () => {
    // The blockquote directly under the `# Fluncle` heading — llms.txt's summary
    // line, which is where the spec puts the one-sentence description of the site.
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

// THE TAGLINE, the other half of the same rule.
//
// `fluncleDescription` and `fluncleMetaDescription` both OPEN with it, and it is the
// shortest form of the entity a stranger meets: the SSH figlet's under-line, the home
// masthead, the global footer, the feed subtitles, the API reference's summary, the
// Bluesky link card, the video close card, the Homebrew formula's `desc`. Twenty-one
// files spell it out by hand, and they cannot all import a constant — one is Go, one is
// Ruby, three are static assets served straight off disk, four render it HTML-escaped,
// and one deliberately lowercases it inside a `<title>`. So the constant is the NAME of
// the string rather than its only copy, and this is the pin that makes the copies one
// edit: it derives its search from `fluncleTagline` itself, so changing the constant
// without sweeping the sites empties the scan and fails here rather than shipping a
// half-renamed entity.
//
// `*.test.*` files are skipped: a test that quotes the tagline already asserts on it and
// fails on its own terms. `packages/skills` is skipped too — the copywriting skill quotes
// the tagline as CANON (it is where the string is ratified), not as a surface that ships it.

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/**
 * Every file that spells the tagline out. Verified by the scan below, which fails both
 * ways: a new hand-typed copy that is not listed here, and a listed file that stopped
 * carrying it (which is what an un-swept edit to `fluncleTagline` looks like).
 */
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
  "apps/web/src/routes/-docs-head.ts",
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

/**
 * Build output, vendored trees, and the canon that RATIFIES the tagline. Every
 * DOT-directory goes too, by rule rather than by name: `.expo`, `.output`, `.turbo`,
 * `apps/web/.dev` and whatever the next tool digs are untracked local artifacts, and one
 * of them holding a stale copy of the tagline would fail this scan on a developer's
 * machine while passing in CI.
 */
const SKIPPED_DIRECTORIES = new Set([
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "skills",
  "target",
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

/**
 * The tagline's SHAPE, derived from the constant so the two can never disagree: word
 * boundaries go loose, and the ampersand also matches its HTML entity and the spelled-out
 * "and". That looseness is the point — it catches a near-miss spelling ("Drum and bass
 * bangers from another dimension") that an exact search would walk straight past.
 */
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

/** Every tagline-shaped match in the repo, un-escaped back to what a reader sees. */
function taglineMatches(): { file: string; text: string }[] {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    collectFiles(root, files);
  }

  const matches: { file: string; text: string }[] = [];
  for (const file of files) {
    for (const match of readFileSync(join(REPO_ROOT, file), "utf8").matchAll(looseTagline())) {
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
    // The one sanctioned variant: `__root.tsx` and the build banner lowercase the whole
    // line INSIDE a title ("Fluncle: drum & bass bangers from another dimension"), which
    // is sentence case doing its job, not a second spelling of the name.
    const drifted = taglineMatches()
      .filter(({ text }) => text !== fluncleTagline && text !== fluncleTagline.toLowerCase())
      .map(({ file, text }) => `${file} ${JSON.stringify(text)}`);

    expect(drifted).toEqual([]);
  });
});
