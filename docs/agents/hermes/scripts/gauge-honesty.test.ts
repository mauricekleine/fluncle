import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const scriptsDir = dirname(import.meta.path);

function source(name: string): string {
  return readFileSync(join(scriptsDir, name), "utf8");
}

describe("embed backlog gauge", () => {
  test("embed explicitly asks the server for the whole-backlog count", () => {
    expect(source("embed-sweep.ts")).toContain("&count=true");
  });
});
