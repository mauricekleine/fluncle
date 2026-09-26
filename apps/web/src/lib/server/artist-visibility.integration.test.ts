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
import { listFollows } from "./account-data";
import { createIntegrationDb } from "./integration-db";
import { mentionHandlesFor } from "./mentions";
import {
  MIXABLE_ARTISTS_PROJECTION_COMPLETE_VALUE,
  MIXABLE_ARTISTS_PROJECTION_STATE_KEY,
} from "./mixable-artists-projection";
import { type PublicUser } from "./public-auth";
import { searchArchive } from "./search";
import { listMixableArtists } from "./tracks";

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

const TEST_USER = {
  createdAt: NOW,
  email: "listener@example.com",
  emailVerified: true,
  id: "user-1",
  name: "Listener",
} satisfies PublicUser;

async function seedWatchedArtists(): Promise<void> {
  for (const [id, artistId] of [
    ["watch-pop", "R_pop"],
    ["watch-dnb", "R_dnb"],
  ] as const) {
    await db.execute({
      args: [id, TEST_USER.id, artistId, NOW],
      sql: `insert into user_watches (id, user_id, kind, entity_id, created_at)
            values (?, ?, 'artist', ?, ?)`,
    });
  }
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

  it.each(["legacy", "projection"] as const)(
    "drops out of the /mix taste picker on the %s arm, by name and by slug",
    async (arm) => {
      await db.execute(`update artists set rankable_track_count = 3`);
      await db.execute(
        `update tracks set key = '5A', has_embedding = 1 where track_id in ('track-remix', 'track-dnb')`,
      );

      if (arm === "projection") {
        await db.execute({
          args: [MIXABLE_ARTISTS_PROJECTION_STATE_KEY, MIXABLE_ARTISTS_PROJECTION_COMPLETE_VALUE],
          sql: `insert into settings (key, value) values (?, ?)`,
        });
      }

      expect((await listMixableArtists()).map((artist) => artist.slug)).toEqual(["remixer"]);
      expect(await listMixableArtists({ q: "Pop" })).toEqual([]);
    },
  );

  it("carries no @handle into a social caption, because an @mention is a link", async () => {
    for (const artistId of ["R_pop", "R_dnb"]) {
      await db.execute({
        args: [`soc-${artistId}`, artistId, `https://www.tiktok.com/@${artistId}`, NOW, NOW],
        sql: `insert into artist_socials
                (id, artist_id, platform, url, source, status, created_at, updated_at)
              values (?, ?, 'tiktok', ?, 'operator', 'confirmed', ?, ?)`,
      });
    }

    expect(await mentionHandlesFor("track-remix", "tiktok")).toEqual([]);
    expect(await mentionHandlesFor("track-dnb", "tiktok")).toEqual(["@R_dnb"]);
  });

  it("drops out of a signed-in listener's watch list without touching the stored row", async () => {
    await seedWatchedArtists();

    expect((await listFollows(TEST_USER)).follows.map((watch) => watch.slug)).toEqual(["remixer"]);

    const stored = await db.execute(`select count(*) as n from user_watches`);
    expect(Number(stored.rows[0]?.n)).toBe(2);

    await db.execute(`delete from artist_rules where artist_mbid = '${UNLISTED_MBID}'`);
    expect((await listFollows(TEST_USER)).follows.map((watch) => watch.slug).sort()).toEqual([
      "pop-original",
      "remixer",
    ]);
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
