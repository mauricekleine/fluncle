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

// The Spotify client mock's mutable state: a per-test responder routed by path, the grant switch, a
// throw switch (429 / other), and a per-path failure predicate (a single read that 404/5xx's).
// `calls` records every path so a test can assert WHICH endpoints were hit (the tier contract).
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
} from "./label-releases";
import { listFreshReleases } from "./fresh";

// ── Fixture builders (the Spotify JSON shapes) ──────────────────────────────────────────────────

type AlbumFixture = {
  /** The album's Spotify artist ids (the ARTIST-GROUNDING key). Defaults to the seeded known
   *  artist, so a minting fixture is grounded unless it deliberately names an UNKNOWN artist. */
  artistIds?: string[];
  copyrights: string[];
  id: string;
  name: string;
  releaseDate: string;
  trackIds: string[];
};

/** The Spotify artist id seeded into `artists` in beforeEach — the default grounding for a mint. */
const KNOWN_ARTIST_ID = "sp_artist_known";

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

/** The SINGLE-album response (`GET /albums/{id}`) — the album object is the top-level body. Carries
 *  `artists[].id` (the grounding key), defaulting to the seeded known artist. */
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

/** The SINGLE-track response (`GET /tracks/{id}`) — the track object is the top-level body. */
function trackBody(track: TrackFixture): unknown {
  return {
    artists: (track.artistNames ?? ["Test Artist"]).map((name) => ({ name })),
    duration_ms: track.durationMs ?? 270_000,
    external_ids: track.isrc ? { isrc: track.isrc } : {},
    external_urls: { spotify: `https://open.spotify.com/track/${track.id}` },
    id: track.id,
    name: track.title,
    uri: `spotify:track:${track.id}`,
  };
}

/** The trailing `{id}` path segment of a single-resource read (`/albums/{id}` → `id`). */
function idSegment(path: string): string {
  return decodeURIComponent((path.split("?")[0] ?? "").split("/").pop() ?? "");
}

/**
 * A per-label Spotify fixture: the search returns `searchAlbumIds`; each `GET /albums/{id}` returns
 * that one album; each `GET /tracks/{id}` returns that one track. SINGLES only — the batch endpoints
 * are 403 at our tier and are never called. An unknown id returns `{}` (parses to null).
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

/** Insert an artist carrying a `spotify_artist_id` — the grounding key. */
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

let db: Client;

beforeEach(async () => {
  db = await createIntegrationDb();
  holder.db = db;
  // The default grounding: a known artist whose Spotify id every un-overridden album fixture claims,
  // so a minting fixture is grounded unless it deliberately names an UNKNOWN artist.
  await seedArtist(db, KNOWN_ARTIST_ID);
  spotify.calls = [];
  spotify.grantGone = false;
  spotify.throwKind = null;
  spotify.failPath = () => false;
  spotify.respond = () => ({});
});

// ── The pure parsers + the post-filter ──────────────────────────────────────────────────────────

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
    expect(stripCopyrightPrefix("© ℗ 2026 Bar")).toBe("Bar"); // repeated symbols
    expect(stripCopyrightPrefix("2026 Baz")).toBe("Baz"); // year, no symbol
    // A label whose own name starts with a number keeps it (only ONE leading year is peeled).
    expect(stripCopyrightPrefix("℗ 2026 1985 Music")).toBe("1985 Music");
  });
});

describe("parseProbeTrack", () => {
  it("reads ISRC + duration + uri/url + artists off a SINGLE track body", () => {
    const track = parseProbeTrack(
      trackBody({ durationMs: 300_000, id: "t1", isrc: "GB0000000001", title: "Foo" }),
    );

    expect(track).toMatchObject({
      durationMs: 300_000,
      isrc: "GB0000000001",
      spotifyTrackId: "t1",
      spotifyUri: "spotify:track:t1",
      title: "Foo",
    });
    expect(parseProbeTrack(null)).toBeNull();
    expect(parseProbeTrack({ id: "t1" })).toBeNull(); // no name
  });
});

describe("copyrightMatchesLabel", () => {
  it("requires EXACT-fold equality on the stripped label portion (not a substring)", () => {
    // Exact attribution → match (fold absorbs the space + case).
    expect(copyrightMatchesLabel(["℗ 2026 Med School"], "Medschool")).toBe(true);
    expect(copyrightMatchesLabel(["℗ 2026 Hospital Records"], "Hospital Records")).toBe(true);
    // A substring near-match is REJECTED — the whole point of the tightening.
    expect(copyrightMatchesLabel(["℗ 2026 Silent Lens"], "Lens")).toBe(false);
    // A longer real-label variant no longer sneaks through the loose substring match.
    expect(copyrightMatchesLabel(["℗ 2026 Med School Recordings"], "Medschool")).toBe(false);
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

  it("mints a KNOWN-artist album but SKIPS an unknown-artist one on the SAME label (grounding)", async () => {
    await seedEnabledLabel(db, { id: "lbl_1", name: "Medschool", slug: "medschool" });

    setSpotifyFixture({
      albums: [
        // Both albums carry the EXACT copyright — the difference is ONLY the artist grounding.
        {
          artistIds: [KNOWN_ARTIST_ID], // an artist we already hold → grounded → MINTS
          copyrights: ["℗ 2026 Medschool"],
          id: "grounded",
          name: "Real EP",
          releaseDate: "2026-07-19",
          trackIds: ["t_known"],
        },
        {
          artistIds: ["sp_artist_unknown"], // an artist absent from `artists` → SKIPPED
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

    expect(result.albumsMatched).toBe(1); // only the grounded album will mint
    expect(result.skippedUngrounded).toBe(1); // the unknown-artist album, dropped + counted
    expect(result.newRows).toBe(1);
    expect(result.newTrackIds).toEqual(["sp_t_known"]);
    // The ungrounded album's track is NEVER minted, and its tracks are never even fetched.
    const un = await db.execute("select 1 from tracks where track_id = 'sp_t_new'");
    expect(un.rows).toHaveLength(0);
    expect(spotify.calls.some((path) => path.includes("t_new"))).toBe(false);
  });

  it("SKIPS the homonym case — right label NAME, but all artists unknown (cross-genre junk)", async () => {
    // "Earth Records" is a real seed label; a DIFFERENT "Earth Records" exists globally, whose
    // copyright fold-EQUALS the seed name — so copyright alone would let its cross-genre releases in.
    // Grounding (unknown artists) is what rejects them.
    await seedEnabledLabel(db, { id: "lbl_1", name: "Earth Records", slug: "earth-records" });

    setSpotifyFixture({
      albums: [
        {
          artistIds: ["sp_artist_devotional", "sp_artist_folk"], // none in our archive
          copyrights: ["℗ 2026 Earth Records"], // exact-fold match on the homonym
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

    // The batch endpoints are GONE at our tier — the probe must never call them.
    expect(spotify.calls.some((path) => path.startsWith("/albums?ids="))).toBe(false);
    expect(spotify.calls.some((path) => path.startsWith("/tracks?ids="))).toBe(false);
    // It DID hit the single reads.
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
        // `bad` is in the search results but its single read 404s.
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

    expect(result.failedFetches).toBe(1); // the `bad` album read, skipped
    expect(result.failedLabels).toEqual([]); // NOT a label failure — the search succeeded
    expect(result.newRows).toBe(1); // the `good` album still minted
    expect(result.newTrackIds).toEqual(["sp_t1"]);
    // The label WAS stamped (a per-album miss does not hold the whole label back).
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
          copyrights: ["℗ 2026 Med School"], // strips to "Med School" → fold-equals "Medschool"
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
    expect(spotify.calls.some((path) => path.startsWith("/tracks/"))).toBe(false);
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
    // already held, so no `/tracks/{id}` call is made for that album.
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

    const catalogueIds = fresh.sections.flatMap((section) =>
      section.catalogue.map((item) => item.trackId),
    );
    expect(catalogueIds).toContain("sp_t1");
    const findingIds = fresh.sections.flatMap((section) => section.findings);
    expect(findingIds).toHaveLength(0);
  });
});
