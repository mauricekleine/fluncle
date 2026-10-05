import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DOCS_PAGES } from "./docs-pages";

const CONTENT_DIR = fileURLToPath(new URL("../../content/docs", import.meta.url));
const DOCS_PAGES_FILE = "apps/web/src/lib/docs-pages.ts";
const GIT_AVAILABLE = spawnSync("git", ["--version"]).status === 0;
const HISTORY_ROOT = fullHistoryRoot();

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

function fullHistoryRoot(): string | undefined {
  if (!GIT_AVAILABLE) {
    return undefined;
  }

  try {
    if (git(CONTENT_DIR, ["rev-parse", "--is-inside-work-tree"]) !== "true") {
      return undefined;
    }
    const root = git(CONTENT_DIR, ["rev-parse", "--show-toplevel"]);
    return git(root, ["rev-parse", "--is-shallow-repository"]) === "false" ? root : undefined;
  } catch {
    return undefined;
  }
}

function staleDocs(cwd: string, paths: readonly string[]): string[] {
  const offenders: string[] = [];

  for (const path of paths) {
    const source = `apps/web/content/docs/${path.slice("/docs/".length)}.mdx`;
    const mdxCommit = git(cwd, ["log", "-1", "--format=%H", "--", source]);
    const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const lastmodCommit = git(cwd, [
      "log",
      "-1",
      "--format=%H",
      "-G",
      `path: "${escapedPath}"`,
      "--",
      DOCS_PAGES_FILE,
    ]);
    const ancestor =
      mdxCommit &&
      lastmodCommit &&
      spawnSync("git", ["merge-base", "--is-ancestor", mdxCommit, lastmodCommit], { cwd })
        .status === 0;

    if (!ancestor) {
      offenders.push(
        `${path}: set its lastmod in ${DOCS_PAGES_FILE} to the edit time (ISO 8601 with offset), in the same commit as its .mdx edit or later`,
      );
    }
  }

  return offenders;
}

function docsOnDisk(): string[] {
  return readdirSync(CONTENT_DIR, { recursive: true })
    .map((entry) => String(entry).split(sep).join("/"))
    .filter((entry) => entry.endsWith(".mdx"))
    .map((entry) =>
      entry
        .replace(/\.mdx$/, "")
        .replace(/(^|\/)index$/, "$1")
        .replace(/\/$/, ""),
    )
    .filter((slug) => slug !== "")
    .sort()
    .map((slug) => `/docs/${slug}`);
}

describe("DOCS_PAGES", () => {
  it("matches content/docs/ exactly: add a doc, add its path; edit a doc, bump its lastmod", () => {
    expect(DOCS_PAGES.map((page) => page.path)).toEqual(docsOnDisk());
  });

  it.skipIf(HISTORY_ROOT === undefined)(
    "bumps a page's lastmod in the same commit as its .mdx, or later",
    () => {
      if (HISTORY_ROOT === undefined) {
        throw new Error("Full Git history is required");
      }
      expect(
        staleDocs(
          HISTORY_ROOT,
          DOCS_PAGES.map((page) => page.path),
        ),
      ).toEqual([]);
    },
  );

  it.skipIf(!GIT_AVAILABLE)(
    "rejects an MDX edit until that page's lastmod is bumped, in the same commit or later",
    () => {
      const cwd = mkdtempSync(join(tmpdir(), "fluncle-docs-lastmod-"));
      const path = "/docs/cli";
      const source = join(cwd, "apps/web/content/docs/cli.mdx");
      const writeDates = (cli: string, cliTools: string) => {
        writeFileSync(
          join(cwd, DOCS_PAGES_FILE),
          `export const DOCS_PAGES = [\n  { lastmod: "${cli}", path: "${path}" },\n  { lastmod: "${cliTools}", path: "/docs/cli-tools" },\n];\n`,
        );
      };
      const commit = () => {
        git(cwd, ["add", "."]);
        git(cwd, [
          "-c",
          "user.name=Docs test",
          "-c",
          "user.email=docs-test@example.com",
          "-c",
          "commit.gpgsign=false",
          "-c",
          "core.hooksPath=/dev/null",
          "commit",
          "-m",
          "Update docs",
        ]);
      };

      try {
        git(cwd, ["init"]);
        mkdirSync(join(cwd, "apps/web/content/docs"), { recursive: true });
        mkdirSync(join(cwd, "apps/web/src/lib"), { recursive: true });
        writeFileSync(source, "Original CLI docs\n");
        writeDates("2026-01-01T12:00:00+01:00", "2026-01-01T12:00:00+01:00");
        commit();
        expect(staleDocs(cwd, [path])).toEqual([]);

        writeFileSync(source, "Edited CLI docs\n");
        commit();
        expect(staleDocs(cwd, [path])).toEqual([
          `${path}: set its lastmod in ${DOCS_PAGES_FILE} to the edit time (ISO 8601 with offset), in the same commit as its .mdx edit or later`,
        ]);

        writeDates("2026-01-01T12:00:00+01:00", "2026-01-02T12:00:00+01:00");
        commit();
        expect(staleDocs(cwd, [path])).toHaveLength(1);

        writeDates("2026-01-02T12:00:00+01:00", "2026-01-02T12:00:00+01:00");
        commit();
        expect(staleDocs(cwd, [path])).toEqual([]);

        writeFileSync(source, "CLI docs edited again\n");
        writeDates("2026-01-03T12:00:00+01:00", "2026-01-02T12:00:00+01:00");
        commit();
        expect(staleDocs(cwd, [path])).toEqual([]);
      } finally {
        rmSync(cwd, { force: true, recursive: true });
      }
    },
  );

  it("dates every page with a valid ISO timestamp no later than now", () => {
    for (const { lastmod } of DOCS_PAGES) {
      expect(lastmod).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/,
      );
      expect(Number.isFinite(Date.parse(lastmod))).toBe(true);
      expect(Date.parse(lastmod)).toBeLessThanOrEqual(Date.now());
    }
  });

  it("has docs to list at all (a silently empty list would look like a clean pass)", () => {
    expect(DOCS_PAGES.length).toBeGreaterThan(0);
  });

  it("excludes the /docs hub — the sitemap's `pages` child owns it", () => {
    expect(DOCS_PAGES.map((page) => page.path)).not.toContain("/docs");
  });

  it("excludes /docs/api — a route, not a page in the content tree", () => {
    expect(DOCS_PAGES.map((page) => page.path)).not.toContain("/docs/api");
  });

  it("lists absolute /docs paths, never bare slugs", () => {
    for (const { path } of DOCS_PAGES) {
      expect(path.startsWith("/docs/")).toBe(true);
    }
  });
});
