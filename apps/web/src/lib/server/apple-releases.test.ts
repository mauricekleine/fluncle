// THE MUSICKIT FRESHNESS TAP (D8), proven against the REAL migrated schema on an in-memory libSQL
// engine (the integration-db harness). The Apple client (`./apple-music`) and the shared breaker
// (`./apple-breaker`) are mocked so a test drives exactly the Apple response it wants and can flip
// the budget/breaker shut; every DB write executes REAL SQL against the REAL schema.
//
// What is pinned here:
//   - the pure parsers (label search, latest-releases, album tracks);
//   - the allowlist gate — only ENABLED seed labels are ever probed;
//   - exact-fold-only label resolution (ambiguous / no-fold → left null, attempt stamped);
//   - the dedupe contract from the Apple side (ISRC, Apple id, same-album title fold) AND the
//     VIP/remix non-merge, plus mint idempotence across two runs;
//   - the breaker/budget short-circuit (no Apple call at all);
//   - the unconfigured no-op (the tap ships dark);
//   - /fresh visibility of a minted row (in-window release_date, the unlit half);
//   - the archive-spelling label invariant (`slugify(tracks.label) = labels.slug`, label_id at the
//     KNOWN seed label — never Apple's spelling).

import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));

// The Apple client — a per-test responder routed by the resource path. `calls` records every path
// so a test can assert WHICH labels were probed (the allowlist gate).
const apple = vi.hoisted(() => ({
  calls: [] as string[],
  respond: (_path: string): unknown => ({ configured: false }),
}));

// The shared Apple breaker/meter — default allowed + budget available + record a no-op, so a test
// is isolated from the breaker unless it deliberately flips one shut.
const breaker = vi.hoisted(() => ({ allowed: true, budget: true }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => holder.db };
});

vi.mock("./apple-music", () => ({
  requestAppleCatalogResource: async (path: string) => {
    apple.calls.push(path);

    return apple.respond(path);
  },
}));

vi.mock("./apple-breaker", () => ({
  areAppleCallsAllowed: async () => breaker.allowed,
  isAppleCallBudgetAvailable: async () => breaker.budget,
  recordAppleAuthOutcome: async () => {},
  recordAppleCall: async () => {},
}));

import { createIntegrationDb, seedCatalogueTrack } from "./integration-db";
import {
  appleReleaseTrackId,
  parseAlbumSongs,
  parseAppleLabelSearch,
  parseLatestReleaseAlbums,
  probeAppleReleases,
} from "./apple-releases";
import { listFreshReleases } from "./fresh";

// ── Fixture builders (the documented Apple JSON:API shapes) ─────────────────────────────────────

function labelSearchBody(labels: Array<{ id: string; name: string }>): unknown {
  return {
    results: {
      "record-labels": {
        data: labels.map((label) => ({
          attributes: { name: label.name },
          id: label.id,
          type: "record-labels",
        })),
      },
    },
  };
}

function latestReleasesBody(albums: Array<{ id: string; name: string }>): unknown {
  return {
    data: [
      {
        id: "any",
        type: "record-labels",
        views: {
          "latest-releases": {
            data: albums.map((album) => ({
              attributes: { name: album.name },
              id: album.id,
              type: "albums",
            })),
          },
        },
      },
    ],
  };
}

type SongFixture = {
  artistName?: string;
  durationMs?: number;
  id: string;
  isrc?: string;
  releaseDate?: string;
  title: string;
  url?: string;
};

function albumTracksBody(songs: SongFixture[]): unknown {
  return {
    data: songs.map((song) => ({
      attributes: {
        artistName: song.artistName ?? "Test Artist",
        durationInMillis: song.durationMs ?? 270_000,
        isrc: song.isrc,
        name: song.title,
        releaseDate: song.releaseDate,
        url: song.url ?? `https://music.apple.com/us/song/${song.id}`,
      },
      id: song.id,
      type: "songs",
    })),
  };
}

/**
 * A per-label Apple fixture: the search returns `searchLabels` (default an exact-fold match), the
 * label's latest-releases view returns `albums`, and each album's tracks return `songsByAlbum[id]`.
 * Routes by resource path — a `search?` → label search, `record-labels/…` → latest releases,
 * `albums/<id>/tracks` → that album's songs.
 */
function setAppleFixture(config: {
  albums?: Array<{ id: string; name: string }>;
  searchLabels?: Array<{ id: string; name: string }>;
  songsByAlbum?: Record<string, SongFixture[]>;
}): void {
  apple.respond = (path: string): unknown => {
    if (path.startsWith("search?")) {
      return { body: labelSearchBody(config.searchLabels ?? []), configured: true, ok: true };
    }

    if (path.startsWith("record-labels/")) {
      return { body: latestReleasesBody(config.albums ?? []), configured: true, ok: true };
    }

    const albumMatch = path.match(/^albums\/([^/]+)\/tracks/);

    if (albumMatch) {
      const albumId = decodeURIComponent(albumMatch[1] ?? "");

      return {
        body: albumTracksBody(config.songsByAlbum?.[albumId] ?? []),
        configured: true,
        ok: true,
      };
    }

    return { configured: false };
  };
}

/** Insert an ENABLED seed label directly (seedLabel defaults to `undecided`). */
async function seedEnabledLabel(
  client: Client,
  label: { appleLabelId?: string; id: string; name: string; slug: string; state?: string },
): Promise<void> {
  const now = new Date().toISOString();

  await client.execute({
    args: [
      label.id,
      label.name,
      label.slug,
      "enabled",
      label.appleLabelId ?? null,
      label.state ?? "pending",
      now,
      now,
    ],
    sql: `insert into labels (id, name, slug, seed_state, apple_label_id, apple_label_state,
                              created_at, updated_at)
          values (?, ?, ?, ?, ?, ?, ?, ?)`,
  });
}

let db: Client;

beforeEach(async () => {
  db = await createIntegrationDb();
  holder.db = db;
  apple.calls = [];
  apple.respond = () => ({ configured: false });
  breaker.allowed = true;
  breaker.budget = true;
});

// ── The pure parsers ────────────────────────────────────────────────────────────────────────────

describe("parseAppleLabelSearch", () => {
  it("reads id + name candidates and drops attribute-less refs", () => {
    const body = {
      results: {
        "record-labels": {
          data: [
            { attributes: { name: "Medschool" }, id: "111", type: "record-labels" },
            { id: "222", type: "record-labels" }, // no attributes → dropped
          ],
        },
      },
    };

    expect(parseAppleLabelSearch(body)).toEqual([{ id: "111", name: "Medschool" }]);
    expect(parseAppleLabelSearch(null)).toEqual([]);
  });
});

describe("parseLatestReleaseAlbums", () => {
  it("reads the latest-releases view's album resources", () => {
    const albums = parseLatestReleaseAlbums(latestReleasesBody([{ id: "a1", name: "New EP" }]));

    expect(albums).toEqual([{ id: "a1", name: "New EP", releaseDate: null }]);
  });
});

describe("parseAlbumSongs", () => {
  it("reads songs directly under data[] with real durations", () => {
    const songs = parseAlbumSongs(
      albumTracksBody([{ durationMs: 300_000, id: "s1", isrc: "GB0000000001", title: "Foo" }]),
    );

    expect(songs).toHaveLength(1);
    expect(songs[0]).toMatchObject({
      durationMs: 300_000,
      isrc: "GB0000000001",
      songId: "s1",
      title: "Foo",
    });
  });
});

// ── The probe ─────────────────────────────────────────────────────────────────────────────────

describe("probeAppleReleases", () => {
  it("is a no-op until the MusicKit secrets are provisioned (configured:false)", async () => {
    await seedEnabledLabel(db, { id: "lbl_1", name: "Medschool", slug: "medschool" });
    // The default responder returns { configured: false } for every call.

    const result = await probeAppleReleases();

    expect(result.configured).toBe(false);
    expect(result.newRows).toBe(0);
    const count = await db.execute("select count(*) as n from tracks");
    expect(Number(count.rows[0]?.n)).toBe(0);
  });

  it("probes ONLY enabled seed labels (the allowlist gate)", async () => {
    await seedEnabledLabel(db, { id: "lbl_en", name: "Medschool", slug: "medschool" });
    // A disabled and an undecided label — never probed.
    const now = new Date().toISOString();
    await db.execute({
      args: ["lbl_dis", "Disabled Co", "disabled-co", "disabled", now, now],
      sql: `insert into labels (id, name, slug, seed_state, created_at, updated_at) values (?, ?, ?, ?, ?, ?)`,
    });
    await db.execute({
      args: ["lbl_und", "Undecided Co", "undecided-co", "undecided", now, now],
      sql: `insert into labels (id, name, slug, seed_state, created_at, updated_at) values (?, ?, ?, ?, ?, ?)`,
    });

    setAppleFixture({
      albums: [{ id: "alb1", name: "New EP" }],
      searchLabels: [{ id: "apple_med", name: "Medschool" }],
      songsByAlbum: { alb1: [{ id: "s1", isrc: "GB0000000001", title: "Foo" }] },
    });

    const result = await probeAppleReleases();

    expect(result.labelsProbed).toBe(1);
    expect(result.newRows).toBe(1);
    // Every search term was the enabled label's name — the disabled/undecided ones never searched.
    const searchCalls = apple.calls.filter((path) => path.startsWith("search?"));
    expect(searchCalls).toHaveLength(1);
    expect(searchCalls[0]).toContain("Medschool");
    expect(searchCalls.join("|")).not.toContain("Disabled");
    expect(searchCalls.join("|")).not.toContain("Undecided");
  });

  it("resolves a label id ONLY on an exact name-fold match, else leaves it null + stamps the attempt", async () => {
    await seedEnabledLabel(db, { id: "lbl_1", name: "Medschool", slug: "medschool" });

    // Search returns a near-but-not-exact label ("Med School Recordings" folds to
    // "medschoolrecordings", not "medschool") → NO match, so nothing is minted.
    setAppleFixture({
      searchLabels: [{ id: "apple_wrong", name: "Med School Recordings" }],
    });

    const result = await probeAppleReleases();

    expect(result.unresolvedLabels).toEqual(["medschool"]);
    expect(result.newRows).toBe(0);
    const row = await db.execute(
      "select apple_label_id, apple_label_state, apple_label_failures from labels where slug = 'medschool'",
    );
    expect(row.rows[0]?.apple_label_id).toBeNull();
    expect(row.rows[0]?.apple_label_state).toBe("pending");
    expect(Number(row.rows[0]?.apple_label_failures)).toBe(1);
  });

  it("mints a valid catalogue row with the ARCHIVE's label spelling + the known label_id", async () => {
    await seedEnabledLabel(db, { id: "lbl_1", name: "Medschool", slug: "medschool" });

    // Apple spells the label differently in its search datum — the mint must use the ARCHIVE's.
    setAppleFixture({
      albums: [{ id: "alb1", name: "New EP" }],
      searchLabels: [{ id: "apple_med", name: "medschool" }],
      songsByAlbum: {
        alb1: [{ id: "s1", isrc: "GB0000000001", releaseDate: "2026-07-18", title: "Foo" }],
      },
    });

    const result = await probeAppleReleases();

    expect(result.newRows).toBe(1);
    const track = await db.execute({
      args: [appleReleaseTrackId("s1")],
      sql: `select track_id, title, label, label_id, isrc, release_date, apple_music_url,
                   capture_status, duration_ms from tracks where track_id = ?`,
    });
    const row = track.rows[0];
    expect(row?.track_id).toBe("ap_s1");
    expect(row?.label).toBe("Medschool"); // the archive's spelling, so slugify(label)=slug
    expect(row?.label_id).toBe("lbl_1"); // the KNOWN seed label, stamped directly
    expect(row?.isrc).toBe("GB0000000001");
    expect(row?.release_date).toBe("2026-07-18");
    expect(row?.apple_music_url).toContain("music.apple.com");
    expect(row?.capture_status).toBe("pending"); // the DDL default landed (never named at insert)
    expect(Number(row?.duration_ms)).toBe(270_000);

    // It is a CATALOGUE row — no findings row.
    const finding = await db.execute({
      args: ["ap_s1"],
      sql: `select 1 from findings where track_id = ?`,
    });
    expect(finding.rows).toHaveLength(0);
  });

  it("skips a song already in the archive by ISRC (MB-first → Apple probe skips)", async () => {
    await seedEnabledLabel(db, { id: "lbl_1", name: "Medschool", slug: "medschool" });
    // An MB-crawled row already holds this ISRC.
    await seedCatalogueTrack(db, { title: "Foo", trackId: "mb_existing" });
    await db.execute({
      args: ["GB0000000001", "mb_existing"],
      sql: `update tracks set isrc = ? where track_id = ?`,
    });

    setAppleFixture({
      albums: [{ id: "alb1", name: "New EP" }],
      searchLabels: [{ id: "apple_med", name: "Medschool" }],
      songsByAlbum: { alb1: [{ id: "s1", isrc: "GB0000000001", title: "Foo" }] },
    });

    const result = await probeAppleReleases();

    expect(result.newRows).toBe(0);
    expect(result.skippedKnown).toBe(1);
    expect(Number((await db.execute("select count(*) as n from tracks")).rows[0]?.n)).toBe(1);
  });

  it("skips a no-ISRC song that title-folds to an existing row on the SAME album (MB-twin convergence)", async () => {
    await seedEnabledLabel(db, { id: "lbl_1", name: "Medschool", slug: "medschool" });
    // Mint an album row and an MB-crawled track on it, carrying NO ISRC.
    await db.execute({
      args: ["alb_row", "New EP", "new-ep", new Date().toISOString(), new Date().toISOString()],
      sql: `insert into albums (id, name, slug, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    });
    await seedCatalogueTrack(db, { title: "Foo", trackId: "mb_existing" });
    await db.execute({
      args: ["alb_row", "mb_existing"],
      sql: `update tracks set album_id = ?, isrc = null where track_id = ?`,
    });

    // Apple's song for the same album title, same track title, DIVERGENT (missing) ISRC.
    setAppleFixture({
      albums: [{ id: "alb1", name: "New EP" }],
      searchLabels: [{ id: "apple_med", name: "Medschool" }],
      songsByAlbum: { alb1: [{ id: "s1", title: "Foo" /* no isrc */ }] },
    });

    const result = await probeAppleReleases();

    expect(result.newRows).toBe(0);
    expect(result.skippedKnown).toBe(1);
  });

  it("does NOT merge a VIP/remix (a different title) on the same album", async () => {
    await seedEnabledLabel(db, { id: "lbl_1", name: "Medschool", slug: "medschool" });

    setAppleFixture({
      albums: [{ id: "alb1", name: "New EP" }],
      searchLabels: [{ id: "apple_med", name: "Medschool" }],
      songsByAlbum: {
        alb1: [
          { id: "s1", title: "Foo" },
          { id: "s2", title: "Foo VIP" },
        ],
      },
    });

    const result = await probeAppleReleases();

    expect(result.newRows).toBe(2); // "foo" and "foovip" fold apart — both minted
    expect(result.skippedKnown).toBe(0);
  });

  it("is idempotent across two runs (the ap_ id dedupe)", async () => {
    await seedEnabledLabel(db, { id: "lbl_1", name: "Medschool", slug: "medschool" });
    setAppleFixture({
      albums: [{ id: "alb1", name: "New EP" }],
      searchLabels: [{ id: "apple_med", name: "Medschool" }],
      songsByAlbum: { alb1: [{ id: "s1", isrc: "GB0000000001", title: "Foo" }] },
    });

    const first = await probeAppleReleases();
    expect(first.newRows).toBe(1);

    // Reset the label's probe stamp so the second pass is eligible again.
    await db.execute("update labels set apple_releases_checked_at = null where slug = 'medschool'");
    const second = await probeAppleReleases();

    expect(second.newRows).toBe(0);
    expect(second.skippedKnown).toBe(1);
    expect(Number((await db.execute("select count(*) as n from tracks")).rows[0]?.n)).toBe(1);
  });

  it("short-circuits with no Apple call when the breaker is tripped", async () => {
    await seedEnabledLabel(db, { id: "lbl_1", name: "Medschool", slug: "medschool" });
    setAppleFixture({ searchLabels: [{ id: "apple_med", name: "Medschool" }] });
    breaker.allowed = false;

    const result = await probeAppleReleases();

    expect(result.breakerTripped).toBe(true);
    expect(apple.calls).toHaveLength(0);
    expect(result.newRows).toBe(0);
  });

  it("short-circuits with no Apple call when the shared call budget is spent", async () => {
    await seedEnabledLabel(db, { id: "lbl_1", name: "Medschool", slug: "medschool" });
    setAppleFixture({ searchLabels: [{ id: "apple_med", name: "Medschool" }] });
    breaker.budget = false;

    const result = await probeAppleReleases();

    expect(result.breakerTripped).toBe(true);
    expect(apple.calls).toHaveLength(0);
  });

  it("a minted row shows on /fresh in the unlit (catalogue) half", async () => {
    await seedEnabledLabel(db, { id: "lbl_1", name: "Medschool", slug: "medschool" });
    const now = new Date("2026-07-19T12:00:00Z");
    const releaseDay = "2026-07-18"; // one day ago — inside the 30-day window

    setAppleFixture({
      albums: [{ id: "alb1", name: "New EP" }],
      searchLabels: [{ id: "apple_med", name: "Medschool" }],
      songsByAlbum: {
        alb1: [{ id: "s1", isrc: "GB0000000001", releaseDate: releaseDay, title: "Foo" }],
      },
    });

    await probeAppleReleases();
    const fresh = await listFreshReleases(now);

    const catalogueIds = fresh.sections.flatMap((section) =>
      section.catalogue.map((item) => item.trackId),
    );
    expect(catalogueIds).toContain("ap_s1");
    // It never reads as a finding — the lit half (findings) stays empty (no certification).
    const findingIds = fresh.sections.flatMap((section) => section.findings);
    expect(findingIds).toHaveLength(0);
  });
});
