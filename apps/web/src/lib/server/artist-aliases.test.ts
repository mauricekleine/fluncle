// Artist aliases (the MusicBrainz identity layer): the pure MB-alias harvest + the upsert
// idempotence against a real in-memory libSQL engine. `getDb` is mocked to the per-test client.
import { type Client, createClient } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => holder.db };
});

import { extractAliasesFromArtistData, persistResolution } from "./artist-resolution";

describe("extractAliasesFromArtistData (the MB alias harvest)", () => {
  it("harvests display names, skips the canonical name, dedupes by slug, and splits search hints", () => {
    const aliases = extractAliasesFromArtistData(
      {
        aliases: [
          { name: "Nu:Tone", type: "Artist name" }, // == canonical (folds to the same slug) → skipped
          { name: "Nutone", type: "Artist name" },
          { name: "Daniel Trigg", type: "Legal name" },
          { name: "Nutone DnB", type: "Search hint" }, // a search hint → kind 'hint'
          { name: "  Nutone  ", type: "Artist name" }, // dupe by slug → skipped
          { name: "   ", type: "Artist name" }, // empty → skipped
        ],
      },
      "Nu:Tone",
    );

    expect(aliases).toEqual([
      { alias: "Nutone", kind: "name", slug: "nutone" },
      { alias: "Daniel Trigg", kind: "name", slug: "daniel-trigg" },
      { alias: "Nutone DnB", kind: "hint", slug: "nutone-dnb" },
    ]);
  });

  it("returns an empty array when MB carried no aliases", () => {
    expect(extractAliasesFromArtistData({}, "Anyone")).toEqual([]);
  });
});

describe("persistResolution — MB aliases are upserted idempotently", () => {
  let db: Client;

  beforeEach(async () => {
    db = createClient({ url: ":memory:" });
    holder.db = db;

    await db.execute(
      `create table artists (id text primary key, mbid text, wikidata_qid text, resolved_at text, updated_at text)`,
    );
    await db.execute(
      `create table artist_socials (id text primary key, artist_id text, platform text, url text,
        source text, status text, reviewed_at text, created_at text, updated_at text, unique(artist_id, platform))`,
    );
    await db.execute(
      `create table artist_aliases (id text primary key, artist_id text, alias text, alias_slug text,
        source text, kind text, status text, created_at text, unique(artist_id, alias_slug, source))`,
    );
    await db.execute({ args: ["a1"], sql: `insert into artists (id) values (?)` });
  });

  async function readAliases(): Promise<Array<{ alias: string; status: string }>> {
    const result = await db.execute({
      args: ["a1"],
      sql: `select alias, status from artist_aliases where artist_id = ? order by alias_slug`,
    });

    return result.rows as unknown as Array<{ alias: string; status: string }>;
  }

  it("writes MB aliases as source=musicbrainz, status=auto", async () => {
    await persistResolution(
      "a1",
      "mb1",
      null,
      [],
      "auto",
      [],
      [{ alias: "Nutone", kind: "name", slug: "nutone" }],
    );

    const rows = await readAliases();
    expect(rows).toEqual([{ alias: "Nutone", status: "auto" }]);
  });

  it("a second resolve of the same alias is a no-op (on conflict do nothing)", async () => {
    const alias = { alias: "Nutone", kind: "name" as const, slug: "nutone" };

    await persistResolution("a1", "mb1", null, [], "auto", [], [alias]);
    await persistResolution("a1", "mb1", null, [], "auto", [], [alias]);

    expect(await readAliases()).toHaveLength(1);
  });

  it("never reverts an operator-CONFIRMED alias back to auto on a re-resolve", async () => {
    // The operator ruled an alias confirmed; the (artist, slug, source) key differs by source, so
    // an MB row would coexist — but the SAME-source MB re-write is `do nothing`, so a confirmed
    // operator row is never touched. Seed an operator-confirmed row, then re-resolve.
    await db.execute({
      args: ["op1", "a1", "Nutone", "nutone", "operator", "name", "confirmed", "t0"],
      sql: `insert into artist_aliases (id, artist_id, alias, alias_slug, source, kind, status, created_at)
            values (?, ?, ?, ?, ?, ?, ?, ?)`,
    });

    await persistResolution(
      "a1",
      "mb1",
      null,
      [],
      "auto",
      [],
      [{ alias: "Nutone", kind: "name", slug: "nutone" }],
    );

    const result = await db.execute({
      args: ["a1"],
      sql: `select source, status from artist_aliases where artist_id = ? order by source`,
    });
    // The operator's confirmed row survives; the MB row lands alongside it (different source key).
    expect(result.rows).toEqual([
      { source: "musicbrainz", status: "auto" },
      { source: "operator", status: "confirmed" },
    ]);
  });
});
