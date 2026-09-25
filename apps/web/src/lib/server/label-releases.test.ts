import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));

const spotify = vi.hoisted(() => ({
  calls: [] as string[],
  failPath: (_path: string): boolean => false,
  grantGone: false,
  respond: (_path: string): unknown => ({}),
  throwKind: null as "429" | "error" | null,
}));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => holder.db };
});

vi.mock("./spotify", () => {
  class ApiError extends Error {
    code: string;

    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  }

  return {
    ApiError,
    SPOTIFY_REAUTH_REQUIRED: "spotify_reauth_required",
    getSpotifyAccessToken: async () => {
      if (spotify.grantGone) {
        throw new ApiError("spotify_reauth_required", "grant gone");
      }

      return "tok";
    },
    spotifyFetch: async (path: string) => {
      spotify.calls.push(path);

      if (spotify.throwKind === "429") {
        throw new Error("Spotify request failed: 429 Too Many Requests");
      }

      if (spotify.throwKind === "error" || spotify.failPath(path)) {
        throw new Error("Spotify request failed: 500");
      }

      return { json: async () => spotify.respond(path) };
    },
  };
});

import { createIntegrationDb, seedCatalogueTrack, seedTrack } from "./integration-db";
import {
  copyrightMatchesLabel,
  labelReleaseTrackId,
  parseLabelAlbumSearch,
  parseProbeAlbum,
  parseProbeTrack,
  probeLabelReleases,
  stripCopyrightPrefix,
  TAP_BUDGET_CEILING,
} from "./label-releases";
import { listFreshReleases } from "./fresh";
import {
  readSpotifyCallCount,
  SPOTIFY_CALL_WINDOW_MAX,
  SPOTIFY_CALLS_WINDOW_COUNT_KEY,
  SPOTIFY_CALLS_WINDOW_START_KEY,
} from "./spotify-budget";

type AlbumFixture = {
  artistIds?: string[];
  copyrights: string[];
  id: string;
  name: string;
  releaseDate: string;
  trackIds: string[];
};

const KNOWN_ARTIST_ID = "sp_artist_known";

type TrackFixture = {
  artistIds?: string[];
  artistNames?: string[];
  durationMs?: number;
  id: string;
  isrc?: string;
  title: string;
};

function searchBody(albumIds: string[]): unknown {
  return { albums: { items: albumIds.map((id) => ({ id })) } };
}

function albumBody(album: AlbumFixture): unknown {
  return {
    artists: (album.artistIds ?? [KNOWN_ARTIST_ID]).map((id) => ({ id, name: "Some Artist" })),
    copyrights: album.copyrights.map((text) => ({ text, type: "P" })),
    id: album.id,
    name: album.name,
    release_date: album.releaseDate,
    tracks: { items: album.trackIds.map((id) => ({ id })) },
  };
}

function trackBody(track: TrackFixture): unknown {
  const artistNames =
    track.artistNames ??
    (track.artistIds ? track.artistIds.map(() => "Test Artist") : ["Test Artist"]);

  return {
    artists: artistNames.map((name, index) => ({
      ...(track.artistIds?.[index] ? { id: track.artistIds[index] } : {}),
      name,
    })),
    duration_ms: track.durationMs ?? 270_000,
    external_ids: track.isrc ? { isrc: track.isrc } : {},
    external_urls: { spotify: `https://open.spotify.com/track/${track.id}` },
    id: track.id,
    name: track.title,
    uri: `spotify:track:${track.id}`,
  };
}

function idSegment(path: string): string {
  return decodeURIComponent((path.split("?")[0] ?? "").split("/").pop() ?? "");
}

function setSpotifyFixture(config: {
  albums?: AlbumFixture[];
  searchAlbumIds?: string[];
  tracks?: TrackFixture[];
}): void {
  const albumsById = new Map((config.albums ?? []).map((a) => [a.id, a]));
  const tracksById = new Map((config.tracks ?? []).map((t) => [t.id, t]));

  spotify.respond = (path: string): unknown => {
    if (path.startsWith("/search?")) {
      return searchBody(config.searchAlbumIds ?? []);
    }

    if (path.startsWith("/albums/")) {
      const album = albumsById.get(idSegment(path));

      return album ? albumBody(album) : {};
    }

    if (path.startsWith("/tracks/")) {
      const track = tracksById.get(idSegment(path));

      return track ? trackBody(track) : {};
    }

    return {};
  };
}

async function seedEnabledLabel(
  client: Client,
  label: { id: string; name: string; slug: string },
): Promise<void> {
  const now = new Date().toISOString();

  await client.execute({
    args: [label.id, label.name, label.slug, "enabled", now, now],
    sql: `insert into labels (id, name, slug, seed_state, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?)`,
  });
}

async function seedArtist(client: Client, spotifyArtistId: string): Promise<void> {
  const now = new Date().toISOString();

  await client.execute({
    args: [
      `art_${spotifyArtistId}`,
      "Known Artist",
      `known-${spotifyArtistId}`,
      spotifyArtistId,
      now,
      now,
    ],
    sql: `insert into artists (id, name, slug, spotify_artist_id, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?)`,
  });
}

async function seedArtistRule(
  client: Client,
  rule: {
    artistMbid: string;
    artistSpotifyId?: null | string;
    labelId?: null | string;
    verdict: "allow" | "block";
  },
): Promise<void> {
  const now = new Date().toISOString();
  const labelKey = rule.labelId ?? "global";

  await client.execute({
    args: [
      `rule_${labelKey}_${rule.artistMbid}`,
      rule.artistMbid,
      `Rule ${rule.artistMbid}`,
      rule.artistSpotifyId ?? null,
      rule.verdict,
      rule.labelId ?? null,
      "operator",
      now,
      now,
    ],
    sql: `insert into artist_rules
            (id, artist_mbid, artist_name, artist_spotify_id, verdict, label_id, source, created_at,
             updated_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  });
}

async function setSpotifyCallMeter(client: Client, count: number, ageMs = 0): Promise<void> {
  const entries: Array<[string, string]> = [
    [SPOTIFY_CALLS_WINDOW_START_KEY, new Date(Date.now() - ageMs).toISOString()],
    [SPOTIFY_CALLS_WINDOW_COUNT_KEY, String(count)],
  ];

  for (const [key, value] of entries) {
    await client.execute({
      args: [key, value, value],
      sql: `insert into settings (key, value) values (?, ?)
            on conflict(key) do update set value = ?`,
    });
  }
}

function setMintableFixture(): void {
  setSpotifyFixture({
    albums: [
      {
        copyrights: ["℗ 2026 Medschool"],
        id: "alb1",
        name: "New EP",
        releaseDate: "2026-07-19",
        trackIds: ["t1"],
      },
    ],
    searchAlbumIds: ["alb1"],
    tracks: [{ id: "t1", isrc: "GB0000000001", title: "Foo" }],
  });
}

let db: Client;
let fixtureDirectory: string | undefined;

beforeEach(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "fluncle-label-releases-"));
  db = await createIntegrationDb({ url: `file:${join(fixtureDirectory, "fixture.db")}` });
  holder.db = db;

  await seedArtist(db, KNOWN_ARTIST_ID);
  spotify.calls = [];
  spotify.grantGone = false;
  spotify.throwKind = null;
  spotify.failPath = () => false;
  spotify.respond = () => ({});
});

afterEach(async () => {
  db.close();
  holder.db = undefined;

  if (fixtureDirectory) {
    await rm(fixtureDirectory, { force: true, recursive: true });
    fixtureDirectory = undefined;
  }
});

describe("parseLabelAlbumSearch", () => {
  it("reads the album ids off a search response", () => {
    expect(parseLabelAlbumSearch(searchBody(["a1", "a2"]))).toEqual(["a1", "a2"]);
    expect(parseLabelAlbumSearch(null)).toEqual([]);
  });
});

describe("parseProbeAlbum", () => {
  it("reads copyrights + artist ids + track ids + date off a SINGLE album body", () => {
    const body = {
      artists: [
        { id: "sp_art_1", name: "A" },
        { id: "sp_art_2", name: "B" },
      ],
      copyrights: [{ text: "℗ 2026 Hospital Records", type: "P" }],
      id: "a1",
      name: "New EP",
      release_date: "2026-07-19",
      tracks: { items: [{ id: "t1" }, { id: "t2" }] },
    };

    expect(parseProbeAlbum(body)).toEqual({
      copyrights: ["℗ 2026 Hospital Records"],
      id: "a1",
      name: "New EP",
      releaseDate: "2026-07-19",
      spotifyArtistIds: ["sp_art_1", "sp_art_2"],
      trackIds: ["t1", "t2"],
    });
    expect(parseProbeAlbum(null)).toBeNull();
    expect(parseProbeAlbum({ name: "no id" })).toBeNull();
  });
});

describe("stripCopyrightPrefix", () => {
  it("strips leading ℗/© symbols + the copyright year, leaving the label portion", () => {
    expect(stripCopyrightPrefix("℗ 2026 Hospital Records")).toBe("Hospital Records");
    expect(stripCopyrightPrefix("© 2026 Med School")).toBe("Med School");
    expect(stripCopyrightPrefix("(P) 2026 Foo")).toBe("Foo");
    expect(stripCopyrightPrefix("© ℗ 2026 Bar")).toBe("Bar");
    expect(stripCopyrightPrefix("2026 Baz")).toBe("Baz");

    expect(stripCopyrightPrefix("℗ 2026 1985 Music")).toBe("1985 Music");
  });
});

describe("parseProbeTrack", () => {
  it("reads ISRC + duration + uri/url + artists off a SINGLE track body", () => {
    const track = parseProbeTrack(
      trackBody({
        artistIds: ["sp_art_1", "sp_art_2"],
        artistNames: ["A", "B"],
        durationMs: 300_000,
        id: "t1",
        isrc: "GB0000000001",
        title: "Foo",
      }),
    );

    expect(track).toMatchObject({
      durationMs: 300_000,
      isrc: "GB0000000001",
      spotifyArtistIds: ["sp_art_1", "sp_art_2"],
      spotifyTrackId: "t1",
      spotifyUri: "spotify:track:t1",
      title: "Foo",
    });
    expect(parseProbeTrack(null)).toBeNull();
    expect(parseProbeTrack({ id: "t1" })).toBeNull();
  });
});

describe("copyrightMatchesLabel", () => {
  it("requires EXACT-fold equality on the stripped label portion (not a substring)", () => {
    expect(copyrightMatchesLabel(["℗ 2026 Med School"], "Medschool")).toBe(true);
    expect(copyrightMatchesLabel(["℗ 2026 Hospital Records"], "Hospital Records")).toBe(true);

    expect(copyrightMatchesLabel(["℗ 2026 Silent Lens"], "Lens")).toBe(false);

    expect(copyrightMatchesLabel(["℗ 2026 Med School Recordings"], "Medschool")).toBe(false);
    expect(copyrightMatchesLabel(["℗ 2026 Some Other Label"], "Hospital Records")).toBe(false);
    expect(copyrightMatchesLabel([], "Hospital Records")).toBe(false);
  });
});

describe("probeLabelReleases", () => {
  it("is a no-op when the Spotify grant is gone (configured:false)", async () => {
    await seedEnabledLabel(db, { id: "lbl_1", name: "Medschool", slug: "medschool" });
    spotify.grantGone = true;

    const result = await probeLabelReleases();

    expect(result.configured).toBe(false);
    expect(result.newRows).toBe(0);
    expect(spotify.calls).toHaveLength(0);
    expect(Number((await db.execute("select count(*) as n from tracks")).rows[0]?.n)).toBe(0);
  });

  it("probes ONLY enabled seed labels (the allowlist gate)", async () => {
    await seedEnabledLabel(db, { id: "lbl_en", name: "Medschool", slug: "medschool" });
    const now = new Date().toISOString();
    await db.execute({
      args: ["lbl_dis", "Disabled Co", "disabled-co", "disabled", now, now],
      sql: `insert into labels (id, name, slug, seed_state, created_at, updated_at) values (?, ?, ?, ?, ?, ?)`,
    });

    setSpotifyFixture({
      albums: [
        {
          copyrights: ["℗ 2026 Medschool"],
          id: "alb1",
          name: "New EP",
          releaseDate: "2026-07-19",
          trackIds: ["t1"],
        },
      ],
      searchAlbumIds: ["alb1"],
      tracks: [{ id: "t1", isrc: "GB0000000001", title: "Foo" }],
    });

    const result = await probeLabelReleases();

    expect(result.labelsProbed).toBe(1);
    expect(result.newRows).toBe(1);
    const searchCalls = spotify.calls.filter((path) => path.startsWith("/search?"));
    expect(searchCalls).toHaveLength(1);
    expect(decodeURIComponent(searchCalls[0] ?? "")).toContain("Medschool");
    expect(spotify.calls.join("|")).not.toContain("Disabled");
  });

  it("drops a track whose FIRST Spotify credit is blocked by the probed label", async () => {
    await seedEnabledLabel(db, { id: "lbl_scope", name: "Medschool", slug: "medschool" });
    await seedArtistRule(db, {
      artistMbid: "mb_blocked",
      artistSpotifyId: "sp_blocked",
      labelId: "lbl_scope",
      verdict: "block",
    });

    setSpotifyFixture({
      albums: [
        {
          copyrights: ["℗ 2026 Medschool"],
          id: "alb_scope",
          name: "Scoped EP",
          releaseDate: "2026-07-19",
          trackIds: ["t_blocked"],
        },
      ],
      searchAlbumIds: ["alb_scope"],
      tracks: [{ artistIds: ["sp_blocked"], id: "t_blocked", title: "Blocked" }],
    });

    const result = await probeLabelReleases();

    expect(result.newRows).toBe(0);
    expect(result.tracksSkippedArtistRule).toBe(1);
    expect(await db.execute("select 1 from tracks where track_id = 'sp_t_blocked'")).toMatchObject({
      rows: [],
    });
  });

  it("drops a track whose FIRST Spotify credit is blocked globally", async () => {
    await seedEnabledLabel(db, { id: "lbl_global", name: "Medschool", slug: "medschool" });
    await seedArtistRule(db, {
      artistMbid: "mb_global_blocked",
      artistSpotifyId: "sp_global_blocked",
      verdict: "block",
    });

    setSpotifyFixture({
      albums: [
        {
          copyrights: ["℗ 2026 Medschool"],
          id: "alb_global",
          name: "Global EP",
          releaseDate: "2026-07-19",
          trackIds: ["t_global_blocked"],
        },
      ],
      searchAlbumIds: ["alb_global"],
      tracks: [{ artistIds: ["sp_global_blocked"], id: "t_global_blocked", title: "Blocked" }],
    });

    const result = await probeLabelReleases();

    expect(result.newRows).toBe(0);
    expect(result.tracksSkippedArtistRule).toBe(1);
  });

  it("keeps a track when the matching block rule has a null Spotify bridge", async () => {
    await seedEnabledLabel(db, { id: "lbl_blind", name: "Medschool", slug: "medschool" });
    await seedArtistRule(db, {
      artistMbid: "mb_tap_blind",
      artistSpotifyId: null,
      labelId: "lbl_blind",
      verdict: "block",
    });

    setSpotifyFixture({
      albums: [
        {
          copyrights: ["℗ 2026 Medschool"],
          id: "alb_blind",
          name: "Tap Blind EP",
          releaseDate: "2026-07-19",
          trackIds: ["t_blind"],
        },
      ],
      searchAlbumIds: ["alb_blind"],
      tracks: [{ artistIds: ["sp_tap_blind"], id: "t_blind", title: "Kept" }],
    });

    const result = await probeLabelReleases();

    expect(result.newRows).toBe(1);
    expect(result.tracksSkippedArtistRule).toBe(0);
  });

  it("keeps a track when Spotify supplies no artist ids", async () => {
    await seedEnabledLabel(db, { id: "lbl_no_ids", name: "Medschool", slug: "medschool" });
    await seedArtistRule(db, {
      artistMbid: "mb_no_ids",
      artistSpotifyId: "sp_no_ids",
      labelId: "lbl_no_ids",
      verdict: "block",
    });

    setSpotifyFixture({
      albums: [
        {
          copyrights: ["℗ 2026 Medschool"],
          id: "alb_no_ids",
          name: "No IDs EP",
          releaseDate: "2026-07-19",
          trackIds: ["t_no_ids"],
        },
      ],
      searchAlbumIds: ["alb_no_ids"],
      tracks: [{ id: "t_no_ids", title: "Kept" }],
    });

    const result = await probeLabelReleases();

    expect(result.newRows).toBe(1);
    expect(result.tracksSkippedArtistRule).toBe(0);
  });

  it("matches only the FIRST Spotify credit, so a blocked second credit is kept", async () => {
    await seedEnabledLabel(db, { id: "lbl_first", name: "Medschool", slug: "medschool" });
    await seedArtistRule(db, {
      artistMbid: "mb_second",
      artistSpotifyId: "sp_second",
      labelId: "lbl_first",
      verdict: "block",
    });

    setSpotifyFixture({
      albums: [
        {
          copyrights: ["℗ 2026 Medschool"],
          id: "alb_first",
          name: "Credit Order EP",
          releaseDate: "2026-07-19",
          trackIds: ["t_second"],
        },
      ],
      searchAlbumIds: ["alb_first"],
      tracks: [{ artistIds: [KNOWN_ARTIST_ID, "sp_second"], id: "t_second", title: "Kept" }],
    });

    const result = await probeLabelReleases();

    expect(result.newRows).toBe(1);
    expect(result.tracksSkippedArtistRule).toBe(0);
  });

  it("does not apply allow rules to the tap", async () => {
    await seedEnabledLabel(db, { id: "lbl_allow", name: "Medschool", slug: "medschool" });
    await seedArtistRule(db, {
      artistMbid: "mb_label_allow",
      artistSpotifyId: "sp_allowed",
      labelId: "lbl_allow",
      verdict: "allow",
    });
    await seedArtistRule(db, {
      artistMbid: "mb_global_allow",
      artistSpotifyId: "sp_allowed",
      verdict: "allow",
    });

    setSpotifyFixture({
      albums: [
        {
          copyrights: ["℗ 2026 Medschool"],
          id: "alb_allow",
          name: "Allow EP",
          releaseDate: "2026-07-19",
          trackIds: ["t_allowed"],
        },
      ],
      searchAlbumIds: ["alb_allow"],
      tracks: [{ artistIds: ["sp_allowed"], id: "t_allowed", title: "Kept" }],
    });

    const result = await probeLabelReleases();

    expect(result.newRows).toBe(1);
    expect(result.tracksSkippedArtistRule).toBe(0);
  });

  it("mints ONLY the copyright-matching album (the fuzzy search is post-filtered)", async () => {
    await seedEnabledLabel(db, { id: "lbl_1", name: "Hospital Records", slug: "hospital-records" });

    setSpotifyFixture({
      albums: [
        {
          copyrights: ["℗ 2026 Hospital Records"],
          id: "real",
          name: "Real EP",
          releaseDate: "2026-07-19",
          trackIds: ["t_real"],
        },
        {
          copyrights: ["℗ 2026 Some Other Label"],
          id: "junk",
          name: "Junk LP",
          releaseDate: "2026-07-19",
          trackIds: ["t_junk"],
        },
      ],
      searchAlbumIds: ["real", "junk"],
      tracks: [
        { id: "t_real", isrc: "GB0000000001", title: "Real Track" },
        { id: "t_junk", isrc: "GB0000000002", title: "Junk Track" },
      ],
    });

    const result = await probeLabelReleases();

    expect(result.albumsSeen).toBe(2);
    expect(result.albumsMatched).toBe(1);
    expect(result.newRows).toBe(1);
    expect(result.newTrackIds).toEqual(["sp_t_real"]);
    expect(
      (
        await db.execute(`select normalized_isrc from track_duplicate_keys
          where track_id = 'sp_t_real'`)
      ).rows,
    ).toEqual([{ normalized_isrc: "GB0000000001" }]);

    const junk = await db.execute({
      args: ["sp_t_junk"],
      sql: `select 1 from tracks where track_id = ?`,
    });
    expect(junk.rows).toHaveLength(0);

    expect(spotify.calls.some((path) => path.includes("t_junk"))).toBe(false);
  });

  it("mints a KNOWN-artist album but SKIPS an unknown-artist one on the SAME label (grounding)", async () => {
    await seedEnabledLabel(db, { id: "lbl_1", name: "Medschool", slug: "medschool" });

    setSpotifyFixture({
      albums: [
        {
          artistIds: [KNOWN_ARTIST_ID],
          copyrights: ["℗ 2026 Medschool"],
          id: "grounded",
          name: "Real EP",
          releaseDate: "2026-07-19",
          trackIds: ["t_known"],
        },
        {
          artistIds: ["sp_artist_unknown"],
          copyrights: ["℗ 2026 Medschool"],
          id: "ungrounded",
          name: "Debut EP",
          releaseDate: "2026-07-19",
          trackIds: ["t_new"],
        },
      ],
      searchAlbumIds: ["grounded", "ungrounded"],
      tracks: [{ id: "t_known", isrc: "GB0000000001", title: "Real Track" }],
    });

    const result = await probeLabelReleases();

    expect(result.albumsMatched).toBe(1);
    expect(result.skippedUngrounded).toBe(1);
    expect(result.newRows).toBe(1);
    expect(result.newTrackIds).toEqual(["sp_t_known"]);

    const un = await db.execute("select 1 from tracks where track_id = 'sp_t_new'");
    expect(un.rows).toHaveLength(0);
    expect(spotify.calls.some((path) => path.includes("t_new"))).toBe(false);
  });

  it("SKIPS the homonym case — right label NAME, but all artists unknown (cross-genre junk)", async () => {
    await seedEnabledLabel(db, { id: "lbl_1", name: "Earth Records", slug: "earth-records" });

    setSpotifyFixture({
      albums: [
        {
          artistIds: ["sp_artist_devotional", "sp_artist_folk"],
          copyrights: ["℗ 2026 Earth Records"],
          id: "homonym",
          name: "Bhajans Vol 3",
          releaseDate: "2026-07-19",
          trackIds: ["t_junk"],
        },
      ],
      searchAlbumIds: ["homonym"],
      tracks: [{ id: "t_junk", isrc: "IN0000000001", title: "Bhola Baba" }],
    });

    const result = await probeLabelReleases();

    expect(result.skippedUngrounded).toBe(1);
    expect(result.albumsMatched).toBe(0);
    expect(result.newRows).toBe(0);
    expect(Number((await db.execute("select count(*) as n from tracks")).rows[0]?.n)).toBe(0);
  });

  it("uses ONLY the SINGLE endpoints — never the 403 batch endpoints (the tier contract)", async () => {
    await seedEnabledLabel(db, { id: "lbl_1", name: "Medschool", slug: "medschool" });

    setSpotifyFixture({
      albums: [
        {
          copyrights: ["℗ 2026 Medschool"],
          id: "alb1",
          name: "New EP",
          releaseDate: "2026-07-19",
          trackIds: ["t1"],
        },
      ],
      searchAlbumIds: ["alb1"],
      tracks: [{ id: "t1", isrc: "GB0000000001", title: "Foo" }],
    });

    await probeLabelReleases();

    expect(spotify.calls.some((path) => path.startsWith("/albums?ids="))).toBe(false);
    expect(spotify.calls.some((path) => path.startsWith("/tracks?ids="))).toBe(false);

    expect(spotify.calls).toContain("/albums/alb1");
    expect(spotify.calls).toContain("/tracks/t1");
  });

  it("SKIPS a failed single album read (and its label is still stamped — not a label failure)", async () => {
    await seedEnabledLabel(db, { id: "lbl_1", name: "Medschool", slug: "medschool" });

    setSpotifyFixture({
      albums: [
        {
          copyrights: ["℗ 2026 Medschool"],
          id: "good",
          name: "New EP",
          releaseDate: "2026-07-19",
          trackIds: ["t1"],
        },

        {
          copyrights: ["℗ 2026 Medschool"],
          id: "bad",
          name: "Broken EP",
          releaseDate: "2026-07-19",
          trackIds: ["t2"],
        },
      ],
      searchAlbumIds: ["good", "bad"],
      tracks: [{ id: "t1", isrc: "GB0000000001", title: "Foo" }],
    });
    spotify.failPath = (path) => path === "/albums/bad";

    const result = await probeLabelReleases();

    expect(result.failedFetches).toBe(1);
    expect(result.failedLabels).toEqual([]);
    expect(result.newRows).toBe(1);
    expect(result.newTrackIds).toEqual(["sp_t1"]);

    const stamp = await db.execute(
      "select label_releases_checked_at, label_releases_failures from labels where slug = 'medschool'",
    );
    expect(stamp.rows[0]?.label_releases_checked_at).not.toBeNull();
    expect(Number(stamp.rows[0]?.label_releases_failures)).toBe(0);
  });

  it("mints a valid catalogue row with the ARCHIVE's label spelling, the anchor, and the day-one date", async () => {
    await seedEnabledLabel(db, { id: "lbl_1", name: "Medschool", slug: "medschool" });

    setSpotifyFixture({
      albums: [
        {
          copyrights: ["℗ 2026 Med School"],
          id: "alb1",
          name: "New EP",
          releaseDate: "2026-07-18",
          trackIds: ["t1"],
        },
      ],
      searchAlbumIds: ["alb1"],
      tracks: [{ id: "t1", isrc: "GB0000000001", title: "Foo" }],
    });

    const result = await probeLabelReleases();

    expect(result.newRows).toBe(1);
    const track = await db.execute({
      args: [labelReleaseTrackId("t1")],
      sql: `select track_id, title, label, label_id, isrc, release_date, spotify_uri, spotify_url,
                   album, capture_status from tracks where track_id = ?`,
    });
    const row = track.rows[0];
    expect(row?.track_id).toBe("sp_t1");
    expect(row?.label).toBe("Medschool");
    expect(row?.label_id).toBe("lbl_1");
    expect(row?.isrc).toBe("GB0000000001");
    expect(row?.release_date).toBe("2026-07-18");
    expect(row?.spotify_uri).toBe("spotify:track:t1");
    expect(row?.spotify_url).toContain("open.spotify.com");
    expect(row?.album).toBe("New EP");
    expect(row?.capture_status).toBe("pending");

    const finding = await db.execute({
      args: ["sp_t1"],
      sql: `select 1 from findings where track_id = ?`,
    });
    expect(finding.rows).toHaveLength(0);
  });

  it("stamps the ISRC ATTEMPT and leaves Discogs honestly unattempted (RFC identity-graph, Unit 1)", async () => {
    await seedEnabledLabel(db, { id: "lbl_1", name: "Medschool", slug: "medschool" });

    setSpotifyFixture({
      albums: [
        {
          copyrights: ["℗ 2026 Med School"],
          id: "alb1",
          name: "New EP",
          releaseDate: "2026-07-18",
          trackIds: ["t1", "t2"],
        },
      ],
      searchAlbumIds: ["alb1"],
      tracks: [
        { id: "t1", isrc: "GB0000000001", title: "Foo" },

        { id: "t2", title: "Bar" },
      ],
    });

    await probeLabelReleases();

    const rows = await db.execute(
      `select track_id, isrc, isrc_attempted_at, backfill_discogs_attempted_at,
              backfill_discogs_attempts
       from tracks order by track_id`,
    );

    expect(rows.rows).toHaveLength(2);

    for (const row of rows.rows) {
      expect(row.isrc_attempted_at).not.toBeNull();

      expect(row.backfill_discogs_attempted_at).toBeNull();
      expect(Number(row.backfill_discogs_attempts)).toBe(0);
    }

    expect(rows.rows.find((row) => row.track_id === "sp_t2")?.isrc).toBeNull();
  });

  it("skips a track already in the archive by ISRC (an MB-first row → the tap skips)", async () => {
    await seedEnabledLabel(db, { id: "lbl_1", name: "Medschool", slug: "medschool" });
    await seedCatalogueTrack(db, { title: "Foo", trackId: "mb_existing" });
    await db.execute({
      args: ["GB0000000001", "mb_existing"],
      sql: `update tracks set isrc = ? where track_id = ?`,
    });

    setSpotifyFixture({
      albums: [
        {
          copyrights: ["℗ 2026 Medschool"],
          id: "alb1",
          name: "New EP",
          releaseDate: "2026-07-19",
          trackIds: ["t1"],
        },
      ],
      searchAlbumIds: ["alb1"],
      tracks: [{ id: "t1", isrc: "GB0000000001", title: "Foo" }],
    });

    const result = await probeLabelReleases();

    expect(result.newRows).toBe(0);
    expect(result.skippedKnown).toBe(1);
    expect(Number((await db.execute("select count(*) as n from tracks")).rows[0]?.n)).toBe(1);
  });

  it("skips a track a CERTIFIED finding already holds by its spotify_uri (never a duplicate anchor)", async () => {
    await seedEnabledLabel(db, { id: "lbl_1", name: "Medschool", slug: "medschool" });

    await seedTrack(db, { logId: "AAA.01.01", title: "Foo", trackId: "t1" });

    setSpotifyFixture({
      albums: [
        {
          copyrights: ["℗ 2026 Medschool"],
          id: "alb1",
          name: "New EP",
          releaseDate: "2026-07-19",
          trackIds: ["t1"],
        },
      ],
      searchAlbumIds: ["alb1"],
      tracks: [{ id: "t1", title: "Foo" }],
    });

    const result = await probeLabelReleases();

    expect(result.newRows).toBe(0);

    expect(spotify.calls.some((path) => path.startsWith("/tracks/"))).toBe(false);

    const rows = await db.execute("select track_id from tracks where track_id in ('t1','sp_t1')");
    expect(rows.rows.map((row) => row.track_id)).toEqual(["t1"]);
  });

  it("skips a no-ISRC track that title-folds to an existing row on the SAME album", async () => {
    await seedEnabledLabel(db, { id: "lbl_1", name: "Medschool", slug: "medschool" });
    await db.execute({
      args: ["alb_row", "New EP", "new-ep", new Date().toISOString(), new Date().toISOString()],
      sql: `insert into albums (id, name, slug, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    });

    await db.execute({
      args: ["mb_existing", "Foo", JSON.stringify(["Artist"]), 270_000, "alb_row"],
      sql: `insert into tracks (track_id, title, artists_json, duration_ms, album_id) values (?, ?, ?, ?, ?)`,
    });

    setSpotifyFixture({
      albums: [
        {
          copyrights: ["℗ 2026 Medschool"],
          id: "alb1",
          name: "New EP",
          releaseDate: "2026-07-19",
          trackIds: ["t_new"],
        },
      ],
      searchAlbumIds: ["alb1"],
      tracks: [{ id: "t_new", title: "Foo" }],
    });

    const result = await probeLabelReleases();

    expect(result.newRows).toBe(0);
    expect(result.skippedKnown).toBe(1);
  });

  it("does NOT merge a VIP/remix (a different title) on the same album", async () => {
    await seedEnabledLabel(db, { id: "lbl_1", name: "Medschool", slug: "medschool" });

    setSpotifyFixture({
      albums: [
        {
          copyrights: ["℗ 2026 Medschool"],
          id: "alb1",
          name: "New EP",
          releaseDate: "2026-07-19",
          trackIds: ["t1", "t2"],
        },
      ],
      searchAlbumIds: ["alb1"],
      tracks: [
        { id: "t1", title: "Foo" },
        { id: "t2", title: "Foo VIP" },
      ],
    });

    const result = await probeLabelReleases();

    expect(result.newRows).toBe(2);
    expect(result.skippedKnown).toBe(0);
  });

  it("is idempotent across two runs (the sp_ id + uri pre-filter)", async () => {
    await seedEnabledLabel(db, { id: "lbl_1", name: "Medschool", slug: "medschool" });
    setSpotifyFixture({
      albums: [
        {
          copyrights: ["℗ 2026 Medschool"],
          id: "alb1",
          name: "New EP",
          releaseDate: "2026-07-19",
          trackIds: ["t1"],
        },
      ],
      searchAlbumIds: ["alb1"],
      tracks: [{ id: "t1", isrc: "GB0000000001", title: "Foo" }],
    });

    const first = await probeLabelReleases();
    expect(first.newRows).toBe(1);

    await db.execute("update labels set label_releases_checked_at = null where slug = 'medschool'");
    spotify.calls = [];
    const second = await probeLabelReleases();

    expect(second.newRows).toBe(0);

    expect(spotify.calls.some((path) => path.startsWith("/tracks/"))).toBe(false);
    expect(Number((await db.execute("select count(*) as n from tracks")).rows[0]?.n)).toBe(1);
  });

  it("short-circuits and stops on a Spotify 429", async () => {
    await seedEnabledLabel(db, { id: "lbl_1", name: "Medschool", slug: "medschool" });
    setSpotifyFixture({ searchAlbumIds: ["alb1"] });
    spotify.throwKind = "429";

    const result = await probeLabelReleases();

    expect(result.rateLimited).toBe(true);
    expect(result.newRows).toBe(0);
  });

  it("a minted row shows on /fresh in the unlit (catalogue) half", async () => {
    await seedEnabledLabel(db, { id: "lbl_1", name: "Medschool", slug: "medschool" });
    const now = new Date("2026-07-20T12:00:00Z");

    setSpotifyFixture({
      albums: [
        {
          copyrights: ["℗ 2026 Medschool"],
          id: "alb1",
          name: "New EP",
          releaseDate: "2026-07-18",
          trackIds: ["t1"],
        },
      ],
      searchAlbumIds: ["alb1"],
      tracks: [{ id: "t1", isrc: "GB0000000001", title: "Foo" }],
    });

    await probeLabelReleases();
    const fresh = await listFreshReleases(now);

    const catalogueIds = fresh.catalogue.map((item) => item.trackId);
    expect(catalogueIds).toContain("sp_t1");
    expect(fresh.findings).toHaveLength(0);
  });

  it("NEVER mints an album with no release_date (a row /fresh could never surface)", async () => {
    await seedEnabledLabel(db, { id: "lbl_1", name: "Medschool", slug: "medschool" });

    setSpotifyFixture({
      albums: [
        {
          copyrights: ["℗ 2026 Medschool"],
          id: "dated",
          name: "New EP",
          releaseDate: "2026-07-19",
          trackIds: ["t_ok"],
        },
        {
          copyrights: ["℗ 2026 Medschool"],
          id: "undated",
          name: "Dateless EP",
          releaseDate: "",
          trackIds: ["t_undated"],
        },
      ],
      searchAlbumIds: ["dated", "undated"],
      tracks: [
        { id: "t_ok", isrc: "GB0000000001", title: "Foo" },
        { id: "t_undated", isrc: "GB0000000002", title: "Ghost" },
      ],
    });

    const result = await probeLabelReleases();

    expect(result.skippedUndated).toBe(1);
    expect(result.albumsMatched).toBe(1);
    expect(result.newTrackIds).toEqual(["sp_t_ok"]);

    const ghost = await db.execute("select 1 from tracks where track_id = 'sp_t_undated'");
    expect(ghost.rows).toHaveLength(0);
    expect(spotify.calls.some((path) => path.includes("t_undated"))).toBe(false);

    const undated = await db.execute(
      "select count(*) as n from tracks where release_date is null or release_date = ''",
    );
    expect(Number(undated.rows[0]?.n)).toBe(0);
  });

  it("RECORDS every Spotify call it makes into the shared per-app meter", async () => {
    await seedEnabledLabel(db, { id: "lbl_1", name: "Medschool", slug: "medschool" });
    setMintableFixture();
    await setSpotifyCallMeter(db, 0);

    await probeLabelReleases();

    expect(spotify.calls).toHaveLength(3);
    expect(await readSpotifyCallCount()).toBe(spotify.calls.length);
  });

  it("holds itself to a FRACTION of the window, so a user path keeps real headroom", async () => {
    expect(TAP_BUDGET_CEILING).toBeLessThan(SPOTIFY_CALL_WINDOW_MAX);
    expect(TAP_BUDGET_CEILING).toBeGreaterThan(0);
  });

  it("STEPS BACK without a single call when the window is already at the tap's ceiling", async () => {
    await seedEnabledLabel(db, { id: "lbl_1", name: "Medschool", slug: "medschool" });
    setMintableFixture();

    await setSpotifyCallMeter(db, TAP_BUDGET_CEILING);

    const result = await probeLabelReleases();

    expect(result.budgetPaused).toBe(true);
    expect(result.labelsProbed).toBe(0);
    expect(result.newRows).toBe(0);

    expect(spotify.calls).toHaveLength(0);
    expect(await readSpotifyCallCount()).toBe(TAP_BUDGET_CEILING);

    const label = await db.execute(
      "select label_releases_checked_at, label_releases_failures from labels where slug = 'medschool'",
    );
    expect(label.rows[0]?.label_releases_checked_at).toBeNull();
    expect(Number(label.rows[0]?.label_releases_failures ?? 0)).toBe(0);
  });

  it("RESUMES on the next window — the paused label is still due and mints", async () => {
    await seedEnabledLabel(db, { id: "lbl_1", name: "Medschool", slug: "medschool" });
    setMintableFixture();
    await setSpotifyCallMeter(db, TAP_BUDGET_CEILING);

    const paused = await probeLabelReleases();
    expect(paused.budgetPaused).toBe(true);
    expect(paused.newRows).toBe(0);

    await setSpotifyCallMeter(db, TAP_BUDGET_CEILING, 60_000);
    const resumed = await probeLabelReleases();

    expect(resumed.budgetPaused).toBe(false);
    expect(resumed.newRows).toBe(1);
    expect(resumed.newTrackIds).toEqual(["sp_t1"]);
  });

  it("stops MID-PASS at the ceiling, leaving the unprobed labels for the next tick", async () => {
    await seedEnabledLabel(db, { id: "lbl_1", name: "Aaa Label", slug: "aaa-label" });
    await seedEnabledLabel(db, { id: "lbl_2", name: "Zzz Label", slug: "zzz-label" });
    setSpotifyFixture({ searchAlbumIds: [] });
    await setSpotifyCallMeter(db, TAP_BUDGET_CEILING - 1);

    const result = await probeLabelReleases();

    expect(result.budgetPaused).toBe(true);
    expect(result.labelsProbed).toBe(1);
    expect(spotify.calls).toHaveLength(1);

    const stamps = await db.execute(
      "select slug, label_releases_checked_at from labels order by slug asc",
    );
    expect(stamps.rows[0]?.label_releases_checked_at).not.toBeNull();
    expect(stamps.rows[1]?.label_releases_checked_at).toBeNull();
  });

  it("never blocks the tap when the meter's own store faults (fail-open)", async () => {
    await seedEnabledLabel(db, { id: "lbl_1", name: "Medschool", slug: "medschool" });
    setMintableFixture();
    await db.execute("drop table settings");

    const result = await probeLabelReleases();

    expect(result.budgetPaused).toBe(false);
    expect(result.newRows).toBe(1);
  });
});
