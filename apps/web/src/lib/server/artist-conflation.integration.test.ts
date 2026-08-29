import { type Client } from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { typedRows } from "./db";
import { createIntegrationDb, seedArtist, seedCatalogueTrack, seedTrack } from "./integration-db";

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
let fixtureDirectory: string | undefined;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

// Imported AFTER the mock so the module's `getDb` is the mocked one.
const { buildArtistLinkStatement, creditMbidTriples, linkTracksToArtistEntities } =
  await import("./artists");

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

/** The stored edge shape, including the duplicate-credit position choice. */
async function artistEdges(
  trackId: string,
): Promise<Array<{ artistId: string; position: number }>> {
  const result = await db.execute({
    args: [trackId],
    sql: `select artist_id, position
          from track_artists where track_id = ? order by artist_id`,
  });

  return typedRows<{ artist_id: string; position: bigint | number }>(result.rows).map((row) => ({
    artistId: row.artist_id,
    position: Number(row.position),
  }));
}

async function artistCounts(artistId: string): Promise<{ certified: number; renderable: number }> {
  const result = await db.execute({
    args: [artistId],
    sql: `select certified_finding_count, renderable_track_count
          from artists where id = ?`,
  });
  const row = typedRows<{
    certified_finding_count: bigint | number;
    renderable_track_count: bigint | number;
  }>(result.rows)[0];

  return {
    certified: Number(row?.certified_finding_count ?? 0),
    renderable: Number(row?.renderable_track_count ?? 0),
  };
}

async function rankCorpus(trackId: string): Promise<null | string> {
  const result = await db.execute({
    args: [trackId],
    sql: `select catalogue_rank_corpus from tracks where track_id = ?`,
  });
  const value = result.rows[0]?.["catalogue_rank_corpus"];

  return typeof value === "string" ? value : null;
}

beforeEach(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "fluncle-artist-link-"));
  db = await createIntegrationDb({ url: `file:${join(fixtureDirectory, "fixture.db")}` });
});

afterEach(async () => {
  db.close();

  if (fixtureDirectory) {
    await rm(fixtureDirectory, { force: true, recursive: true });
    fixtureDirectory = undefined;
  }
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
  type CollisionFixture = {
    artists: Array<{ id: string; mbid: null | string; name: string; slug: string }>;
    credit: null | string;
    creditSource: "map" | "missing-map" | "no-map";
    expected: string[];
    name: string;
    trackArtist: string;
  };

  const collisionFixtures: CollisionFixture[] = [
    {
      artists: [{ id: "art-exact", mbid: MB_DNB, name: "K", slug: "k" }],
      credit: MB_DNB,
      creditSource: "map",
      expected: ["art-exact"],
      name: "exact MBID wins despite name drift",
      trackArtist: "K.",
    },
    {
      artists: [
        { id: "art-exact", mbid: MB_DNB, name: "Elsewhere", slug: "elsewhere" },
        { id: "art-open", mbid: null, name: "K", slug: "k" },
        { id: "art-other", mbid: MB_JPOP, name: "K", slug: "k-2" },
      ],
      credit: MB_DNB,
      creditSource: "map",
      expected: ["art-exact"],
      name: "claimed MBID suppresses every same-name fallback",
      trackArtist: "K",
    },
    {
      artists: [
        { id: "art-open", mbid: null, name: "Luna", slug: "luna" },
        { id: "art-other", mbid: MB_DNB, name: "Luna", slug: "luna-2" },
      ],
      credit: MB_JPOP,
      creditSource: "map",
      expected: ["art-open"],
      name: "an unclaimed row is the only identified-credit name fallback",
      trackArtist: "lUnA",
    },
    {
      artists: [{ id: "art-other", mbid: MB_DNB, name: "Luna", slug: "luna" }],
      credit: MB_JPOP,
      creditSource: "map",
      expected: [],
      name: "another MBID blocks name fallback completely",
      trackArtist: "LUNA",
    },
    {
      artists: [
        { id: "art-exact-a", mbid: MB_DNB, name: "K", slug: "k" },
        { id: "art-exact-b", mbid: MB_DNB, name: "Kay", slug: "kay" },
      ],
      credit: MB_DNB,
      creditSource: "map",
      expected: ["art-exact-a", "art-exact-b"],
      name: "the deliberately non-unique MBID index preserves duplicate identity rows",
      trackArtist: "Unrelated spelling",
    },
    {
      artists: [
        { id: "art-dnb", mbid: MB_DNB, name: "K", slug: "k" },
        { id: "art-jpop", mbid: MB_JPOP, name: "K", slug: "k-2" },
        { id: "art-open", mbid: null, name: "K", slug: "k-3" },
      ],
      credit: null,
      creditSource: "map",
      expected: ["art-dnb", "art-jpop", "art-open"],
      name: "a null credit keeps the historical name-only fan-out",
      trackArtist: "k",
    },
    {
      artists: [
        { id: "art-dnb", mbid: MB_DNB, name: "K", slug: "k" },
        { id: "art-open", mbid: null, name: "K", slug: "k-2" },
      ],
      credit: null,
      creditSource: "no-map",
      expected: ["art-dnb", "art-open"],
      name: "an absent map keeps the historical name-only fan-out",
      trackArtist: "K",
    },
    {
      artists: [
        { id: "art-jpop", mbid: MB_JPOP, name: "K", slug: "k" },
        { id: "art-open", mbid: null, name: "K", slug: "k-2" },
      ],
      credit: null,
      creditSource: "missing-map",
      expected: ["art-jpop", "art-open"],
      name: "a map with no row for the track is also name-only",
      trackArtist: "K",
    },
  ];

  it.each(collisionFixtures)("collision matrix: $name", async (fixture) => {
    const trackId = "t-collision-0000000001";

    for (const artist of fixture.artists) {
      await seedIdentifiedArtist(artist, artist.mbid);
    }

    await seedCatalogueTrack(db, { artists: [fixture.trackArtist], trackId });

    let written: number;

    if (fixture.creditSource === "no-map") {
      written = await linkTracksToArtistEntities([trackId]);
    } else if (fixture.creditSource === "missing-map") {
      written = await linkTracksToArtistEntities([trackId], new Map());
    } else {
      written = await linkTracksToArtistEntities([trackId], new Map([[trackId, [fixture.credit]]]));
    }

    expect(written).toBe(fixture.expected.length);
    expect(await edgedArtists(trackId)).toEqual(fixture.expected);
  });

  it("expands requested credits once and keeps the MBID/name branches independently sargable", async () => {
    const statement = buildArtistLinkStatement(
      ["t-plan-0000000000001"],
      new Map([["t-plan-0000000000001", [MB_DNB, null]]]),
    );
    const expansionCount = statement.sql.match(/json_each\(tracks\.artists_json\)/giu)?.length ?? 0;
    const artistJoinPredicates = [
      ...statement.sql.matchAll(
        /join\s+artists\s+\w+(?:\s+indexed\s+by\s+\w+)?\s+on\s+([\s\S]*?)(?=\n\s*(?:where|union all|join|left join|group by))/giu,
      ),
    ].map((match) => match[1] ?? "");

    expect(expansionCount).toBe(1);
    expect(artistJoinPredicates).toHaveLength(3);

    for (const predicate of artistJoinPredicates) {
      expect(predicate).not.toMatch(/\b(?:case|or)\b/iu);
    }

    const explained = await db.execute({
      args: statement.args,
      sql: `explain query plan ${statement.sql}`,
    });
    const details = typedRows<{ detail: string }>(explained.rows).map((row) =>
      row.detail.toLowerCase(),
    );

    // SQLite changes SEARCH/SCAN phrasing across releases; the stable contract is that both named
    // indexes participate and neither an artist branch nor the claimed-MBID anti-join scans.
    expect(details.some((detail) => detail.includes("artists_mbid_idx"))).toBe(true);
    expect(details.some((detail) => detail.includes("artists_name_nocase_idx"))).toBe(true);
    expect(
      details.filter(
        (detail) =>
          /\bscan\s+(?:table\s+)?(?:artist|claimed)\b/iu.test(detail) &&
          !detail.includes("using index"),
      ),
    ).toEqual([]);
    expect(details.filter((detail) => detail.includes("use temp b-tree"))).toEqual([]);
  });

  it("libSQL RETURNING reports only accepted edges and carries is_catalogue", async () => {
    const trackId = "t-returning-000000001";
    await seedIdentifiedArtist({ id: "art-returning", name: "Luna", slug: "luna" }, null);
    await seedCatalogueTrack(db, { artists: ["Luna"], trackId });
    const statement = buildArtistLinkStatement([trackId]);

    const first = await db.execute(statement);
    const duplicate = await db.execute(statement);

    expect(
      typedRows<{
        artist_id: string;
        is_catalogue: bigint | number;
        is_rankable: bigint | number;
        track_id: string;
      }>(first.rows),
    ).toEqual([{ artist_id: "art-returning", is_catalogue: 1, is_rankable: 0, track_id: trackId }]);
    expect(duplicate.rows).toHaveLength(0);
  });

  it("folds duplicate credits to the first position while preserving the other credited artist", async () => {
    const trackId = "t-credit-positions-0001";
    await seedIdentifiedArtist({ id: "art-k", name: "K", slug: "k" }, MB_DNB);
    await seedIdentifiedArtist({ id: "art-luna", name: "Luna", slug: "luna" }, null);
    await seedCatalogueTrack(db, { artists: ["K", "Luna", "K"], trackId });

    const written = await linkTracksToArtistEntities(
      [trackId],
      new Map([[trackId, [MB_DNB, null, MB_DNB]]]),
    );

    expect(written).toBe(2);
    expect(await artistEdges(trackId)).toEqual([
      { artistId: "art-k", position: 1 },
      { artistId: "art-luna", position: 2 },
    ]);
  });

  it("derives count and re-stale effects only from returned new edges", async () => {
    const certifiedId = "t-cert-effects-0000001";
    const catalogueId = "t-cat-effects-00000001";
    const unmatchedId = "t-unmatched-effects-001";
    await seedIdentifiedArtist({ id: "art-effects", name: "Luna", slug: "luna" }, null);
    await seedTrack(db, { artists: ["Luna"], logId: "123.4.5A", trackId: certifiedId });
    await seedCatalogueTrack(db, { artists: ["Luna"], trackId: catalogueId });
    await seedCatalogueTrack(db, { artists: ["Unknown"], trackId: unmatchedId });
    await db.execute({
      args: [certifiedId, catalogueId, unmatchedId],
      sql: `update tracks set catalogue_rank_corpus = 'fresh'
            where track_id in (?, ?, ?)`,
    });

    expect(await linkTracksToArtistEntities([certifiedId, catalogueId, unmatchedId])).toBe(2);
    expect(await artistCounts("art-effects")).toEqual({ certified: 1, renderable: 2 });
    expect(await rankCorpus(certifiedId)).toBeNull();
    expect(await rankCorpus(catalogueId)).toBeNull();
    expect(await rankCorpus(unmatchedId)).toBe("fresh");

    await db.execute({
      args: [catalogueId],
      sql: `update tracks set catalogue_rank_corpus = 'reranked' where track_id = ?`,
    });

    expect(await linkTracksToArtistEntities([certifiedId, catalogueId])).toBe(0);
    expect(await artistCounts("art-effects")).toEqual({ certified: 1, renderable: 2 });
    expect(await rankCorpus(catalogueId)).toBe("reranked");
  });

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
