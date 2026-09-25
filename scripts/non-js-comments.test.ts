import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Parser } from "yaml";
import { noCommentsScope, trackedScopedFiles } from "./no-comments-scope.ts";

const root = resolve(import.meta.dir, "..");

const scope = await noCommentsScope();
const files = await trackedScopedFiles(scope);

const SHFMT_INSTALL_TIMEOUT_MS = 120_000;

const isShellFile = (path: string): boolean => {
  if (path.endsWith(".sh")) {
    return true;
  }
  if (basename(path).includes(".")) {
    return false;
  }
  return /^#!.*(?:\/|env(?:\s+-S)?\s+)(?:bash|sh)(?:\s|$)/.test(
    readFileSync(resolve(root, path), "utf8").split("\n", 1)[0] ?? "",
  );
};

beforeAll(() => {
  const setup = spawnSync(resolve(root, ".claude/hooks/setup-shfmt-helper.sh"), [], {
    encoding: "utf8",
  });
  if (setup.status !== 0) {
    throw new Error(`pinned shfmt helper could not be installed: ${setup.stderr}`);
  }
}, SHFMT_INSTALL_TIMEOUT_MS);

type ShellComment = { line: number; text: string };

const shellComments = (source: string, path: string): ShellComment[] => {
  const parseable = source.replace(/\$\{\{[\s\S]*?\}\}/g, (expression) =>
    expression.replace(/[^\n]/g, "x"),
  );
  const result = spawnSync(resolve(root, ".claude/hooks/shfmt-to-json.sh"), ["--to-json"], {
    encoding: "utf8",
    input: parseable,
    maxBuffer: 64 * 1024 * 1024,
  });
  expect(result.status, `${path}: ${result.stderr}`).toBe(0);
  const found = new Map<string, ShellComment>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") {
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    const record = value as Record<string, unknown>;
    const comments = [
      ...(Array.isArray(record.Comments) ? record.Comments : []),
      ...(Array.isArray(record.Last) ? record.Last : []),
    ];
    for (const valueComment of comments) {
      const comment = valueComment as {
        Pos?: { Offset?: number; Line?: number };
        End?: { Offset?: number };
        Text?: string;
      };
      if (
        typeof comment.Pos?.Offset !== "number" ||
        typeof comment.Pos.Line !== "number" ||
        typeof comment.End?.Offset !== "number"
      ) {
        continue;
      }
      const commentText = comment.Text ?? "";
      if (typeof commentText !== "string") {
        continue;
      }
      if (commentText.startsWith("!") || /^\s*shellcheck\b/.test(commentText)) {
        continue;
      }
      found.set(`${comment.Pos.Offset}:${comment.End.Offset}`, {
        line: comment.Pos.Line,
        text: commentText,
      });
    }
    for (const child of Object.values(record)) {
      visit(child);
    }
  };
  visit(JSON.parse(result.stdout));
  return [...found.values()].sort((left, right) => left.line - right.line);
};

const ACTION_VERSION_COMMENT = /^#\s*v\d+(?:\.\d+)*(?:\s|$)/;
const DIGEST_PINNED_USES = /\buses:\s*\S+@[0-9a-f]{40}\s*$/;

function pinsActionVersion(
  source: string,
  comment: { offset?: number; source?: unknown },
): boolean {
  const offset = comment.offset ?? 0;
  const line = source.slice(source.lastIndexOf("\n", offset - 1) + 1, offset);
  return (
    typeof comment.source === "string" &&
    ACTION_VERSION_COMMENT.test(comment.source) &&
    DIGEST_PINNED_USES.test(line)
  );
}

const yamlComments = (source: string, path: string): string[] => {
  const found: string[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") {
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    const record = value as Record<string, unknown> & {
      type?: string;
      offset?: number;
      items?: Array<{
        key?: { source?: string };
        value?: { type?: string; source?: string };
      }>;
    };
    if (record.type === "comment" && !pinsActionVersion(source, record)) {
      found.push(`${path}:${record.offset ?? 0}`);
    }
    if (record.type === "block-map" && Array.isArray(record.items)) {
      const shell = record.items.find((item) => item.key?.source === "shell")?.value?.source;
      for (const item of record.items) {
        if (
          item.key?.source === "run" &&
          item.value?.type === "block-scalar" &&
          typeof item.value.source === "string" &&
          (!shell || /^(?:bash|sh)(?:\s|$)/.test(shell))
        ) {
          for (const comment of shellComments(item.value.source, `${path}:run`)) {
            found.push(`${path}:run:${comment.line}`);
          }
        }
      }
    }
    for (const child of Object.values(record)) {
      visit(child);
    }
  };
  for (const token of new Parser().parse(source)) {
    visit(token);
  }
  return found;
};

describe("non-JavaScript comments", () => {
  test("tracked shell scripts contain only shebangs and shellcheck directives", () => {
    const violations = files
      .filter(isShellFile)
      .flatMap((path) =>
        shellComments(readFileSync(resolve(root, path), "utf8"), path).map(
          (comment) => `${path}:${comment.line}`,
        ),
      );
    expect(violations).toEqual([]);
  }, 30_000);

  test("tracked YAML and shell run blocks contain no comments", () => {
    const violations = files
      .filter((path) => /\.ya?ml$/.test(path))
      .flatMap((path) => yamlComments(readFileSync(resolve(root, path), "utf8"), path));
    expect(violations).toEqual([]);
  });

  test("shell comments are identified without mistaking a shebang for prose", () => {
    expect(shellComments("#!/bin/sh\n#\necho ok # note\n# trailing\n", "fixture.sh")).toEqual([
      { line: 2, text: "" },
      { line: 3, text: " note" },
      { line: 4, text: " trailing" },
    ]);
  });

  test("YAML comments are identified without rejecting action version pins", () => {
    expect(yamlComments("name: test # note\n", "fixture.yml")).not.toEqual([]);
    expect(yamlComments("steps:\n  - run: |\n      echo ok # note\n", "fixture.yml")).not.toEqual(
      [],
    );
    expect(
      yamlComments(
        "uses: actions/checkout@0123456789abcdef0123456789abcdef01234567 # v4\n",
        "fixture.yml",
      ),
    ).toEqual([]);
  });
});
