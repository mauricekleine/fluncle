import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// THE CERTIFICATION RAIL FOR apple_music_url (RFC musickit U1, "Product posture").
//
// `apple_music_url` is catalogue identity (it lives on `tracks`), and the Apple sweep now writes
// it onto CATALOGUE rows (a `tracks` row with no `findings` row) too. But on a PUBLIC surface a
// catalogue track is UNLIT — it renders in the unlit register, never named, never given a listen
// link (DESIGN.md's Unlit Rule; docs/album-entity.md's unnamed tier). So the rail is: a PUBLIC
// component may render `apple_music_url` ONLY for a CERTIFIED finding. It is a STRUCTURAL
// guarantee, and this is the coverage test that keeps it structural rather than a thing a reviewer
// has to remember.
//
// THE ADMIN CATALOGUE (`/admin/catalogue`, The Ear) is exempt, and deliberately so: it is the
// operator's workstation, not a public unlit surface, and its whole job is to help him decide
// whether to log a track — so it carries per-row full-listen links (Spotify AND its Apple twin,
// docs/the-ear.md § The operator's actions). The Unlit Rule governs what the CREW sees, never the
// operator's own tools (the persona law, docs/admin-shell.md). So the admin catalogue DTO
// (catalogue.ts) and its route are excluded below; the PUBLIC graph-page reads stay guarded.
//
// Two nets, together closing the hole for the PUBLIC surfaces:
//   1. The public graph-page unlit DTO (`tracks.ts` CatalogueTrackItem) carries NO `appleMusicUrl`
//      field, and the public unlit SQL reads that build the graph rows select NO `apple_music_url`.
//      A public component handed an uncertified row therefore CANNOT reach the URL.
//   2. Every `.tsx` that references `appleMusicUrl` is a certified-finding surface — or the admin
//      operator catalogue — on the allowlist below. A new PUBLIC component that tried to render it
//      for an uncertified row would have to add the field to the unlit DTO (net 1) or appear here.

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

  it("the PUBLIC unlit SQL reads never select apple_music_url", () => {
    // These are the reads that build the uncertified rows the PUBLIC graph pages render. None of
    // them may pull `apple_music_url` — an unlit public row ships no listen link over the wire. The
    // ADMIN catalogue read (catalogue.ts) is NOT here: it is the operator's workstation, not a
    // public unlit surface, and it carries the Apple twin of the Spotify link it already shows.
    const tracks = read("lib/server/tracks.ts");
    const groups = read("lib/server/catalogue-groups.ts");

    for (const fn of ["listCatalogueTracksByAlbum"]) {
      const start = tracks.indexOf(`export async function ${fn}`);
      expect(start, `${fn} should exist`).toBeGreaterThan(-1);
      const body = tracks.slice(start, tracks.indexOf("\n}", start));
      expect(body, `${fn} must not select apple_music_url`).not.toContain("apple_music_url");
    }

    // The grouped artist/label catalogue reads (catalogue-groups.ts) build uncertified PUBLIC rows.
    expect(groups).not.toContain("apple_music_url");
  });

  it("the PUBLIC graph-page unlit DTO (tracks.ts CatalogueTrackItem) carries no appleMusicUrl", () => {
    const src = read("lib/server/tracks.ts");
    const start = src.indexOf("export type CatalogueTrackItem");
    expect(start, "the unlit DTO type should exist").toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf("};", start));

    expect(block).not.toContain("appleMusicUrl");
    expect(block).not.toContain("apple_music_url");
  });

  it("only certified-finding surfaces + the admin catalogue + /mix reference appleMusicUrl in the component tree", () => {
    // A PUBLIC component may render the Apple listen link only for a CERTIFIED finding — the /log
    // finding page. The ADMIN catalogue (The Ear) is one non-finding surface allowed it: it is the
    // operator's workstation, where a full-listen link is the point (docs/the-ear.md § The
    // operator's actions), not a public unlit row. The OTHER is `/mix`'s set-builder: it is the one
    // public surface whose UNLIT row deliberately links OUT (there is no /log page to send you to,
    // so it offers the place the track CAN be heard — the Spotify anchor, and now its Apple twin;
    // MixTrackSchema + mix-builder.tsx document this exception to the graph pages' Unlit Rule). A
    // new `.tsx` touching `appleMusicUrl` lands here as a deliberate, reviewed addition — or the
    // build fails.
    const ALLOWED = new Set([
      "components/mix/mix-builder.tsx",
      "routes/admin/catalogue.tsx",
      "routes/log.$logId.tsx",
    ]);

    const offenders = tsxFiles().filter((file) => read(file).includes("appleMusicUrl"));

    expect(new Set(offenders)).toEqual(ALLOWED);
  });
});
