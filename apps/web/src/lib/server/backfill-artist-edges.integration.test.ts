import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb, seedArtist, seedCatalogueTrack, seedTrack } from "./integration-db";

// THE GRAPH BACKFILL, PROVEN against the REAL schema on a real libSQL engine (RFC
// artist-primary-capture, slice 0). The claims on trial: it folds artists_json names onto EXISTING
// identities by exact fold AND via artist_aliases, MINTS NOTHING, writes the edges idempotently,
// stamps every visited track so the worklist drains, and reports the honest residual. Only a real
// engine can prove the `json_each`-free set matching + the anti-join worklist, so this is where.

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

vi.mock("./log", () => ({ logEvent: vi.fn() }));

const { resolveArtistEdges } = await import("./backfill-artist-edges");

const NOW = "2026-07-20T00:00:00.000Z";

/** Insert an artist alias directly (no seed helper) — the trusted AKA slice the matcher reads. */
async function seedAlias(
  client: Client,
  alias: string,
  artistId: string,
  status: "auto" | "confirmed" = "auto",
): Promise<void> {
  await client.execute({
    args: [`alias-${artistId}-${alias}`, artistId, alias, alias.toLowerCase(), status, NOW],
    sql: `insert into artist_aliases (id, artist_id, alias, alias_slug, kind, source, status, created_at)
          values (?, ?, ?, ?, 'name', 'musicbrainz', ?, ?)`,
  });
}

/** Read every (track_id, artist_id, position) edge, ordered — the graph the pass writes. */
async function edges(
  client: Client,
): Promise<Array<{ artist_id: string; position: number; track_id: string }>> {
  const result = await client.execute(
    `select track_id, artist_id, position from track_artists order by track_id, position`,
  );

  return result.rows as unknown as Array<{
    artist_id: string;
    position: number;
    track_id: string;
  }>;
}

beforeEach(async () => {
  db = await createIntegrationDb();
});

describe("resolveArtistEdges (integration)", () => {
  it("folds names + aliases onto existing identities, mints nothing, drains idempotently", async () => {
    await seedArtist(db, { id: "art-logi", name: "Logistics", slug: "logistics" });
    await seedArtist(db, { id: "art-nutone", name: "Nu:Tone", slug: "nu-tone" });
    await seedAlias(db, "DB", "art-logi"); // an AKA that folds onto Logistics

    // Fully matched by exact fold (case/punctuation-insensitive).
    await seedCatalogueTrack(db, {
      artists: ["logistics", "NU:TONE"],
      title: "Roller",
      trackId: "tFull",
    });
    // Partially matched — one real identity, one stranger.
    await seedCatalogueTrack(db, {
      artists: ["DB", "Some Unknown MC"],
      title: "Collab",
      trackId: "tPartial",
    });
    // Zero-match — no credited name is an existing identity.
    await seedCatalogueTrack(db, { artists: ["Nobody At All"], title: "Ghost", trackId: "tZero" });
    // A CERTIFIED finding that predates the graph — it, too, should earn its edge.
    await seedTrack(db, {
      artists: ["Logistics"],
      logId: "001.1.1A",
      title: "Certified",
      trackId: "tFinding",
    });

    const result = await resolveArtistEdges(200, false);

    // Classification is honest.
    expect(new Set(result.fullyMatched)).toEqual(new Set(["tFull", "tFinding"]));
    expect(result.partiallyMatched).toEqual(["tPartial"]);
    expect(result.zeroMatched).toEqual(["tZero"]);
    // "Some Unknown MC" + "Nobody At All" — the residual a future MB credit-sweep would mint from.
    expect(result.unmatchedNames).toBe(2);
    expect(result.scanned).toBe(4);

    // The edges landed — including the alias hit — with 1-based positions.
    expect(await edges(db)).toEqual([
      { artist_id: "art-logi", position: 1, track_id: "tFinding" },
      { artist_id: "art-logi", position: 1, track_id: "tFull" },
      { artist_id: "art-nutone", position: 2, track_id: "tFull" },
      { artist_id: "art-logi", position: 1, track_id: "tPartial" },
    ]);
    expect(result.edgesWritten).toBe(4);

    // It MINTED NOTHING — only the two seeded identities exist.
    const artistCount = await db.execute(`select count(*) as n from artists`);
    expect(Number(artistCount.rows[0]?.n)).toBe(2);

    // IDEMPOTENT: every track is stamped, so a second pass finds an empty worklist and writes nothing.
    const second = await resolveArtistEdges(200, false);
    expect(second.scanned).toBe(0);
    expect(second.edgesWritten).toBe(0);
    expect((await edges(db)).length).toBe(4);
  });

  it("a dry run classifies without writing an edge or a stamp", async () => {
    await seedArtist(db, { id: "art-logi", name: "Logistics", slug: "logistics" });
    await seedCatalogueTrack(db, { artists: ["Logistics"], title: "Roller", trackId: "tA" });

    const result = await resolveArtistEdges(200, true);

    expect(result.dryRun).toBe(true);
    expect(result.fullyMatched).toEqual(["tA"]);
    expect(result.edgesWritten).toBe(1); // what it WOULD write

    // Nothing was written — the worklist still holds the track on a real (wet) pass.
    expect((await edges(db)).length).toBe(0);
    const wet = await resolveArtistEdges(200, false);
    expect(wet.scanned).toBe(1);
  });

  it("skips a track that already has an edge (the anti-join worklist)", async () => {
    await seedArtist(db, { id: "art-logi", name: "Logistics", slug: "logistics" });
    await seedCatalogueTrack(db, { artists: ["Logistics"], title: "Linked", trackId: "tLinked" });
    await db.execute({
      args: ["tLinked", "art-logi"],
      sql: `insert into track_artists (track_id, artist_id, position) values (?, ?, 1)`,
    });

    const result = await resolveArtistEdges(200, false);

    // The already-linked track was never in the worklist.
    expect(result.scanned).toBe(0);
    expect((await edges(db)).length).toBe(1);
  });
});
