import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SERVER = fileURLToPath(new URL("./", import.meta.url));
const WEB = fileURLToPath(new URL("../../../", import.meta.url));

function serverSources(dir = SERVER, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      return serverSources(join(dir, entry.name), relative);
    }
    return entry.name.endsWith(".ts") && !entry.name.includes(".test.") ? [relative] : [];
  });
}

describe("mixable artist projection writer coverage", () => {
  it("keeps every production edge inserter on the maintained counter hook", () => {
    for (const relative of [
      "src/lib/server/artists.ts",
      "src/lib/server/backfill-artist-credits.ts",
      "src/lib/server/backfill-artist-edges.ts",
      "scripts/backfill-artist-links.ts",
    ]) {
      const source = readFileSync(join(WEB, relative), "utf8");
      expect(source).toMatch(/hubCountArtist(?:Delta|Edge)Statement/);
    }
  });

  it("pairs every guarded catalogue embedding clear with an exact artist repair", () => {
    const source = readFileSync(join(SERVER, "catalogue.ts"), "utf8");
    expect(source.match(/clearEmbeddingSatellite\(/g)?.length).toBe(3);
    expect(source.match(/repairRankableArtistsForTrackStatement\(/g)?.length).toBe(3);
  });

  it("covers the generic key/embedding writer and invalidates after mirror repair", () => {
    const update = readFileSync(join(SERVER, "track-update.ts"), "utf8");
    const backfill = readFileSync(join(WEB, "scripts/backfill-has-embedding.ts"), "utf8");
    expect(update).toContain("rankableArtistDeltaForTrackStatement");
    expect(backfill).toContain("MIXABLE_ARTISTS_PROJECTION_STATE_KEY");
    expect(backfill).toContain("dirty:has-embedding");
  });

  it("has no in-app artist or artist-edge delete path outside tests", () => {
    const offenders = serverSources().filter((relative) => {
      const source = readFileSync(join(SERVER, relative), "utf8");
      return /delete\s+from\s+(?:artists|track_artists)\b/i.test(source);
    });
    expect(offenders).toEqual([]);
  });
});
