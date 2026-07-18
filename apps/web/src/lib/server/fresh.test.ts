// `/fresh` — the new-releases read, proven against the REAL migrated schema on an in-memory
// libSQL engine (the catalogue-groups.test.ts harness). What is easy to get wrong here and
// impossible to see without a DB:
//
//   1. THE WINDOW. Only tracks RELEASED in the trailing 30 days appear — an older release is
//      out, and a FUTURE-dated pre-order is out (it has not come out yet).
//   2. THE REGISTER SPLIT. A certified finding lands in `findings` (full voice); an uncertified
//      row lands in `catalogue` (unlit). No catalogue row ever carries a coordinate.
//   3. THE RECENCY BUCKET. A release inside 7 days is "This week"; 7–30 days is "Earlier".
//   4. THE RECORDS. An album entity a fresh release sits on surfaces once, newest first, with a
//      `/album/<slug>` slug.

import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => holder.db };
});

import {
  freshRecordCovers,
  freshStream,
  freshTrackWindowRecordCovers,
} from "@/components/fresh/data";
import { createIntegrationDb } from "./integration-db";
import {
  FRESH_RECORDS_WINDOW_DAYS,
  FRESH_WINDOW_DAYS,
  listFreshReleases,
  listFreshTracks,
} from "./fresh";

// A fixed clock so the window boundaries are deterministic. Relative to this NOW:
//   weekStart = 2026-07-10, windowStart = 2026-06-17, today = 2026-07-17.
const NOW = new Date("2026-07-17T12:00:00.000Z");

let db: Client;

/** A crawled (uncertified) track: a `tracks` row with no `findings` row. */
async function seedCatalogueTrack(options: {
  albumId?: string;
  albumImageUrl?: string;
  artists: string[];
  releaseDate: null | string;
  trackId: string;
}): Promise<void> {
  await db.execute({
    args: [
      options.trackId,
      `Title ${options.trackId}`,
      JSON.stringify(options.artists),
      options.releaseDate,
      options.albumId ?? null,
      `https://open.spotify.com/track/${options.trackId}`,
      options.albumImageUrl ?? null,
    ],
    sql: `insert into tracks
            (track_id, title, artists_json, release_date, album_id, spotify_url, album_image_url, duration_ms)
          values (?, ?, ?, ?, ?, ?, ?, 210000)`,
  });
}

/** A certified finding: a `tracks` row (carrying the release date) PLUS a `findings` row. */
async function seedFinding(options: {
  artists: string[];
  logId: string;
  releaseDate: string;
  trackId: string;
}): Promise<void> {
  await db.execute({
    args: [
      options.trackId,
      `Title ${options.trackId}`,
      JSON.stringify(options.artists),
      options.releaseDate,
      `https://open.spotify.com/track/${options.trackId}`,
    ],
    sql: `insert into tracks (track_id, title, artists_json, release_date, spotify_url, duration_ms)
          values (?, ?, ?, ?, ?, 210000)`,
  });
  await db.execute({
    args: [options.trackId, options.logId],
    sql: `insert into findings (track_id, log_id, added_at)
          values (?, ?, '2020-01-01T00:00:00.000Z')`,
  });
}

beforeEach(async () => {
  db = await createIntegrationDb();
  holder.db = db;
});

describe("listFreshReleases", () => {
  it("splits the window into lit findings and unlit catalogue, bucketed by recency", async () => {
    await seedFinding({
      artists: ["Dimension"],
      logId: "200.7.1A",
      releaseDate: "2026-07-15", // this week
      trackId: "f_week",
    });
    await seedFinding({
      artists: ["Calibre"],
      logId: "201.7.2B",
      releaseDate: "2026-06-25", // earlier this month
      trackId: "f_earlier",
    });
    await seedCatalogueTrack({
      artists: ["Nu:Tone"],
      releaseDate: "2026-07-12", // this week
      trackId: "c_week",
    });
    await seedCatalogueTrack({
      artists: ["Lenzman"],
      releaseDate: "2026-06-20", // earlier this month
      trackId: "c_earlier",
    });

    const { sections, windowDays } = await listFreshReleases(NOW);

    expect(windowDays).toBe(FRESH_WINDOW_DAYS);
    expect(sections.map((section) => section.key)).toEqual(["week", "earlier"]);

    const week = sections.find((section) => section.key === "week");
    const earlier = sections.find((section) => section.key === "earlier");

    expect(week?.findings.map((finding) => finding.trackId)).toEqual(["f_week"]);
    expect(week?.catalogue.map((track) => track.trackId)).toEqual(["c_week"]);
    expect(earlier?.findings.map((finding) => finding.trackId)).toEqual(["f_earlier"]);
    expect(earlier?.catalogue.map((track) => track.trackId)).toEqual(["c_earlier"]);

    // THE RAIL: a finding carries its coordinate; not one unlit row does, so none can pose as one.
    expect(week?.findings.every((finding) => Boolean(finding.logId))).toBe(true);
    const everyCatalogue = sections.flatMap((section) => section.catalogue);
    expect(everyCatalogue.every((track) => !("logId" in track))).toBe(true);
  });

  it("excludes an older release and a future-dated pre-order", async () => {
    await seedFinding({
      artists: ["Old"],
      logId: "100.1.1A",
      releaseDate: "2026-05-01", // ~2.5 months back — outside the 30-day window
      trackId: "f_old",
    });
    await seedCatalogueTrack({
      artists: ["Preorder"],
      releaseDate: "2026-08-01", // future — not out yet
      trackId: "c_future",
    });
    await seedFinding({
      artists: ["Fresh"],
      logId: "202.7.3C",
      releaseDate: "2026-07-16",
      trackId: "f_in",
    });

    const { sections } = await listFreshReleases(NOW);
    const trackIds = sections.flatMap((section) => [
      ...section.findings.map((finding) => finding.trackId),
      ...section.catalogue.map((track) => track.trackId),
    ]);

    expect(trackIds).toEqual(["f_in"]);
  });

  it("renders nothing for a window with no releases (no empty sections)", async () => {
    await seedFinding({
      artists: ["Old"],
      logId: "100.1.1A",
      releaseDate: "2024-01-01",
      trackId: "f_ancient",
    });

    const { records, sections } = await listFreshReleases(NOW);

    expect(sections).toEqual([]);
    expect(records).toEqual([]);
  });

  it("surfaces the album entities a fresh release sits on, newest first", async () => {
    await db.execute({
      args: ["alb_wgf", "Words Gone Forever", "words-gone-forever", "x", "x"],
      sql: `insert into albums (id, name, slug, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    });
    await db.execute({
      args: ["alb_elem", "The Elements", "the-elements", "x", "x"],
      sql: `insert into albums (id, name, slug, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    });
    // Two tracks on the newer record, one on the older — the record surfaces ONCE, its date the
    // newest release on it, and its artists folded distinct across its fresh tracks.
    await seedCatalogueTrack({
      albumId: "alb_wgf",
      albumImageUrl: "https://i.scdn.co/image/wgf-newest",
      artists: ["Nu:Tone"],
      releaseDate: "2026-07-14",
      trackId: "r_wgf1",
    });
    await seedCatalogueTrack({
      albumId: "alb_wgf",
      artists: ["Nu:Tone", "Logistics"],
      releaseDate: "2026-07-13",
      trackId: "r_wgf2",
    });
    await seedCatalogueTrack({
      albumId: "alb_elem",
      artists: ["Calibre"],
      releaseDate: "2026-06-30",
      trackId: "r_elem1",
    });

    const { records } = await listFreshReleases(NOW);

    expect(records.map((record) => record.slug)).toEqual(["words-gone-forever", "the-elements"]);
    const wgf = records[0];

    expect(wgf?.name).toBe("Words Gone Forever");
    expect(wgf?.releaseDate).toBe("2026-07-14");
    expect([...(wgf?.artists ?? [])].sort()).toEqual(["Logistics", "Nu:Tone"]);
    // The record carries a cover: the album art off its NEWEST-released track that has one.
    expect(wgf?.coverImageUrl).toBe("https://i.scdn.co/image/wgf-newest");
  });

  it("attaches the lead artist's avatar to a catalogue row (the row shows WHO, dimmed in the UI)", async () => {
    // A lead artist with a stored image, plus a featured artist without one — the join must pick the
    // LEAD (position 1), never the feature, so the avatar is the right face.
    await db.execute({
      args: ["art_lead", "Workforce", "workforce", "https://i.scdn.co/image/workforce", "x", "x"],
      sql: `insert into artists (id, name, slug, image_url, created_at, updated_at)
            values (?, ?, ?, ?, ?, ?)`,
    });
    await db.execute({
      args: ["art_feat", "Tim Reaper", "tim-reaper", "x", "x"],
      sql: `insert into artists (id, name, slug, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    });
    await seedCatalogueTrack({
      artists: ["Workforce", "Tim Reaper"],
      releaseDate: "2026-07-14",
      trackId: "c_avatar",
    });
    await db.execute({
      args: ["c_avatar", "art_lead"],
      sql: `insert into track_artists (track_id, artist_id, position) values (?, ?, 1)`,
    });
    await db.execute({
      args: ["c_avatar", "art_feat"],
      sql: `insert into track_artists (track_id, artist_id, position) values (?, ?, 2)`,
    });

    const { sections } = await listFreshReleases(NOW);
    const row = sections
      .flatMap((section) => section.catalogue)
      .find((track) => track.trackId === "c_avatar");

    // The lead artist's image (Spotify, no owned master) is the avatar — never the featured artist's.
    expect(row?.artistAvatarUrl).toBe("https://i.scdn.co/image/workforce");
  });

  it("flattens into a capped list, newest release first, unlit rows coordinate-free", async () => {
    // A finding and a catalogue row released the SAME day — the certified finding must lead the tie.
    await seedFinding({
      artists: ["Line25"],
      logId: "049.7.1F",
      releaseDate: "2026-07-15",
      trackId: "flat_f_15",
    });
    await seedCatalogueTrack({
      artists: ["Cataract"],
      releaseDate: "2026-07-15",
      trackId: "flat_c_15",
    });
    // An older release in the window sorts below both.
    await seedCatalogueTrack({
      artists: ["Older"],
      releaseDate: "2026-07-01",
      trackId: "flat_c_01",
    });

    const all = await listFreshTracks({ now: NOW });
    expect(all.tracks.map((track) => track.title)).toEqual([
      "Title flat_f_15",
      "Title flat_c_15",
      "Title flat_c_01",
    ]);

    // The certified finding carries its coordinate; an uncertified row carries NONE (the Unlit Rule).
    const finding = all.tracks[0];
    expect(finding?.certified).toBe(true);
    expect(finding?.logId).toBe("049.7.1F");
    const unlit = all.tracks[1];
    expect(unlit?.certified).toBe(false);
    expect(unlit?.logId).toBeUndefined();
    expect(unlit?.coverImageUrl).toBeUndefined();

    // The limit caps the flat list.
    const capped = await listFreshTracks({ limit: 2, now: NOW });
    expect(capped.tracks).toHaveLength(2);
    expect(capped.tracks[0]?.title).toBe("Title flat_f_15");
  });
});

/** A crawled catalogue track sitting on an album entity, for the records-window tests. */
async function seedAlbumTrack(options: {
  albumId: string;
  albumName: string;
  albumSlug: string;
  artists: string[];
  releaseDate: string;
  trackId: string;
}): Promise<void> {
  await db.execute({
    args: [options.albumId, options.albumName, options.albumSlug, "x", "x"],
    sql: `insert or ignore into albums (id, name, slug, created_at, updated_at) values (?, ?, ?, ?, ?)`,
  });
  await seedCatalogueTrack({
    albumId: options.albumId,
    artists: options.artists,
    releaseDate: options.releaseDate,
    trackId: options.trackId,
  });
}

describe("listFreshReleases — the album window widens without touching the track stream", () => {
  it("reaches records past the 30-day track window only when asked, flagging the track-window cut", async () => {
    // A record 60 days back — inside a 90-day album window, OUTSIDE the 30-day track window.
    await seedAlbumTrack({
      albumId: "alb_deep",
      albumName: "Deep Cut",
      albumSlug: "deep-cut",
      artists: ["Seba"],
      releaseDate: "2026-05-18",
      trackId: "deep_1",
    });
    // A record inside BOTH windows.
    await seedAlbumTrack({
      albumId: "alb_recent",
      albumName: "Recent Cut",
      albumSlug: "recent-cut",
      artists: ["Nu:Tone"],
      releaseDate: "2026-07-14",
      trackId: "recent_1",
    });

    // Default (30-day) window: only the recent record surfaces — the feeds' read is unchanged.
    const narrow = await listFreshReleases(NOW);
    expect(narrow.records.map((record) => record.slug)).toEqual(["recent-cut"]);

    // Widened (90-day) window: the deep record joins it, flagged as OUTSIDE the track window.
    const wide = await listFreshReleases(NOW, FRESH_RECORDS_WINDOW_DAYS);
    expect(wide.records.map((record) => record.slug)).toEqual(["recent-cut", "deep-cut"]);
    expect(wide.records.find((record) => record.slug === "deep-cut")?.withinTrackWindow).toBe(
      false,
    );
    expect(wide.records.find((record) => record.slug === "recent-cut")?.withinTrackWindow).toBe(
      true,
    );
    // The track stream and its window are untouched by the wider records read.
    expect(wide.windowDays).toBe(FRESH_WINDOW_DAYS);
  });

  it("counts the record's tracks, never the artist-multiplied json_each join rows", async () => {
    // Two tracks, each credited to several artists — the json_each join multiplies rows, so a naive
    // count(*) would overcount. trackCount must be the distinct-track count: 2.
    await seedAlbumTrack({
      albumId: "alb_ep",
      albumName: "Two Track EP",
      albumSlug: "two-track-ep",
      artists: ["Artist A", "Artist B", "Artist C"],
      releaseDate: "2026-07-14",
      trackId: "ep_1",
    });
    await seedCatalogueTrack({
      albumId: "alb_ep",
      artists: ["Artist A", "Artist B"],
      releaseDate: "2026-07-13",
      trackId: "ep_2",
    });

    const { records } = await listFreshReleases(NOW, FRESH_RECORDS_WINDOW_DAYS);
    expect(records.find((record) => record.slug === "two-track-ep")?.trackCount).toBe(2);
  });
});

describe("the view split — the cuts the marquee switches the pills on", () => {
  it("gives the album view the full 90-day set, the All-view rail only the 30-day cut, both views the stream", async () => {
    await seedFinding({
      artists: ["Dimension"],
      logId: "200.7.1A",
      releaseDate: "2026-07-15",
      trackId: "split_f",
    });
    await seedCatalogueTrack({
      artists: ["Lenzman"],
      releaseDate: "2026-07-12",
      trackId: "split_c",
    });
    await seedAlbumTrack({
      albumId: "alb_in",
      albumName: "In Window LP",
      albumSlug: "in-window-lp",
      artists: ["Nu:Tone"],
      releaseDate: "2026-07-14",
      trackId: "split_in",
    });
    await seedAlbumTrack({
      albumId: "alb_deep",
      albumName: "Deep Window LP",
      albumSlug: "deep-window-lp",
      artists: ["Seba"],
      releaseDate: "2026-05-18", // 60 days back — album view only
      trackId: "split_deep",
    });

    const data = await listFreshReleases(NOW, FRESH_RECORDS_WINDOW_DAYS);

    // The "Albums & EPs" view: every record in the 90-day cut, newest first.
    expect(freshRecordCovers(data).map((cover) => cover.key)).toEqual([
      "r-in-window-lp",
      "r-deep-window-lp",
    ]);
    // The "All" view's rail: only the records inside the 30-day track window (today's layout).
    expect(freshTrackWindowRecordCovers(data).map((cover) => cover.key)).toEqual([
      "r-in-window-lp",
    ]);
    // The track stream (shown by both "All" and "Tracks"): every finding + catalogue row in the
    // 30-day window. An in-window album's tracks ride the stream as catalogue rows too (`split_in`);
    // the 60-day album's track (`split_deep`) is outside the track window, so it appears in the album
    // view alone.
    expect(
      freshStream(data)
        .map((entry) => (entry.kind === "finding" ? entry.finding.trackId : entry.track.trackId))
        .sort(),
    ).toEqual(["split_c", "split_f", "split_in"]);
  });
});

describe("the fresh FEED contract survives the album-window widening", () => {
  it("keeps listFreshTracks on the 30-day window — a 60-day record never leaks into a feed read", async () => {
    // The 30-day track window (what the feeds carry).
    await seedFinding({
      artists: ["Dimension"],
      logId: "200.7.1A",
      releaseDate: "2026-07-15",
      trackId: "feed_f",
    });
    await seedCatalogueTrack({
      artists: ["Nu:Tone"],
      releaseDate: "2026-07-12",
      trackId: "feed_c",
    });
    // A record 60 days back — inside the page's 90-day album view, OUTSIDE the feed's window.
    await seedAlbumTrack({
      albumId: "alb_old",
      albumName: "Old Record",
      albumSlug: "old-record",
      artists: ["Seba"],
      releaseDate: "2026-05-18",
      trackId: "old_1",
    });

    const feed = await listFreshTracks({ now: NOW });

    // The flat track list is the 30-day set — the 60-day catalogue row never appears.
    expect(feed.tracks.map((track) => track.title).sort()).toEqual([
      "Title feed_c",
      "Title feed_f",
    ]);
    // The feed's album list is the 30-day cut too — the 60-day record does not leak in.
    expect(feed.albums.map((album) => album.slug)).toEqual([]);
    expect(feed.windowDays).toBe(FRESH_WINDOW_DAYS);
  });
});
