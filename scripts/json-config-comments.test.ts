import { readFile } from "node:fs/promises";

import { expect, test } from "bun:test";

import { noCommentsScope, REPOSITORY, trackedScopedFiles } from "./no-comments-scope.ts";

function commentKeyPaths(value: unknown, path: string): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => commentKeyPaths(item, `${path}[${String(index)}]`));
  }
  if (value === null || typeof value !== "object") {
    return [];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    key === "//" ? [`${path}./`] : commentKeyPaths(child, `${path}.${key}`),
  );
}

const scope = await noCommentsScope();
const files = (await trackedScopedFiles(scope)).filter((path) => /\.jsonc?$/.test(path));

test("scoped JSON parses without comments or trailing commas", async () => {
  const failures: string[] = [];
  for (const path of files) {
    const source = await readFile(`${REPOSITORY}/${path}`, "utf8");
    try {
      JSON.parse(source);
    } catch (error) {
      failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  expect(failures).toEqual([]);
});

test("scoped JSON has no comment keys", async () => {
  const failures: string[] = [];
  for (const path of files) {
    const parsed: unknown = JSON.parse(await readFile(`${REPOSITORY}/${path}`, "utf8"));
    failures.push(...commentKeyPaths(parsed, path));
  }
  expect(failures).toEqual([]);
});

test("comment-key detection reaches nested objects", () => {
  expect(commentKeyPaths({ a: [{ "//": "note" }] }, "fixture.json")).toEqual([
    "fixture.json.a[0]./",
  ]);
});
