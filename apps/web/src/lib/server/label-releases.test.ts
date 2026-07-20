// THE FRESHNESS TAP (D8), proven against the REAL migrated schema on an in-memory libSQL engine
// (the integration-db harness). The tap moved OFF the official Spotify app onto the Apify actor
// (the anchor-sweep model): the BOX runs the actor and POSTs candidate albums; the WORKER re-runs the
// gate + mint. So there is NO Spotify client on this path — every write here executes REAL SQL against
// the REAL schema, and the module NEVER imports `./spotify` (the whole point of the move).
//
// What is pinned here:
//   - the pure copyright helpers (strip prefix, exact-fold match);
//   - `labelAttributionSignal` — the strong `album_label` field, the `album_copyright` fallback, and
//     the NO-signal case (the actor's grounding-only `albums`-search mode);
//   - `mintLabelReleases` — the verify+mint receiver: the enabled-seed gate, artist-grounding, label
//     attribution (present ⇒ must match; absent ⇒ grounding alone), the dedupe contract (Spotify id /
//     uri / ISRC / same-album title fold), the VIP/remix non-merge, mint idempotence, the cadence
//     stamp, and the archive-spelling label invariant (`slugify(tracks.label) = labels.slug`);
//   - `listDueFreshnessLabels` — the worklist read (enabled + due, oldest first);
//   - /fresh visibility of a minted row (in-window release_date, the unlit half).

import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => holder.db };
});

import { listFreshReleases } from "./fresh";
import { createIntegrationDb, seedCatalogueTrack, seedTrack } from "./integration-db";
import {
  copyrightMatchesLabel,
  type LabelReleaseAlbumCandidate,
  labelAttributionSignal,
  labelReleaseTrackId,
  listDueFreshnessLabels,
  mintLabelReleases,
  stripCopyrightPrefix,
} from "./label-releases";

// The Spotify artist id seeded into `artists` in beforeEach — the default grounding for a mint.
const KNOWN_ARTIST_ID = "sp_artist_known";

/** Build one candidate album in the shape the box POSTs (the actor's mapped output). */
function album(config: {
  artistIds?: string[];
  copyright?: null | string;
  id?: string;
  label?: null | string;
  name?: string;
  releaseDate?: string;
  tracks: { durationMs?: number; id: string; isrc?: string; title: string }[];
}): LabelReleaseAlbumCandidate {
  return {
    albumCopyright: config.copyright ?? null,
    albumId: config.id ?? "alb1",
    albumLabel: config.label ?? null,
    albumName: config.name ?? "New EP",
    artists: (config.artistIds ?? [KNOWN_ARTIST_ID]).map((id) => ({ id, name: "Some Artist" })),
    releaseDate: config.releaseDate ?? "2026-07-19",
    tracks: config.tracks.map((track) => ({
      durationMs: track.durationMs ?? 270_000,
      isrc: track.isrc ?? null,
      spotifyTrackId: track.id,
      title: track.title,
      uri: `spotify:track:${track.id}`,
      url: `https://open.spotify.com/track/${track.id}`,
    })),
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
  // The default grounding: a known artist whose Spotify id every un-overridden album claims, so a
  // candidate is grounded unless it deliberately names an UNKNOWN artist.
  await seedArtist(db, KNOWN_ARTIST_ID);
});

// ── The pure copyright helpers ──────────────────────────────────────────────────────────────────

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

describe("copyrightMatchesLabel", () => {
  it("requires EXACT-fold equality on the stripped label portion (not a substring)", () => {
    expect(copyrightMatchesLabel(["℗ 2026 Med School"], "Medschool")).toBe(true);
    expect(copyrightMatchesLabel(["℗ 2026 Hospital Records"], "Hospital Records")).toBe(true);
    // A substring near-match is REJECTED — the whole point of the tightening.
    expect(copyrightMatchesLabel(["℗ 2026 Silent Lens"], "Lens")).toBe(false);
    expect(copyrightMatchesLabel(["℗ 2026 Med School Recordings"], "Medschool")).toBe(false);
    expect(copyrightMatchesLabel([], "Hospital Records")).toBe(false);
  });
});

describe("labelAttributionSignal", () => {
  it("uses album_label FIRST (exact fold), the strong signal", () => {
    expect(labelAttributionSignal({ albumLabel: "Med School" }, "Medschool")).toEqual({
      matches: true,
      present: true,
    });
    expect(labelAttributionSignal({ albumLabel: "Silent Lens" }, "Lens")).toEqual({
      matches: false,
      present: true,
    });
  });

  it("falls back to album_copyright when album_label is absent", () => {
    expect(
      labelAttributionSignal({ albumCopyright: "℗ 2026 Hospital Records" }, "Hospital Records"),
    ).toEqual({ matches: true, present: true });
    expect(
      labelAttributionSignal({ albumCopyright: "℗ 2026 Some Other Label" }, "Hospital Records"),
    ).toEqual({ matches: false, present: true });
  });

  it("reports NO signal when both are null — the actor's grounding-only albums-search mode", () => {
    expect(labelAttributionSignal({ albumCopyright: null, albumLabel: null }, "Medschool")).toEqual(
      {
        matches: false,
        present: false,
      },
    );
  });
});

// ── The verify + mint receiver ──────────────────────────────────────────────────────────────────

describe("mintLabelReleases", () => {
  it("is a no-op (found:false) when the slug is not an ENABLED seed label — nothing minted or stamped", async () => {
    const now = new Date().toISOString();
    await db.execute({
      args: ["lbl_dis", "Disabled Co", "disabled-co", "disabled", now, now],
      sql: `insert into labels (id, name, slug, seed_state, created_at, updated_at) values (?, ?, ?, ?, ?, ?)`,
    });

    const result = await mintLabelReleases("disabled-co", [
      album({ tracks: [{ id: "t1", isrc: "GB0000000001", title: "Foo" }] }),
    ]);

    expect(result.found).toBe(false);
    expect(result.newRows).toBe(0);
    expect(Number((await db.execute("select count(*) as n from tracks")).rows[0]?.n)).toBe(0);
    const stamp = await db.execute(
      "select label_releases_checked_at from labels where slug = 'disabled-co'",
    );
    expect(stamp.rows[0]?.label_releases_checked_at).toBeNull();
  });

  it("mints a KNOWN-artist album but SKIPS an unknown-artist one (artist-grounding)", async () => {
    await seedEnabledLabel(db, { id: "lbl_1", name: "Medschool", slug: "medschool" });

    const result = await mintLabelReleases("medschool", [
      album({
        artistIds: [KNOWN_ARTIST_ID], // grounded → MINTS
        id: "grounded",
        tracks: [{ id: "t_known", isrc: "GB0000000001", title: "Real Track" }],
      }),
      album({
        artistIds: ["sp_artist_unknown"], // absent from `artists` → SKIPPED
        id: "ungrounded",
        tracks: [{ id: "t_new", isrc: "GB0000000002", title: "Debut" }],
      }),
    ]);

    expect(result.albumsMatched).toBe(1);
    expect(result.skippedUngrounded).toBe(1);
    expect(result.newRows).toBe(1);
    expect(result.newTrackIds).toEqual(["sp_t_known"]);
    const un = await db.execute("select 1 from tracks where track_id = 'sp_t_new'");
    expect(un.rows).toHaveLength(0);
  });

  it("SKIPS the homonym case — a copyright that folds to the seed name but all artists unknown", async () => {
    await seedEnabledLabel(db, { id: "lbl_1", name: "Earth Records", slug: "earth-records" });

    const result = await mintLabelReleases("earth-records", [
      album({
        artistIds: ["sp_artist_devotional"], // none in our archive
        copyright: "℗ 2026 Earth Records", // exact-fold match on the homonym
        name: "Bhajans Vol 3",
        tracks: [{ id: "t_junk", isrc: "IN0000000001", title: "Bhola Baba" }],
      }),
    ]);

    expect(result.skippedUngrounded).toBe(1);
    expect(result.albumsMatched).toBe(0);
    expect(result.newRows).toBe(0);
    expect(Number((await db.execute("select count(*) as n from tracks")).rows[0]?.n)).toBe(0);
  });

  it("DROPS a grounded album whose album_label signal does NOT fold-match the seed (skippedUnattributed)", async () => {
    await seedEnabledLabel(db, { id: "lbl_1", name: "Medschool", slug: "medschool" });

    const result = await mintLabelReleases("medschool", [
      album({
        artistIds: [KNOWN_ARTIST_ID], // grounded
        label: "Some Other Label", // but the actor's label field says otherwise → DROP
        tracks: [{ id: "t1", isrc: "GB0000000001", title: "Foo" }],
      }),
    ]);

    expect(result.skippedUnattributed).toBe(1);
    expect(result.albumsMatched).toBe(0);
    expect(result.newRows).toBe(0);
  });

  it("mints a grounded album whose album_label DOES fold-match the seed (the upgrade path)", async () => {
    await seedEnabledLabel(db, { id: "lbl_1", name: "Medschool", slug: "medschool" });

    const result = await mintLabelReleases("medschool", [
      album({
        label: "Med School", // folds to "medschool" → attributed
        tracks: [{ id: "t1", isrc: "GB0000000001", title: "Foo" }],
      }),
    ]);

    expect(result.albumsMatched).toBe(1);
    expect(result.skippedUnattributed).toBe(0);
    expect(result.newRows).toBe(1);
  });

  it("mints on artist-grounding ALONE when the actor gave no label signal (the albums-search mode)", async () => {
    await seedEnabledLabel(db, { id: "lbl_1", name: "Medschool", slug: "medschool" });

    const result = await mintLabelReleases("medschool", [
      album({ tracks: [{ id: "t1", isrc: "GB0000000001", title: "Foo" }] }), // label + copyright null
    ]);

    expect(result.albumsMatched).toBe(1);
    expect(result.newRows).toBe(1);
  });

  it("mints a valid catalogue row with the ARCHIVE's label spelling, the anchor, and the day-one date", async () => {
    await seedEnabledLabel(db, { id: "lbl_1", name: "Medschool", slug: "medschool" });

    const result = await mintLabelReleases("medschool", [
      album({
        name: "New EP",
        releaseDate: "2026-07-18",
        tracks: [{ id: "t1", isrc: "GB0000000001", title: "Foo" }],
      }),
    ]);

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

    // The probe cadence was stamped so the worklist backs the label off.
    const stamp = await db.execute(
      "select label_releases_checked_at from labels where slug = 'medschool'",
    );
    expect(stamp.rows[0]?.label_releases_checked_at).not.toBeNull();
  });

  it("skips a track already in the archive by ISRC (an MB-first row → the tap skips)", async () => {
    await seedEnabledLabel(db, { id: "lbl_1", name: "Medschool", slug: "medschool" });
    await seedCatalogueTrack(db, { title: "Foo", trackId: "mb_existing" });
    await db.execute({
      args: ["GB0000000001", "mb_existing"],
      sql: `update tracks set isrc = ? where track_id = ?`,
    });

    const result = await mintLabelReleases("medschool", [
      album({ tracks: [{ id: "t1", isrc: "GB0000000001", title: "Foo" }] }),
    ]);

    expect(result.newRows).toBe(0);
    expect(result.skippedKnown).toBe(1);
    expect(Number((await db.execute("select count(*) as n from tracks")).rows[0]?.n)).toBe(1);
  });

  it("skips a track a CERTIFIED finding already holds by its spotify_uri (never a duplicate anchor)", async () => {
    await seedEnabledLabel(db, { id: "lbl_1", name: "Medschool", slug: "medschool" });
    // A certified finding for the same Spotify track — its PK is the BARE id, its uri is set.
    await seedTrack(db, { logId: "AAA.01.01", title: "Foo", trackId: "t1" });

    const result = await mintLabelReleases("medschool", [
      album({ tracks: [{ id: "t1", title: "Foo" /* no isrc — must converge on the uri */ }] }),
    ]);

    expect(result.newRows).toBe(0);
    expect(result.skippedKnown).toBe(1);
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
    // An MB-crawled track on that album, NO ISRC, no spotify anchor.
    await db.execute({
      args: ["mb_existing", "Foo", JSON.stringify(["Artist"]), 270_000, "alb_row"],
      sql: `insert into tracks (track_id, title, artists_json, duration_ms, album_id) values (?, ?, ?, ?, ?)`,
    });

    const result = await mintLabelReleases("medschool", [
      // Same album title → same album_id (slug fold); same track title; NO isrc, DIFFERENT spotify id.
      album({ name: "New EP", tracks: [{ id: "t_new", title: "Foo" }] }),
    ]);

    expect(result.newRows).toBe(0);
    expect(result.skippedKnown).toBe(1);
  });

  it("does NOT merge a VIP/remix (a different title) on the same album", async () => {
    await seedEnabledLabel(db, { id: "lbl_1", name: "Medschool", slug: "medschool" });

    const result = await mintLabelReleases("medschool", [
      album({
        tracks: [
          { id: "t1", title: "Foo" },
          { id: "t2", title: "Foo VIP" },
        ],
      }),
    ]);

    expect(result.newRows).toBe(2); // "foo" and "foovip" fold apart — both minted
    expect(result.skippedKnown).toBe(0);
  });

  it("is idempotent across two POSTs of the same album (the sp_ id + uri dedupe)", async () => {
    await seedEnabledLabel(db, { id: "lbl_1", name: "Medschool", slug: "medschool" });
    const candidates = [album({ tracks: [{ id: "t1", isrc: "GB0000000001", title: "Foo" }] })];

    const first = await mintLabelReleases("medschool", candidates);
    expect(first.newRows).toBe(1);

    const second = await mintLabelReleases("medschool", candidates);
    expect(second.newRows).toBe(0);
    expect(second.skippedKnown).toBe(1);
    expect(Number((await db.execute("select count(*) as n from tracks")).rows[0]?.n)).toBe(1);
  });

  it("a minted row shows on /fresh in the unlit (catalogue) half", async () => {
    await seedEnabledLabel(db, { id: "lbl_1", name: "Medschool", slug: "medschool" });
    const now = new Date("2026-07-20T12:00:00Z");

    await mintLabelReleases("medschool", [
      album({
        releaseDate: "2026-07-18",
        tracks: [{ id: "t1", isrc: "GB0000000001", title: "Foo" }],
      }),
    ]);
    const fresh = await listFreshReleases(now);

    const catalogueIds = fresh.sections.flatMap((section) =>
      section.catalogue.map((item) => item.trackId),
    );
    expect(catalogueIds).toContain("sp_t1");
    const findingIds = fresh.sections.flatMap((section) => section.findings);
    expect(findingIds).toHaveLength(0);
  });
});

// ── The worklist read ───────────────────────────────────────────────────────────────────────────

describe("listDueFreshnessLabels", () => {
  it("returns ONLY enabled seed labels, oldest-probe-stamp first, and excludes recently-probed ones", async () => {
    const now = Date.now();
    const iso = (ms: number) => new Date(now - ms).toISOString();
    const hour = 60 * 60 * 1000;

    // enabled + never probed (due, sorts first on NULL), enabled + stale (due), enabled + fresh
    // (NOT due), and a disabled label (never in the worklist).
    await seedEnabledLabel(db, { id: "l_never", name: "Never Probed", slug: "never" });
    await db.execute({
      args: ["l_stale", "Stale", "stale", "enabled", iso(30 * hour), iso(0), iso(30 * hour)],
      sql: `insert into labels (id, name, slug, seed_state, created_at, updated_at, label_releases_checked_at)
            values (?, ?, ?, ?, ?, ?, ?)`,
    });
    await db.execute({
      args: ["l_fresh", "Fresh", "fresh", "enabled", iso(hour), iso(0), iso(hour)],
      sql: `insert into labels (id, name, slug, seed_state, created_at, updated_at, label_releases_checked_at)
            values (?, ?, ?, ?, ?, ?, ?)`,
    });
    await db.execute({
      args: ["l_dis", "Disabled", "disabled", "disabled", iso(0), iso(0)],
      sql: `insert into labels (id, name, slug, seed_state, created_at, updated_at) values (?, ?, ?, ?, ?, ?)`,
    });

    const due = await listDueFreshnessLabels(50);
    const slugs = due.map((label) => label.slug);

    expect(slugs).toContain("never");
    expect(slugs).toContain("stale");
    expect(slugs).not.toContain("fresh"); // probed within the re-probe window
    expect(slugs).not.toContain("disabled"); // not an enabled seed label
    // Never-probed (NULL stamp) sorts ahead of the stale one, and each carries its name.
    expect(slugs.indexOf("never")).toBeLessThan(slugs.indexOf("stale"));
    expect(due.find((label) => label.slug === "never")?.name).toBe("Never Probed");
  });

  it("caps the result at the requested limit", async () => {
    await seedEnabledLabel(db, { id: "l1", name: "One", slug: "one" });
    await seedEnabledLabel(db, { id: "l2", name: "Two", slug: "two" });
    await seedEnabledLabel(db, { id: "l3", name: "Three", slug: "three" });

    expect(await listDueFreshnessLabels(2)).toHaveLength(2);
  });
});
