import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { typedRows } from "./db";
import { createIntegrationDb, seedArtist, seedCatalogueTrack } from "./integration-db";

// THE HOMONYM SEAL, PROVEN AGAINST THE REAL MIGRATED SCHEMA (lib/server/artists.ts).
//
// THE BUG IT CLOSES. `linkTracksToArtistEntities` joined `artists a on a.name = credit.value
// collate nocase` — a bare NAME, no identity. Two real-world acts sharing a name therefore landed
// on ONE Fluncle `artists` row, and the impostor's tracks rendered on the real act's public page.
// Across the six namesake-walked labels: 225 impostor-side edges, of
// which 181 were written by THIS name join, 29 by slice 0's punctuation fold, and 15 by the
// mbid-keyed credit sweep — which refuses homonyms by construction and so wrote only genuine
// crossovers. The crawler had each credit's MB artist id in hand the whole time and dropped it.
//
// The rung order under test is `backfill-artist-credits.ts`'s ratified ladder: the mbid row wins;
// an unclaimed row may still be claimed by name; a row holding a DIFFERENT mbid is a homonym and
// gets NO edge, because a wrong artist merge is unrecoverable and a missing edge is not.

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

// Imported AFTER the mock so the module's `getDb` is the mocked one.
const { creditMbidTriples, linkTracksToArtistEntities } = await import("./artists");

const MB_DNB = "b78f09e9-3abb-4fd0-b809-4a1138c478b2";
const MB_JPOP = "1a7b4a25-197a-4ab3-acc9-f4afd6dcacdd";

/** Seed an artist and claim an MB identity for it (the seeder writes identity-free rows). */
async function seedIdentifiedArtist(
  artist: { id: string; name: string; slug: string },
  mbid: null | string,
): Promise<void> {
  await seedArtist(db, artist);

  if (mbid) {
    await db.execute({ args: [mbid, artist.id], sql: `update artists set mbid = ? where id = ?` });
  }
}

/** The artist ids edged to a track, so a refusal reads as an empty list rather than a count. */
async function edgedArtists(trackId: string): Promise<string[]> {
  const result = await db.execute({
    args: [trackId],
    sql: `select artist_id from track_artists where track_id = ? order by artist_id`,
  });

  return typedRows<{ artist_id: string }>(result.rows).map((row) => row.artist_id);
}

beforeEach(async () => {
  db = await createIntegrationDb();
});

describe("creditMbidTriples", () => {
  it("emits one (track, 1-based position, mbid) triple per IDENTIFIED credit only", () => {
    const triples = creditMbidTriples(
      ["t-a", "t-b"],
      new Map([
        ["t-a", [MB_DNB, null, MB_JPOP]],
        ["t-b", [null]],
      ]),
    );

    expect(triples).toEqual([
      ["t-a", 1, MB_DNB],
      ["t-a", 3, MB_JPOP],
    ]);
  });

  it("a track the caller said nothing about contributes nothing", () => {
    expect(creditMbidTriples(["t-a", "t-unknown"], new Map([["t-a", [MB_DNB]]]))).toEqual([
      ["t-a", 1, MB_DNB],
    ]);
  });
});

describe("linkTracksToArtistEntities — the homonym seal", () => {
  it("REFUSES the edge when the credit's mbid differs from the same-named row's", async () => {
    // The live shape: Fluncle holds the drum & bass `K`; the crawler brings a J-pop act also
    // credited `K`, carrying its own MusicBrainz identity.
    await seedIdentifiedArtist({ id: "art-k-dnb", name: "K", slug: "k" }, MB_DNB);
    await seedCatalogueTrack(db, { artists: ["K"], trackId: "t-cat-jpop-000000001" });

    const written = await linkTracksToArtistEntities(
      ["t-cat-jpop-000000001"],
      new Map([["t-cat-jpop-000000001", [MB_JPOP]]]),
    );

    expect(written).toBe(0);
    expect(await edgedArtists("t-cat-jpop-000000001")).toEqual([]);
  });

  it("LINKS by mbid when the identity matches, whatever the row is named", async () => {
    // The stored name drifted (`K` vs the credit's `K.`); identity is what decides, not spelling.
    await seedIdentifiedArtist({ id: "art-k-dnb", name: "K", slug: "k" }, MB_DNB);
    await seedCatalogueTrack(db, { artists: ["K."], trackId: "t-cat-dnb-0000000001" });

    const written = await linkTracksToArtistEntities(
      ["t-cat-dnb-0000000001"],
      new Map([["t-cat-dnb-0000000001", [MB_DNB]]]),
    );

    expect(written).toBe(1);
    expect(await edgedArtists("t-cat-dnb-0000000001")).toEqual(["art-k-dnb"]);
  });

  it("lets the name fold claim a row that has NOT claimed an identity yet", async () => {
    await seedIdentifiedArtist({ id: "art-open", name: "Luna", slug: "luna" }, null);
    await seedCatalogueTrack(db, { artists: ["Luna"], trackId: "t-cat-open-000000001" });

    const written = await linkTracksToArtistEntities(
      ["t-cat-open-000000001"],
      new Map([["t-cat-open-000000001", [MB_JPOP]]]),
    );

    expect(written).toBe(1);
    expect(await edgedArtists("t-cat-open-000000001")).toEqual(["art-open"]);
  });

  it("prefers the mbid row and does NOT also claim a same-named unclaimed row", async () => {
    // Both rows answer to the name; only one answers to the identity. Linking both would be the
    // conflation in a different costume.
    await seedIdentifiedArtist({ id: "art-k-dnb", name: "K", slug: "k" }, MB_DNB);
    await seedIdentifiedArtist({ id: "art-k-open", name: "K", slug: "k-2" }, null);
    await seedCatalogueTrack(db, { artists: ["K"], trackId: "t-cat-dnb-0000000002" });

    await linkTracksToArtistEntities(
      ["t-cat-dnb-0000000002"],
      new Map([["t-cat-dnb-0000000002", [MB_DNB]]]),
    );

    expect(await edgedArtists("t-cat-dnb-0000000002")).toEqual(["art-k-dnb"]);
  });

  it("a credit with NO mbid keeps the historical name fold", async () => {
    await seedIdentifiedArtist({ id: "art-k-dnb", name: "K", slug: "k" }, MB_DNB);
    await seedCatalogueTrack(db, { artists: ["K"], trackId: "t-cat-noid-000000001" });

    const written = await linkTracksToArtistEntities(
      ["t-cat-noid-000000001"],
      new Map([["t-cat-noid-000000001", [null]]]),
    );

    expect(written).toBe(1);
    expect(await edgedArtists("t-cat-noid-000000001")).toEqual(["art-k-dnb"]);
  });

  it("passing no map at all is byte-identical to the historical behaviour", async () => {
    // The Spotify-sourced freshness tap has no MB ids to give and must not change.
    await seedIdentifiedArtist({ id: "art-k-dnb", name: "K", slug: "k" }, MB_DNB);
    await seedCatalogueTrack(db, { artists: ["K"], trackId: "t-cat-tap-0000000001" });

    expect(await linkTracksToArtistEntities(["t-cat-tap-0000000001"])).toBe(1);
    expect(await edgedArtists("t-cat-tap-0000000001")).toEqual(["art-k-dnb"]);
  });

  it("seals ONE credit of a track without dropping the other", async () => {
    // A collaboration where one credit is a homonym and the other is genuine: the genuine edge
    // must still land, so a refusal never costs the track its real artist.
    await seedIdentifiedArtist({ id: "art-k-dnb", name: "K", slug: "k" }, MB_DNB);
    await seedIdentifiedArtist({ id: "art-open", name: "Luna", slug: "luna" }, null);
    await seedCatalogueTrack(db, { artists: ["K", "Luna"], trackId: "t-cat-mixed-00000001" });

    await linkTracksToArtistEntities(
      ["t-cat-mixed-00000001"],
      new Map([["t-cat-mixed-00000001", [MB_JPOP, null]]]),
    );

    expect(await edgedArtists("t-cat-mixed-00000001")).toEqual(["art-open"]);
  });

  it("is idempotent — a re-run over a sealed batch still writes nothing", async () => {
    await seedIdentifiedArtist({ id: "art-k-dnb", name: "K", slug: "k" }, MB_DNB);
    await seedCatalogueTrack(db, { artists: ["K"], trackId: "t-cat-dnb-0000000003" });
    const credits = new Map([["t-cat-dnb-0000000003", [MB_DNB]]]);

    await linkTracksToArtistEntities(["t-cat-dnb-0000000003"], credits);

    expect(await linkTracksToArtistEntities(["t-cat-dnb-0000000003"], credits)).toBe(0);
    expect(await edgedArtists("t-cat-dnb-0000000003")).toEqual(["art-k-dnb"]);
  });
});
