import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SERVER = fileURLToPath(new URL("./", import.meta.url));

function serverSources(dir = SERVER, prefix = ""): string[] {
  const out: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      out.push(...serverSources(join(dir, entry.name), rel));
    } else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
      out.push(rel);
    }
  }

  return out;
}

type Assignment = { file: string; statement: string };

function assignments(): Assignment[] {
  const found: Assignment[] = [];

  for (const file of serverSources()) {
    if (file === "isrc.ts") {
      continue;
    }

    const source = readFileSync(join(SERVER, file), "utf8");

    for (const match of source.matchAll(/(?<![\w])isrc\s*=\s*(\?|coalesce)/g)) {
      const start = Math.max(0, match.index - 400);
      found.push({ file, statement: source.slice(start, match.index + 400) });
    }
  }

  return found;
}

function isrcInserts(): Assignment[] {
  const found: Assignment[] = [];

  for (const file of serverSources()) {
    const source = readFileSync(join(SERVER, file), "utf8");

    for (const match of source.matchAll(/insert(?:\s+or\s+ignore)?\s+into\s+tracks/g)) {
      const statement = source.slice(match.index, match.index + 900);

      if (/[(,\s]isrc\s*[,)]/.test(statement)) {
        found.push({ file, statement });
      }
    }
  }

  return found;
}

function sharedFills(): string[] {
  return serverSources().filter(
    (file) =>
      file !== "isrc.ts" && readFileSync(join(SERVER, file), "utf8").includes("${FILL_ISRC_SQL}"),
  );
}

describe("the has_isrc mirror cannot drift", () => {
  it("finds the isrc writers at all (the scanner still works)", () => {
    expect(assignments().length + sharedFills().length).toBeGreaterThanOrEqual(3);
    expect(isrcInserts().length).toBeGreaterThanOrEqual(3);
  });

  it("pairs every SQL isrc assignment with its has_isrc mirror", () => {
    const unpaired = assignments()
      .filter(
        ({ statement }) => !statement.includes("has_isrc") && !statement.includes("FILL_ISRC_SQL"),
      )
      .map(({ file }) => file);

    expect(unpaired).toEqual([]);
  });

  it("pairs every tracks insert that names isrc with its has_isrc mirror", () => {
    const unpaired = isrcInserts()
      .filter(({ statement }) => !statement.includes("has_isrc"))
      .map(({ file }) => file);

    expect(unpaired).toEqual([]);
  });

  it("keeps the shared fill fragment carrying both halves", () => {
    const isrc = readFileSync(join(SERVER, "isrc.ts"), "utf8");

    expect(isrc).toContain("isrc = coalesce(isrc, ?)");
    expect(isrc).toContain("has_isrc = (trim(coalesce(isrc, ?, '')) <> '')");
  });
});
