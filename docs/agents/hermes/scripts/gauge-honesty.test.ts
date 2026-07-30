import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const scriptsDir = dirname(import.meta.path);

function source(name: string): string {
  return readFileSync(join(scriptsDir, name), "utf8");
}

describe("capped pages are not backlog gauges", () => {
  test("enrich does not publish its capped catalogue page length as catalogueQueued", () => {
    expect(source("enrich-sweep.ts")).not.toContain("catalogueQueued");
  });

  test("entity-bio does not publish its capped, box-filtered page as queueRemaining", () => {
    expect(source("entity-bio-sweep.ts")).not.toContain("queueRemaining");
  });

  test("embed explicitly asks the server for the whole-backlog count", () => {
    expect(source("embed-sweep.ts")).toContain("&count=true");
  });
});
