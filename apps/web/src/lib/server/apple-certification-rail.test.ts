import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// THE CERTIFICATION RAIL FOR apple_music_url (RFC musickit U1, "Product posture").
//
// `apple_music_url` is catalogue identity (it lives on `tracks`), and the Apple sweep now writes
// it onto CATALOGUE rows (a `tracks` row with no `findings` row) too. But a catalogue track is
// UNLIT — it renders in the unlit register, never named, never given a listen link (DESIGN.md's
// Unlit Rule; docs/album-entity.md's unnamed tier). So the rail is: a public component may render
// `apple_music_url` ONLY for a CERTIFIED finding. It is a STRUCTURAL guarantee, and this is the
// coverage test that keeps it structural rather than a thing a reviewer has to remember.
//
// Two nets, together closing the hole:
//   1. The UNLIT DTOs (`CatalogueTrackItem`, both the graph-page and the admin one) carry NO
//      `appleMusicUrl` field, and the SQL reads that build them select NO `apple_music_url`. A
//      component handed an uncertified row therefore CANNOT reach the URL — TypeScript forbids it.
//   2. Every `.tsx` that references `appleMusicUrl` is a certified-finding surface on the
//      allowlist below. A new public component that tried to render it for an uncertified row
//      would have to add the field to an unlit DTO (net 1 stops that) or appear here (net 2).

const SRC = fileURLToPath(new URL("../../", import.meta.url));

function read(relative: string): string {
  return readFileSync(join(SRC, relative), "utf8");
}

/** Every `.tsx` under `apps/web/src`, as repo-relative-ish paths from the src root. */
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

  it("the admin catalogue DTO (catalogue.ts CatalogueTrackItem) carries no appleMusicUrl", () => {
    const src = read("lib/server/catalogue.ts");
    const start = src.indexOf("export type CatalogueTrackItem");
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf("};", start));

    expect(block).not.toContain("appleMusicUrl");
    expect(block).not.toContain("apple_music_url");
  });

  it("the catalogue/unlit SQL reads never select apple_music_url", () => {
    // These are the reads that build the uncertified rows the public graph pages render. None of
    // them may pull `apple_music_url` — an unlit row ships no listen link over the wire.
    const tracks = read("lib/server/tracks.ts");
    const groups = read("lib/server/catalogue-groups.ts");
    const catalogue = read("lib/server/catalogue.ts");

    for (const fn of ["listCatalogueTracksByAlbum"]) {
      const start = tracks.indexOf(`export async function ${fn}`);
      expect(start, `${fn} should exist`).toBeGreaterThan(-1);
      const body = tracks.slice(start, tracks.indexOf("\n}", start));
      expect(body, `${fn} must not select apple_music_url`).not.toContain("apple_music_url");
    }

    // The grouped artist/label catalogue reads (catalogue-groups.ts) + the admin catalogue read
    // (catalogue.ts) build uncertified rows too — none selects the URL.
    expect(groups).not.toContain("apple_music_url");
    expect(catalogue).not.toContain("apple_music_url");
  });

  it("only certified-finding surfaces reference appleMusicUrl in the component tree", () => {
    // A public component may render the Apple listen link only for a CERTIFIED finding. The only
    // surface that does is the /log finding page. A new `.tsx` touching `appleMusicUrl` lands here
    // as a deliberate, reviewed addition — or the build fails.
    const ALLOWED = new Set(["routes/log.$logId.tsx"]);

    const offenders = tsxFiles().filter((file) => read(file).includes("appleMusicUrl"));

    expect(new Set(offenders)).toEqual(ALLOWED);
  });
});
