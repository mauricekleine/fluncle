// THE FRESHNESS TAP (D8), proven against the REAL migrated schema on an in-memory libSQL engine
// (the integration-db harness). The Spotify client (`./spotify`) is mocked so a test drives exactly
// the Spotify response it wants and can flip the grant/throttle shut; every DB write executes REAL
// SQL against the REAL schema.
//
// What is pinned here:
//   - the pure parsers (album search, full albums + copyrights, full tracks);
//   - the copyrights POST-FILTER — a fuzzy `label:` hit is minted ONLY when a copyright names the
//     seed label (a junk album is rejected);
//   - the allowlist gate — only ENABLED seed labels are ever probed;
//   - the dedupe contract from the tap side (Spotify id / uri / ISRC / same-album title fold), the
//     VIP/remix non-merge, convergence with a bare-id finding, plus mint idempotence across runs;
//   - the 429 short-circuit and the gone-grant no-op;
//   - /fresh visibility of a minted row (in-window release_date, the unlit half);
//   - the archive-spelling label invariant (`slugify(tracks.label) = labels.slug`, label_id at the
//     KNOWN seed label — never Spotify's spelling).

import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));

// The Spotify client mock's mutable state: a per-test responder routed by path, the grant switch,
// and a throw switch (429 / other). `calls` records every path so a test can assert WHICH labels
// were searched (the allowlist gate).
const spotify = vi.hoisted(() => ({
  calls: [] as string[],
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

      if (spotify.throwKind === "error") {
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
  parseProbeAlbums,
  parseProbeTracks,
  probeLabelReleases,
} from "./label-releases";
import { listFreshReleases } from "./fresh";

// ── Fixture builders (the Spotify JSON shapes) ──────────────────────────────────────────────────

type AlbumFixture = {
  copyrights: string[];
  id: string;
  name: string;
  releaseDate: string;
  trackIds: string[];
};

type TrackFixture = {
  artistNames?: string[];
  durationMs?: number;
  id: string;
  isrc?: string;
  title: string;
};

function searchBody(albumIds: string[]): unknown {
  return { albums: { items: albumIds.map((id) => ({ id })) } };
}

function albumsBody(albums: AlbumFixture[]): unknown {
  return {
    albums: albums.map((album) => ({
      copyrights: album.copyrights.map((text) => ({ text, type: "P" })),
      id: album.id,
      name: album.name,
      release_date: album.releaseDate,
      tracks: { items: album.trackIds.map((id) => ({ id })) },
    })),
  };
}

function tracksBody(tracks: TrackFixture[]): unknown {
  return {
    tracks: tracks.map((track) => ({
      artists: (track.artistNames ?? ["Test Artist"]).map((name) => ({ name })),
      duration_ms: track.durationMs ?? 270_000,
      external_ids: track.isrc ? { isrc: track.isrc } : {},
      external_urls: { spotify: `https://open.spotify.com/track/${track.id}` },
      id: track.id,
      name: track.title,
      uri: `spotify:track:${track.id}`,
    })),
  };
}

/** Parse the `?ids=a,b,c` list off a batch path. */
function idsOf(path: string): string[] {
  const q = path.split("ids=")[1] ?? "";

  return q.split(",").filter(Boolean);
}

/**
 * A per-label Spotify fixture: the search returns `searchAlbumIds`, `/albums?ids=` returns the
 * matching full albums (in requested order), `/tracks?ids=` the matching full tracks. Routes by path.
 */
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

    if (path.startsWith("/albums?ids=")) {
      const wanted = idsOf(path)
        .map((id) => albumsById.get(id))
        .filter((a): a is AlbumFixture => a !== undefined);

      return albumsBody(wanted);
    }

    if (path.startsWith("/tracks?ids=")) {
      const wanted = idsOf(path)
        .map((id) => tracksById.get(id))
        .filter((t): t is TrackFixture => t !== undefined);

      return tracksBody(wanted);
    }

    return {};
  };
}

/** Insert an ENABLED seed label directly (seedLabel defaults to `undecided`). */
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

let db: Client;

beforeEach(async () => {
  db = await createIntegrationDb();
  holder.db = db;
  spotify.calls = [];
  spotify.grantGone = false;
  spotify.throwKind = null;
  spotify.respond = () => ({});
});

// ── The pure parsers + the post-filter ──────────────────────────────────────────────────────────

describe("parseLabelAlbumSearch", () => {
  it("reads the album ids off a search response", () => {
    expect(parseLabelAlbumSearch(searchBody(["a1", "a2"]))).toEqual(["a1", "a2"]);
    expect(parseLabelAlbumSearch(null)).toEqual([]);
  });
});

describe("parseProbeAlbums", () => {
  it("reads copyrights + track ids + date, dropping null entries", () => {
    const body = {
      albums: [
        {
          copyrights: [{ text: "℗ 2026 Hospital Records", type: "P" }],
          id: "a1",
          name: "New EP",
          release_date: "2026-07-19",
          tracks: { items: [{ id: "t1" }, { id: "t2" }] },
        },
        null, // an invalid id → Spotify returns null → dropped
      ],
    };

    expect(parseProbeAlbums(body)).toEqual([
      {
        copyrights: ["℗ 2026 Hospital Records"],
        id: "a1",
        name: "New EP",
        releaseDate: "2026-07-19",
        trackIds: ["t1", "t2"],
      },
    ]);
  });
});

describe("parseProbeTracks", () => {
  it("reads ISRC + duration + uri/url + artists", () => {
    const tracks = parseProbeTracks(
      tracksBody([{ durationMs: 300_000, id: "t1", isrc: "GB0000000001", title: "Foo" }]),
    );

    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({
      durationMs: 300_000,
      isrc: "GB0000000001",
      spotifyTrackId: "t1",
      spotifyUri: "spotify:track:t1",
      title: "Foo",
    });
  });
});

describe("copyrightMatchesLabel", () => {
  it("matches a fold-substring of a copyright string, rejects an unrelated one", () => {
    expect(copyrightMatchesLabel(["℗ 2026 Med School Recordings"], "Medschool")).toBe(true);
    expect(copyrightMatchesLabel(["℗ 2026 Hospital Records Ltd"], "Hospital Records")).toBe(true);
    expect(copyrightMatchesLabel(["℗ 2026 Some Other Label"], "Hospital Records")).toBe(false);
    expect(copyrightMatchesLabel([], "Hospital Records")).toBe(false);
  });
});

// ── The probe ─────────────────────────────────────────────────────────────────────────────────

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

  it("mints ONLY the copyright-matching album (the fuzzy search is post-filtered)", async () => {
    await seedEnabledLabel(db, { id: "lbl_1", name: "Hospital Records", slug: "hospital-records" });

    setSpotifyFixture({
      // The fuzzy `label:"Hospital Records"` returns one real album and one junk album.
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
    expect(result.albumsMatched).toBe(1); // only the copyright-matching album
    expect(result.newRows).toBe(1);
    expect(result.newTrackIds).toEqual(["sp_t_real"]);
    // The junk album's track is NEVER minted.
    const junk = await db.execute({
      args: ["sp_t_junk"],
      sql: `select 1 from tracks where track_id = ?`,
    });
    expect(junk.rows).toHaveLength(0);
    // The tap never even fetched the junk album's tracks (it failed the copyright filter).
    expect(spotify.calls.some((path) => path.includes("t_junk"))).toBe(false);
  });

  it("mints a valid catalogue row with the ARCHIVE's label spelling, the anchor, and the day-one date", async () => {
    await seedEnabledLabel(db, { id: "lbl_1", name: "Medschool", slug: "medschool" });

    setSpotifyFixture({
      albums: [
        {
          copyrights: ["℗ 2026 Med School Recordings"],
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
    expect(row?.label).toBe("Medschool"); // the archive's spelling, so slugify(label)=slug
    expect(row?.label_id).toBe("lbl_1"); // the KNOWN seed label, stamped directly
    expect(row?.isrc).toBe("GB0000000001");
    expect(row?.release_date).toBe("2026-07-18");
    expect(row?.spotify_uri).toBe("spotify:track:t1");
    expect(row?.spotify_url).toContain("open.spotify.com");
    expect(row?.album).toBe("New EP");
    expect(row?.capture_status).toBe("pending"); // the DDL default landed (never named at insert)

    // It is a CATALOGUE row — no findings row.
    const finding = await db.execute({
      args: ["sp_t1"],
      sql: `select 1 from findings where track_id = ?`,
    });
    expect(finding.rows).toHaveLength(0);
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
    // A certified finding for the same Spotify track — its PK is the BARE id, its uri is set.
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
      tracks: [{ id: "t1", title: "Foo" /* no isrc — must converge on the uri */ }],
    });

    const result = await probeLabelReleases();

    expect(result.newRows).toBe(0);
    // The finding's `spotify_uri` is caught by the pre-fetch filter, so the tap never even fetches
    // the album's tracks — the cheapest possible convergence.
    expect(spotify.calls.some((path) => path.startsWith("/tracks?ids="))).toBe(false);
    // Still exactly one row for this track (the finding), no `sp_t1` twin.
    const rows = await db.execute("select track_id from tracks where track_id in ('t1','sp_t1')");
    expect(rows.rows.map((row) => row.track_id)).toEqual(["t1"]);
  });

  it("skips a no-ISRC track that title-folds to an existing row on the SAME album", async () => {
    await seedEnabledLabel(db, { id: "lbl_1", name: "Medschool", slug: "medschool" });
    await db.execute({
      args: ["alb_row", "New EP", "new-ep", new Date().toISOString(), new Date().toISOString()],
      sql: `insert into albums (id, name, slug, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    });
    // An MB-crawled track on that album, NO ISRC, and no spotify anchor.
    await db.execute({
      args: ["mb_existing", "Foo", JSON.stringify(["Artist"]), 270_000, "alb_row"],
      sql: `insert into tracks (track_id, title, artists_json, duration_ms, album_id) values (?, ?, ?, ?, ?)`,
    });

    setSpotifyFixture({
      // Same album title → same album_id (slug fold); same track title; NO isrc, DIFFERENT spotify id.
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

    expect(result.newRows).toBe(2); // "foo" and "foovip" fold apart — both minted
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

    // Reset the probe stamp so the second pass is eligible again, and the call log to watch it.
    await db.execute("update labels set label_releases_checked_at = null where slug = 'medschool'");
    spotify.calls = [];
    const second = await probeLabelReleases();

    expect(second.newRows).toBe(0);
    // The second pass never re-fetches the album's tracks — `unmintedSpotifyTrackIds` sees them all
    // already held, so no `/tracks?ids=` call is made for that album.
    expect(spotify.calls.some((path) => path.startsWith("/tracks?ids="))).toBe(false);
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

    const catalogueIds = fresh.sections.flatMap((section) =>
      section.catalogue.map((item) => item.trackId),
    );
    expect(catalogueIds).toContain("sp_t1");
    const findingIds = fresh.sections.flatMap((section) => section.findings);
    expect(findingIds).toHaveLength(0);
  });
});
