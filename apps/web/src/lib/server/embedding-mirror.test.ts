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

function foreignWrites(): string[] {
  const out: string[] = [];

  for (const file of serverSources()) {
    if (file === "embedding.ts") {
      continue;
    }

    const source = readFileSync(join(SERVER, file), "utf8");

    if (/(?:insert\s+(?:or\s+\w+\s+)?into|delete\s+from)\s+track_embeddings/i.test(source)) {
      out.push(file);
    }
  }

  return out;
}

function sharedClears(): string[] {
  return serverSources().filter(
    (file) =>
      file !== "embedding.ts" &&
      readFileSync(join(SERVER, file), "utf8").includes("clearEmbeddingSatellite("),
  );
}

describe("the has_embedding mirror cannot drift", () => {
  it("finds the satellite's callers at all (the scanner still works)", () => {
    expect(sharedClears().length).toBeGreaterThanOrEqual(3);
  });

  it("keeps embedding.ts the ONLY module that writes track_embeddings", () => {
    expect(foreignWrites()).toEqual([]);
  });

  it("keeps each shared fragment carrying both halves of its pair", () => {
    const embedding = readFileSync(join(SERVER, "embedding.ts"), "utf8");

    expect(embedding).toContain("has_embedding = 0");
    expect(embedding).toContain("has_embedding = 1");

    expect(embedding).toContain("delete from track_embeddings");
    expect(embedding).toContain("insert into track_embeddings");

    expect(embedding).toContain("not exists (select 1 from tracks");
  });
});
