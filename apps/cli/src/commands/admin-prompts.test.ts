import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as realApi from "../api";
import { CliError } from "../output";

// The registry as the server hands it back: one prompt with a two-version history whose
// live body has drifted from the repo's baked default, and one that has never been
// touched (source "default", version 0, no history at all). Between them they cover every
// branch the composed commands take.
const NOTE_DEFAULT = "You are Fluncle.\nWrite the note.\nNo em dashes.";
const NOTE_V1 = "You are Fluncle.\nWrite the note.\nOne sentence.";
const NOTE_V2 = "You are Fluncle.\nWrite the note.\nOne sentence.\nLead with the feel.";

const registry = [
  {
    activeBody: NOTE_V2,
    activeVersion: 2,
    defaultBody: NOTE_DEFAULT,
    description: "Writes a finding's public editorial note.",
    slug: "note_author",
    source: "override" as const,
    surface: "box" as const,
    title: "Finding note",
    variables: ["artists", "title"],
    versions: [
      {
        body: NOTE_V2,
        createdAt: "2026-07-11T09:00:00.000Z",
        createdBy: "operator" as const,
        id: "v2",
        note: "lead with the feel",
        version: 2,
      },
      {
        body: NOTE_V1,
        createdAt: "2026-07-10T09:00:00.000Z",
        createdBy: "operator" as const,
        id: "v1",
        note: null,
        version: 1,
      },
    ],
  },
  {
    activeBody: "You translate a query into a filter.",
    activeVersion: 0,
    defaultBody: "You translate a query into a filter.",
    description: "A parser, not a voice.",
    slug: "search_filter",
    source: "default" as const,
    surface: "worker" as const,
    title: "Search filter",
    variables: [],
    versions: [],
  },
];

// Every write the CLI makes, captured: the append-only API takes exactly one shape, so a
// rollback, a reset, and an edit are all a POST here and the body is the only tell.
let posts: Array<{ body: { body?: string; note?: string }; path: string }> = [];
let gets: string[] = [];

await mock.module("../api", () => ({
  ...realApi,
  adminApiGet: async (path: string) => {
    gets.push(path);

    if (path === "/api/v1/admin/prompts") {
      return { ok: true, prompts: registry };
    }

    return { body: NOTE_V2, ok: true, slug: "note_author", source: "override", version: 2 };
  },
  adminApiPost: async (path: string, body: { body?: string; note?: string }) => {
    posts.push({ body, path });

    return { ok: true, version: 3 };
  },
}));

const {
  bodyLines,
  diffLines,
  historyRows,
  parseAgainst,
  parseVersion,
  promptDetailCommand,
  promptDiffCommand,
  promptGetCommand,
  promptResetCommand,
  promptRollbackCommand,
  promptRows,
  promptUpdateCommand,
  renderDiff,
} = await import("./admin-prompts");

beforeEach(() => {
  posts = [];
  gets = [];
});

describe("the line diff (a dependency-free LCS)", () => {
  test("marks what came out, what went in, and what was carried over", () => {
    const lines = diffLines(["a", "b", "c"], ["a", "x", "c"]);

    expect(lines).toEqual([
      { kind: "context", text: "a" },
      { kind: "remove", text: "b" },
      { kind: "add", text: "x" },
      { kind: "context", text: "c" },
    ]);
  });

  test("an identical body yields context only, nothing added and nothing removed", () => {
    const lines = diffLines(["a", "b"], ["a", "b"]);

    expect(lines.every((line) => line.kind === "context")).toBe(true);
  });

  test("keeps the common run rather than rewriting the whole body (that is the LCS)", () => {
    // A naive line-by-line compare would call every line changed. The LCS keeps the two
    // shared lines as context and reports the insertion alone, which is what makes a
    // one-line prompt tweak read as a one-line diff.
    const lines = diffLines(["a", "b"], ["a", "new", "b"]);

    expect(lines).toEqual([
      { kind: "context", text: "a" },
      { kind: "add", text: "new" },
      { kind: "context", text: "b" },
    ]);
  });

  test("an empty against-body is all additions; an emptied live body is all removals", () => {
    expect(diffLines([], ["a", "b"])).toEqual([
      { kind: "add", text: "a" },
      { kind: "add", text: "b" },
    ]);
    expect(diffLines(["a", "b"], [])).toEqual([
      { kind: "remove", text: "a" },
      { kind: "remove", text: "b" },
    ]);
  });

  test("renders with plain +/- prefixes, so it still reads in a pipe", () => {
    expect(renderDiff(diffLines(["a", "b"], ["a", "x"]))).toEqual(["  a", "- b", "+ x"]);
  });

  test("bodyLines splits on newlines and drops a trailing one (a file's last \\n is not a line)", () => {
    expect(bodyLines("one\ntwo\n")).toEqual(["one", "two"]);
    expect(bodyLines("one\r\ntwo")).toEqual(["one", "two"]);
  });
});

describe("argument handling", () => {
  test("--against defaults to the repo's baked default", () => {
    expect(parseAgainst(undefined)).toEqual({ kind: "default" });
    expect(parseAgainst("default")).toEqual({ kind: "default" });
    expect(parseAgainst(" DEFAULT ")).toEqual({ kind: "default" });
  });

  test("--against takes a version as 3 or v3", () => {
    expect(parseAgainst("3")).toEqual({ kind: "version", version: 3 });
    expect(parseAgainst("v3")).toEqual({ kind: "version", version: 3 });
  });

  test("--against rejects anything else rather than guessing a version", () => {
    expect(() => parseAgainst("latest")).toThrow(CliError);
    expect(() => parseAgainst("-1")).toThrow(CliError);
  });

  test("a version argument reads as 3 or v3; v0 is not a version (that is the default)", () => {
    expect(parseVersion("2")).toBe(2);
    expect(parseVersion("v2")).toBe(2);
    expect(parseVersion("0")).toBeUndefined();
    expect(parseVersion("two")).toBeUndefined();
  });
});

describe("the reads", () => {
  test("get resolves one slug over the lean agent-tier path", async () => {
    const resolved = await promptGetCommand("note_author");

    expect(gets).toEqual(["/api/v1/admin/prompts/note_author"]);
    expect(resolved.version).toBe(2);
  });

  test("an unknown slug fails client-side and names the ones that exist", async () => {
    const failure = await promptDetailCommand("note-author").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CliError);
    expect((failure as CliError).code).toBe("unknown_prompt");
    expect((failure as CliError).message).toContain("note_author");
    expect((failure as CliError).message).toContain("search_filter");
  });

  test("the registry rows say what is actually running: an edit, or the repo's body", () => {
    const rows = promptRows(registry);

    expect(rows[0]).toContain("note_author");
    expect(rows[0]).toContain("v2");
    expect(rows[1]).toContain("default");
  });

  test("history reads newest first, and a version with no why says so", () => {
    const rows = historyRows(registry[0]?.versions ?? []);

    expect(rows[0]).toBe("v2  2026-07-11  operator  lead with the feel");
    expect(rows[1]).toBe("v1  2026-07-10  operator  (no note)");
  });
});

describe("diff — the live body against a version, or against the repo", () => {
  test("defaults to the repo's baked default", async () => {
    const result = await promptDiffCommand("note_author", { kind: "default" });

    expect(result.against.version).toBe(0);
    expect(result.live.version).toBe(2);
    expect(result.added).toBe(2);
    expect(result.removed).toBe(1);
    // No write on a read.
    expect(posts).toEqual([]);
  });

  test("against a stored version, it compares body to body", async () => {
    const result = await promptDiffCommand("note_author", { kind: "version", version: 1 });

    expect(result.against.label).toBe("v1");
    expect(result.added).toBe(1);
    expect(result.removed).toBe(0);
  });

  test("a prompt on its baked default diffs to nothing", async () => {
    const result = await promptDiffCommand("search_filter", { kind: "default" });

    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
  });

  test("a version that is not on file fails rather than diffing against nothing", async () => {
    const failure = await promptDiffCommand("note_author", { kind: "version", version: 9 }).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(CliError);
    expect((failure as CliError).code).toBe("unknown_version");
  });
});

describe("update — the one write", () => {
  test("appends the file's body, carrying the operator's why", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fluncle-prompts-"));
    const file = join(dir, "body.txt");
    writeFileSync(file, "A new body.\n");

    const result = await promptUpdateCommand("note_author", { bodyFile: file, note: "tightened" });

    expect(posts).toEqual([
      {
        body: { body: "A new body.\n", note: "tightened" },
        path: "/api/v1/admin/prompts/note_author",
      },
    ]);
    expect(result.version).toBe(3);

    rmSync(dir, { force: true, recursive: true });
  });

  test("without a body file it asks for one, and writes nothing", async () => {
    const failure = await promptUpdateCommand("note_author", {}).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CliError);
    expect((failure as CliError).code).toBe("missing_body");
    expect(posts).toEqual([]);
  });

  test("a missing file is caught before the API call", async () => {
    const failure = await promptUpdateCommand("note_author", {
      bodyFile: "/nonexistent-prompt-body.txt",
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CliError);
    expect((failure as CliError).code).toBe("file_not_found");
    expect(posts).toEqual([]);
  });

  test("an empty file never becomes an empty prompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fluncle-prompts-"));
    const file = join(dir, "blank.txt");
    writeFileSync(file, "   \n");

    const failure = await promptUpdateCommand("note_author", { bodyFile: file }).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(CliError);
    expect((failure as CliError).code).toBe("empty_body");
    expect(posts).toEqual([]);

    rmSync(dir, { force: true, recursive: true });
  });
});

describe("rollback and reset — the safety net, composed over the same one write", () => {
  test("rollback re-appends the old version's body with an auto-note, minting a NEW version", async () => {
    const result = await promptRollbackCommand("note_author", 1);

    // The history is append-only: v1's body comes back as v3 rather than v2 being erased,
    // which is what makes the rollback itself rollback-able.
    expect(posts).toEqual([
      {
        body: { body: NOTE_V1, note: "rolled back to v1" },
        path: "/api/v1/admin/prompts/note_author",
      },
    ]);
    expect(result).toEqual({ from: 1, skipped: false, slug: "note_author", version: 3 });
  });

  test("rolling back to the body already running appends nothing", async () => {
    const result = await promptRollbackCommand("note_author", 2);

    expect(posts).toEqual([]);
    expect(result).toEqual({ from: 2, skipped: true, slug: "note_author", version: 2 });
  });

  test("a version that is not on file fails, and names what is", async () => {
    const failure = await promptRollbackCommand("note_author", 7).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CliError);
    expect((failure as CliError).code).toBe("unknown_version");
    expect((failure as CliError).message).toContain("v2, v1");
    expect(posts).toEqual([]);
  });

  test("rollback on a never-edited prompt points at reset instead", async () => {
    const failure = await promptRollbackCommand("search_filter", 1).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(CliError);
    expect((failure as CliError).message).toContain("no history yet");
    expect(posts).toEqual([]);
  });

  test("reset appends the REPO's body, not a stored one", async () => {
    const result = await promptResetCommand("note_author");

    expect(posts).toEqual([
      {
        body: { body: NOTE_DEFAULT, note: "reset to the repo's baked default" },
        path: "/api/v1/admin/prompts/note_author",
      },
    ]);
    expect(result).toEqual({ from: 0, skipped: false, slug: "note_author", version: 3 });
  });

  test("resetting a prompt already on its default appends nothing", async () => {
    const result = await promptResetCommand("search_filter");

    expect(posts).toEqual([]);
    expect(result.skipped).toBe(true);
    expect(result.version).toBe(0);
  });
});
