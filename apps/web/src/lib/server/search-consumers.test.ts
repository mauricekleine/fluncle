import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../../..", import.meta.url));

const SOURCE_ROOTS = ["apps/web/src", "apps/cli/src", "apps/mobile/app", "apps/mobile/src"];

const DYNAMIC_TRACK_SEARCH_IMPORT_MARKER = /\bimport\s*\(\s*["'][^"']*\/track-search["']\s*\)/;

const SPOTIFY_OP_MARKERS = [
  /\/api\/v1\/search(?!\/archive)/,
  /\borpc\.search_tracks\b/,
  /\buseTrackSearch\b/,
  /from ["']@\/lib\/submissions["']/,
  /from ["'][^"']*\/track-search["']/,
  DYNAMIC_TRACK_SEARCH_IMPORT_MARKER,
];

const SUBMIT_FLOW_ALLOWLIST = [
  "apps/cli/src/commands/submit.ts",
  "apps/mobile/app/submit.tsx",
  "apps/mobile/src/api/hooks.ts",
  "apps/web/src/components/submit-track-dialog.tsx",
  "apps/web/src/lib/server/agent-discovery.ts",
  "apps/web/src/lib/server/mcp.ts",
  "apps/web/src/lib/server/orpc/search.ts",
  "apps/web/src/lib/submissions.ts",
  "apps/web/src/lib/webmcp.ts",
];

function sourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const absolute = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === "node_modules") {
        continue;
      }

      files.push(...sourceFiles(absolute));
      continue;
    }

    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) {
      continue;
    }

    files.push(relative(REPO_ROOT, absolute).split(sep).join("/"));
  }

  return files;
}

function codeWithoutComments(file: string, source: string): string {
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

function referencesSpotifyOp(content: string): boolean {
  const code = codeWithoutComments("source.tsx", content);
  return SPOTIFY_OP_MARKERS.some((marker) => marker.test(code));
}

describe("the read path is internal-only — every Spotify-op caller is submit flow", () => {
  it("recognizes literal dynamic track-search imports and rejects lookalikes", () => {
    const mockBrowseRoute = `
      export async function load() {
        return await import("@/lib/server/track-search");
      }
    `;
    const mockRelativeBrowseRoute = `
      export async function load() {
        return await import
        (
          "../lib/server/track-search"
        );
      }
    `;

    expect(referencesSpotifyOp(mockBrowseRoute)).toBe(true);
    expect(referencesSpotifyOp(mockRelativeBrowseRoute)).toBe(true);
    expect(referencesSpotifyOp("// search_tracks and /api/v1/search")).toBe(false);
    expect(
      DYNAMIC_TRACK_SEARCH_IMPORT_MARKER.test("// prose mentions lib/server/track-search"),
    ).toBe(false);
    expect(DYNAMIC_TRACK_SEARCH_IMPORT_MARKER.test('load("@/lib/server/track-search")')).toBe(
      false,
    );
    expect(DYNAMIC_TRACK_SEARCH_IMPORT_MARKER.test('await import("@/lib/server/search")')).toBe(
      false,
    );
  });

  it("finds exactly the allowlisted submit-flow files referencing the Spotify op", () => {
    const callers = SOURCE_ROOTS.flatMap((root) => sourceFiles(join(REPO_ROOT, root)))
      .filter((file) => referencesSpotifyOp(readFileSync(join(REPO_ROOT, file), "utf8")))
      .sort();

    expect(
      callers,
      "The Spotify op (`search_tracks`, GET /api/v1/search) exists ONLY for the submit funnel " +
        "— every browse surface searches the archive through `search_archive` " +
        "(GET /api/v1/search/archive), which resolves a pasted Spotify link locally. A file " +
        "added here is a new Spotify-op consumer: if it is not part of the submit flow, point " +
        "it at `search_archive`; if it is, add it to SUBMIT_FLOW_ALLOWLIST with a reason " +
        "saying which leg of the funnel it is.",
    ).toEqual(SUBMIT_FLOW_ALLOWLIST);
  });

  it("keeps the allowlist itself honest — every entry still references the op", () => {
    for (const file of SUBMIT_FLOW_ALLOWLIST) {
      const content = readFileSync(join(REPO_ROOT, file), "utf8");

      expect(
        referencesSpotifyOp(content),
        `${file} no longer references the Spotify op — remove it from SUBMIT_FLOW_ALLOWLIST`,
      ).toBe(true);
    }
  });
});
