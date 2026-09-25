import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../", import.meta.url));

function read(relative: string): string {
  return readFileSync(join(SRC, relative), "utf8");
}

function tsxFiles(dir = SRC, prefix = ""): string[] {
  const out: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      out.push(...tsxFiles(join(dir, entry.name), rel));
    } else if (entry.name.endsWith(".tsx")) {
      out.push(rel);
    }
  }

  return out;
}

describe("apple_music_url certification rail", () => {
  it("the graph-page unlit DTO (tracks.ts CatalogueTrackItem) carries no appleMusicUrl", () => {
    const src = read("lib/server/tracks.ts");
    const start = src.indexOf("export type CatalogueTrackItem");
    expect(start, "the unlit DTO type should exist").toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf("};", start));

    expect(block).not.toContain("appleMusicUrl");
    expect(block).not.toContain("apple_music_url");
  });

  it("the PUBLIC unlit SQL reads never select apple_music_url", () => {
    const tracks = read("lib/server/tracks.ts");
    const groups = read("lib/server/catalogue-groups.ts");

    for (const fn of ["listCatalogueTracksByAlbum"]) {
      const start = tracks.indexOf(`export async function ${fn}`);
      expect(start, `${fn} should exist`).toBeGreaterThan(-1);
      const body = tracks.slice(start, tracks.indexOf("\n}", start));
      expect(body, `${fn} must not select apple_music_url`).not.toContain("apple_music_url");
    }

    expect(groups).not.toContain("apple_music_url");
  });

  it("only certified-finding surfaces + the admin catalogue + /mix reference appleMusicUrl in the component tree", () => {
    const ALLOWED = new Set([
      "components/mix/mix-builder.tsx",
      "routes/admin/catalogue.tsx",
      "routes/log.$logId.tsx",
    ]);

    const offenders = tsxFiles().filter((file) => read(file).includes("appleMusicUrl"));

    expect(new Set(offenders)).toEqual(ALLOWED);
  });
});
