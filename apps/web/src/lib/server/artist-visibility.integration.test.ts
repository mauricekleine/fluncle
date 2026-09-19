// THE UNLISTED ARTIST, PROVEN — a global `unlisted` rule is a VISIBILITY ruling and nothing else.
//
// The shape it exists for: MusicBrainz bills a remix to the ORIGINAL artist, so a drum & bass remix
// of a pop song mints an artist entity for the pop act. The remix belongs in the archive; the pop
// act does not get a page. Every case below is one public surface reading the rule at request time,
// against a world where the artist's rows, edges and counters are all intact — because they are.
//
// The rule is never stamped on the `artists` row, so the last case is the whole argument for that
// design: deleting the rule restores every surface at once, with no backfill.

import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));
const translateQuery = vi.hoisted(() => vi.fn<(q: string) => Promise<unknown>>());

vi.mock("./search-llm", () => ({ translateQuery }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => holder.db };
});

import {
  ARTIST_INDEX_MIN_FINDINGS,
  countIndexableArtists,
  getArtistBySlug,
  getArtistListItemBySlug,
  getArtistSlugMap,
  getPublicArtistBySlug,
  listArtistsByLabel,
  listArtistsHubPage,
  listArtistsMissingBio,
  listArtistSitemapRows,
} from "./artists";
import { createIntegrationDb } from "./integration-db";
import { searchArchive } from "./search";

const NOW = "2026-07-01T00:00:00.000Z";
const UNLISTED_MBID = "11111111-1111-4111-8111-111111111111";

let db: Client;

async function seedArtist(options: {
  id: string;
  mbid?: null | string;
  name: string;
  slug: string;
}): Promise<void> {
  await db.execute({
    args: [
      options.id,
      options.name,
      options.slug,
      options.mbid ?? null,
      ARTIST_INDEX_MIN_FINDINGS,
      1,
      NOW,
      NOW,
    ],
    sql: `insert into artists
            (id, name, slug, mbid, renderable_track_count, certified_finding_count,
             created_at, updated_at)
          values (?, ?, ?, ?, ?, ?, ?, ?)`,
  });
}

/** One CERTIFIED track credited to an artist — the row a sitemap entry and a credit both need. */
async function seedFinding(options: {
  artistId: string;
  labelId: string;
  logId: string;
  trackId: string;
}): Promise<void> {
  await db.execute({
    args: [options.trackId, `Title ${options.trackId}`, options.labelId],
    sql: `insert into tracks
            (track_id, title, artists_json, duration_ms, album_image_url, label_id, is_catalogue)
          values (?, ?, '["Pop Original"]', 270000, 'https://example.com/cover.jpg', ?, 0)`,
  });
  await db.execute({
    args: [options.trackId, options.artistId],
    sql: `insert into track_artists (track_id, artist_id, position) values (?, ?, 0)`,
  });
  await db.execute({
    args: [options.trackId, options.logId, NOW],
    sql: `insert into findings (track_id, log_id, added_at) values (?, ?, ?)`,
  });
}

async function ruleUnlisted(artistMbid: string): Promise<void> {
  await db.execute({
    args: [`arl_${artistMbid}`, artistMbid, "Pop Original", NOW, NOW],
    sql: `insert into artist_rules
            (id, artist_mbid, artist_name, verdict, label_id, source, created_at, updated_at)
          values (?, ?, ?, 'unlisted', null, 'operator', ?, ?)`,
  });
}

beforeEach(async () => {
  db = await createIntegrationDb();
  holder.db = db;
  translateQuery.mockReset();
  translateQuery.mockResolvedValue(null);

  await db.execute({
    args: ["L_hospital", "Hospital Records", "hospital-records", NOW, NOW],
    sql: `insert into labels (id, name, slug, seed_state, created_at, updated_at)
          values (?, ?, ?, 'enabled', ?, ?)`,
  });
  await seedArtist({
    id: "R_pop",
    mbid: UNLISTED_MBID,
    name: "Pop Original",
    slug: "pop-original",
  });
  await seedArtist({ id: "R_dnb", mbid: null, name: "Remixer", slug: "remixer" });
  await seedFinding({
    artistId: "R_pop",
    labelId: "L_hospital",
    logId: "001.A.01",
    trackId: "track-remix",
  });
  await seedFinding({
    artistId: "R_dnb",
    labelId: "L_hospital",
    logId: "001.A.02",
    trackId: "track-dnb",
  });
});

describe("before the ruling, the pop act is an ordinary public artist", () => {
  it("resolves, lists, and enters the sitemap like any other", async () => {
    expect(await getPublicArtistBySlug("pop-original")).toMatchObject({ slug: "pop-original" });
    expect((await listArtistsHubPage(1)).items.map((item) => item.slug)).toEqual([
      "pop-original",
      "remixer",
    ]);
    expect((await listArtistSitemapRows(ARTIST_INDEX_MIN_FINDINGS)).map((row) => row.slug)).toEqual(
      ["pop-original", "remixer"],
    );
  });
});

describe("a global unlisted rule takes the artist's PAGE off the site", () => {
  beforeEach(() => ruleUnlisted(UNLISTED_MBID));

  it("resolves to nothing, so `/artist/<slug>` 404s down the missing-row path", async () => {
    expect(await getPublicArtistBySlug("pop-original")).toBeUndefined();
    expect(await getArtistListItemBySlug("pop-original")).toBeUndefined();
  });

  it("still resolves for the OPERATOR, who has to be able to see what he ruled on", async () => {
    expect(await getArtistBySlug("pop-original")).toMatchObject({ slug: "pop-original" });
  });

  it("drops out of the `/artists` hub, its total, and its A–Z lane", async () => {
    const page = await listArtistsHubPage(1);

    expect(page.items.map((item) => item.slug)).toEqual(["remixer"]);
    expect(page.total).toBe(1);
    expect(page.pageCount).toBe(1);
    expect(page.letters?.map((letter) => letter.letter)).toEqual(["r"]);
  });

  it("drops out of the name-filtered hub read too, so search-by-name cannot reach it", async () => {
    const page = await listArtistsHubPage(1, "Pop");

    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
  });

  it("drops out of the sitemap rows and the indexable-page count together", async () => {
    expect((await listArtistSitemapRows(ARTIST_INDEX_MIN_FINDINGS)).map((row) => row.slug)).toEqual(
      ["remixer"],
    );
    expect(await countIndexableArtists()).toBe(1);
  });

  it("drops out of search's exact-entity tier", async () => {
    expect((await searchArchive({ q: "Pop Original" })).entities).toEqual([]);
    expect((await searchArchive({ q: "Remixer" })).entities).toMatchObject([
      { kind: "artist", slug: "remixer" },
    ]);
  });

  it("drops out of a label page's artist chips, because a chip IS a link", async () => {
    expect((await listArtistsByLabel("L_hospital")).map((chip) => chip.slug)).toEqual(["remixer"]);
  });

  it("drops out of the track's credit slug map, so the credit renders as PLAIN TEXT", async () => {
    // The remix is untouched: the row, its finding and its `track_artists` edge all stand. What is
    // gone is the slug the page turns into a link and the JSON-LD turns into an `@id`.
    expect(await getArtistSlugMap("track-remix")).toEqual({});
    expect(await getArtistSlugMap("track-dnb")).toEqual({ remixer: "remixer" });

    const stored = await db.execute(
      "select count(*) as n from tracks where track_id = 'track-remix'",
    );
    expect(Number(stored.rows[0]?.n)).toBe(1);
  });

  it("drops out of the bio worklist, since there is no page to author a bio for", async () => {
    expect((await listArtistsMissingBio(10)).map((item) => item.slug)).toEqual(["remixer"]);
  });
});

describe("removing the rule restores the page with no backfill", () => {
  it("flips every surface back, because visibility was never stamped on the row", async () => {
    await ruleUnlisted(UNLISTED_MBID);
    expect(await getPublicArtistBySlug("pop-original")).toBeUndefined();

    await db.execute(`delete from artist_rules where artist_mbid = '${UNLISTED_MBID}'`);

    expect(await getPublicArtistBySlug("pop-original")).toMatchObject({ slug: "pop-original" });
    expect((await listArtistsHubPage(1)).items.map((item) => item.slug)).toEqual([
      "pop-original",
      "remixer",
    ]);
    expect((await listArtistSitemapRows(ARTIST_INDEX_MIN_FINDINGS)).map((row) => row.slug)).toEqual(
      ["pop-original", "remixer"],
    );
    expect(await getArtistSlugMap("track-remix")).toEqual({ "pop original": "pop-original" });
  });
});

describe("an artist with no MusicBrainz identity can carry no rule", () => {
  it("stays public while an unrelated identity is unlisted", async () => {
    await ruleUnlisted(UNLISTED_MBID);

    expect(await getPublicArtistBySlug("remixer")).toMatchObject({ slug: "remixer" });
  });
});
