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

const NOW = new Date("2026-07-17T12:00:00.000Z");

let db: Client;

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

  await db.execute({
    args: [options.trackId],
    sql: `update tracks set is_catalogue = 0 where track_id = ?`,
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
      releaseDate: "2026-07-15",
      trackId: "f_week",
    });
    await seedFinding({
      artists: ["Calibre"],
      logId: "201.7.2B",
      releaseDate: "2026-06-25",
      trackId: "f_earlier",
    });
    await seedCatalogueTrack({
      artists: ["Nu:Tone"],
      releaseDate: "2026-07-12",
      trackId: "c_week",
    });
    await seedCatalogueTrack({
      artists: ["Lenzman"],
      releaseDate: "2026-06-20",
      trackId: "c_earlier",
    });
    await db.execute({
      args: ["c_week"],
      sql: `update tracks set album_image_url = 'https://i.scdn.co/image/cover',
             bpm = 174, key = 'F minor', isrc = 'GBTEST2600001' where track_id = ?`,
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

    expect(week?.findings.every((finding) => Boolean(finding.logId))).toBe(true);
    const everyCatalogue = sections.flatMap((section) => section.catalogue);
    expect(everyCatalogue.every((track) => !("logId" in track))).toBe(true);
    expect(week?.catalogue[0]).toMatchObject({
      albumImageUrl: expect.any(String),
      bpm: 174,
      durationMs: 210000,
      key: "F minor",
      previewable: true,
    });
    expect(earlier?.catalogue[0]?.previewable).toBe(false);
  });

  it("excludes an older release and a future-dated pre-order", async () => {
    await seedFinding({
      artists: ["Old"],
      logId: "100.1.1A",
      releaseDate: "2026-05-01",
      trackId: "f_old",
    });
    await seedCatalogueTrack({
      artists: ["Preorder"],
      releaseDate: "2026-08-01",
      trackId: "c_future",
    });
    await seedCatalogueTrack({
      artists: ["Preorder"],
      releaseDate: "2026-08",
      trackId: "c_future_month",
    });
    await seedCatalogueTrack({
      artists: ["Released"],
      releaseDate: "2026-07",
      trackId: "c_current_month",
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

    expect(trackIds).toEqual(["f_in", "c_current_month"]);
  });

  it("keeps a partial date on the first day of the release window", async () => {
    await seedCatalogueTrack({
      artists: ["Month"],
      releaseDate: "2026-10",
      trackId: "month_boundary",
    });
    const now = new Date("2026-10-31T12:00:00Z");
    const { sections } = await listFreshReleases(now);
    expect(sections.flatMap((section) => section.catalogue.map((track) => track.trackId))).toEqual([
      "month_boundary",
    ]);
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

    expect(wgf?.coverImageUrl).toBe("https://i.scdn.co/image/wgf-newest");
  });

  it("serves a record's owned cover master, and falls back to the raw art when there is none", async () => {
    await db.execute({
      args: [
        "alb_owned",
        "Owned Record",
        "owned-record",
        "albums/owned-record.jpg",
        "resolved",
        "2026-07-01T00:00:00.000Z",
        "x",
        "x",
      ],
      sql: `insert into albums
              (id, name, slug, image_key, image_state, image_updated_at, created_at, updated_at)
            values (?, ?, ?, ?, ?, ?, ?, ?)`,
    });

    await db.execute({
      args: ["alb_raw", "Raw Record", "raw-record", "albums/raw-record.jpg", "none", "x", "x"],
      sql: `insert into albums
              (id, name, slug, image_key, image_state, created_at, updated_at)
            values (?, ?, ?, ?, ?, ?, ?)`,
    });
    await seedCatalogueTrack({
      albumId: "alb_owned",
      albumImageUrl: "https://coverartarchive.org/release/owned/front",
      artists: ["Workforce"],
      releaseDate: "2026-07-14",
      trackId: "r_owned",
    });
    await seedCatalogueTrack({
      albumId: "alb_raw",
      albumImageUrl: "https://coverartarchive.org/release/raw/front",
      artists: ["Halogenix"],
      releaseDate: "2026-07-13",
      trackId: "r_raw",
    });

    const { records } = await listFreshReleases(NOW);
    const owned = records.find((record) => record.slug === "owned-record");
    const raw = records.find((record) => record.slug === "raw-record");

    expect(owned?.coverImageUrl).toBe(
      "https://found.fluncle.com/cdn-cgi/image/width=640,format=auto/" +
        `https://found.fluncle.com/albums/owned-record.jpg?v=${Date.parse("2026-07-01T00:00:00.000Z")}`,
    );
    expect(owned?.coverImageUrl).not.toContain("coverartarchive.org");

    expect(raw?.coverImageUrl).toBe("https://coverartarchive.org/release/raw/front");
  });

  it("attaches the lead artist's avatar to a catalogue row (the row shows WHO, dimmed in the UI)", async () => {
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

    expect(row?.artistAvatarUrl).toBe("https://i.scdn.co/image/workforce");
  });

  it("flattens into a capped list, newest release first, unlit rows coordinate-free", async () => {
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

    const finding = all.tracks[0];
    expect(finding?.certified).toBe(true);
    expect(finding?.logId).toBe("049.7.1F");
    const unlit = all.tracks[1];
    expect(unlit?.certified).toBe(false);
    expect(unlit?.logId).toBeUndefined();
    expect(unlit?.coverImageUrl).toBeUndefined();

    const capped = await listFreshTracks({ limit: 2, now: NOW });
    expect(capped.tracks).toHaveLength(2);
    expect(capped.tracks[0]?.title).toBe("Title flat_f_15");
  });
});

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
    await seedAlbumTrack({
      albumId: "alb_deep",
      albumName: "Deep Cut",
      albumSlug: "deep-cut",
      artists: ["Seba"],
      releaseDate: "2026-05-18",
      trackId: "deep_1",
    });

    await seedAlbumTrack({
      albumId: "alb_recent",
      albumName: "Recent Cut",
      albumSlug: "recent-cut",
      artists: ["Nu:Tone"],
      releaseDate: "2026-07-14",
      trackId: "recent_1",
    });

    const narrow = await listFreshReleases(NOW);
    expect(narrow.records.map((record) => record.slug)).toEqual(["recent-cut"]);

    const wide = await listFreshReleases(NOW, FRESH_RECORDS_WINDOW_DAYS);
    expect(wide.records.map((record) => record.slug)).toEqual(["recent-cut", "deep-cut"]);
    expect(wide.records.find((record) => record.slug === "deep-cut")?.withinTrackWindow).toBe(
      false,
    );
    expect(wide.records.find((record) => record.slug === "recent-cut")?.withinTrackWindow).toBe(
      true,
    );

    expect(wide.windowDays).toBe(FRESH_WINDOW_DAYS);
  });

  it("counts the record's tracks, never the artist-multiplied json_each join rows", async () => {
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
      releaseDate: "2026-05-18",
      trackId: "split_deep",
    });

    const data = await listFreshReleases(NOW, FRESH_RECORDS_WINDOW_DAYS);

    expect(freshRecordCovers(data).map((cover) => cover.key)).toEqual([
      "r-in-window-lp",
      "r-deep-window-lp",
    ]);

    expect(freshTrackWindowRecordCovers(data).map((cover) => cover.key)).toEqual([
      "r-in-window-lp",
    ]);

    expect(
      freshStream(data)
        .map((entry) => (entry.kind === "finding" ? entry.finding.trackId : entry.track.trackId))
        .sort(),
    ).toEqual(["split_c", "split_f", "split_in"]);
  });
});

describe("the fresh FEED contract survives the album-window widening", () => {
  it("keeps listFreshTracks on the 30-day window — a 60-day record never leaks into a feed read", async () => {
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

    await seedAlbumTrack({
      albumId: "alb_old",
      albumName: "Old Record",
      albumSlug: "old-record",
      artists: ["Seba"],
      releaseDate: "2026-05-18",
      trackId: "old_1",
    });

    const feed = await listFreshTracks({ now: NOW });

    expect(feed.tracks.map((track) => track.title).sort()).toEqual([
      "Title feed_c",
      "Title feed_f",
    ]);

    expect(feed.albums.map((album) => album.slug)).toEqual([]);
    expect(feed.windowDays).toBe(FRESH_WINDOW_DAYS);
  });
});
