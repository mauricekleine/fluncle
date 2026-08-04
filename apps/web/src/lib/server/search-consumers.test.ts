import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// THE READ-PATH LOCK. Fluncle has two searches, and the split is a boundary, not a migration
// (packages/contracts/src/orpc/search.ts): `search_tracks` (GET /api/v1/search) asks SPOTIFY
// for submit-funnel candidates and burns the operator's shared token; `search_archive`
// (GET /api/v1/search/archive) asks FLUNCLE, resolves a pasted Spotify link locally, and is
// the ONLY search a browse surface may call. This file is what stops the boundary drifting:
// it walks the app sources for every reference to the Spotify op — the literal path, the oRPC
// client op, and the client helpers that wrap it — and asserts the caller set equals the named
// submit-flow allowlist below. A new file appearing in the diff of this assertion is a new
// consumer of the Spotify op, and unless it is part of the submit flow it belongs on
// `search_archive` instead.

const REPO_ROOT = fileURLToPath(new URL("../../../../..", import.meta.url));

/** The source trees a consumer could live in — every app that speaks to the API. */
const SOURCE_ROOTS = ["apps/web/src", "apps/cli/src", "apps/mobile/app", "apps/mobile/src"];

/**
 * Every way app code reaches the Spotify op. The path regex is EXACT on purpose:
 * `/api/v1/search/archive` is the internal op and must not match, so the path may not be
 * followed by `/archive`. The helper markers cover the indirect callers — the web submit
 * dialog goes through `@/lib/submissions`, the mobile submit screen through `useTrackSearch`,
 * and mobile's hook itself through the `orpc.search_tracks` client op. The module-import
 * marker covers the server side: a file importing the capability (`lib/server/track-search`)
 * skips every helper and holds the op itself, in any spelling — relative at any depth or the
 * `@/` alias. The static marker is import-shaped (requires `from "…"`), while the dynamic marker
 * requires an actual `import("…")` call with a string literal. That call shape avoids prose that
 * merely mentions the module, non-import parentheses, and dynamic imports of unrelated modules.
 */
const DYNAMIC_TRACK_SEARCH_IMPORT_MARKER = /\bimport\s*\(\s*["'][^"']*\/track-search["']\s*\)/;

const SPOTIFY_OP_MARKERS = [
  /\/api\/v1\/search(?!\/archive)/,
  /\borpc\.search_tracks\b/,
  /\buseTrackSearch\b/,
  /from ["']@\/lib\/submissions["']/,
  /from ["'][^"']*\/track-search["']/,
  DYNAMIC_TRACK_SEARCH_IMPORT_MARKER,
];

/**
 * The submit flow, in full — the ONLY files allowed to reference the Spotify op. Each is a
 * leg of the same funnel: find a candidate Fluncle does not have yet, hand it to the operator.
 */
const SUBMIT_FLOW_ALLOWLIST = [
  // The CLI submit command's candidate search.
  "apps/cli/src/commands/submit.ts",
  // The mobile submit screen, driving the hook below.
  "apps/mobile/app/submit.tsx",
  // The mobile API hooks: `useTrackSearch` wraps the `search_tracks` client op.
  "apps/mobile/src/api/hooks.ts",
  // The web submit dialog, driving the `@/lib/submissions` helper.
  "apps/web/src/components/submit-track-dialog.tsx",
  // llms.txt + agent discovery: DOCUMENTS the op to agents as the submit path, calls nothing.
  "apps/web/src/lib/server/agent-discovery.ts",
  // The MCP `search_tracks` tool — the op's second mount, importing the capability directly.
  "apps/web/src/lib/server/mcp.ts",
  // The oRPC `search_tracks` handler — the op's HTTP mount, importing the capability directly.
  "apps/web/src/lib/server/orpc/search.ts",
  // The server-side capability behind the op — the implementation, not a consumer.
  "apps/web/src/lib/server/track-search.ts",
  // The web submit helper: the `searchTracks` fetch the dialog drives.
  "apps/web/src/lib/submissions.ts",
  // WebMCP's `search_tracks` tool — the submit funnel exposed to in-page agents.
  "apps/web/src/lib/webmcp.ts",
];

/**
 * Every .ts/.tsx source under `dir`, repo-relative with forward slashes. Test files are
 * excluded: they exercise the op deliberately (rate limits, headers, contract coverage) and
 * cannot put it on a browse surface.
 */
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

function referencesSpotifyOp(content: string): boolean {
  return SPOTIFY_OP_MARKERS.some((marker) => marker.test(content));
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
        "it at `search_archive`; if it is, add it to SUBMIT_FLOW_ALLOWLIST with a comment " +
        "saying which leg of the funnel it is.",
    ).toEqual(SUBMIT_FLOW_ALLOWLIST);
  });

  it("keeps the allowlist itself honest — every entry still references the op", () => {
    // A submit-flow file that stops referencing the op should leave the allowlist, so the
    // list never pads out into a set of exemptions nobody re-reads.
    for (const file of SUBMIT_FLOW_ALLOWLIST) {
      const content = readFileSync(join(REPO_ROOT, file), "utf8");

      expect(
        referencesSpotifyOp(content),
        `${file} no longer references the Spotify op — remove it from SUBMIT_FLOW_ALLOWLIST`,
      ).toBe(true);
    }
  });
});
