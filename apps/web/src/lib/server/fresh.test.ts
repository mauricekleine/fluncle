import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => holder.db };
});

import { createIntegrationDb, seedLabel } from "./integration-db";
import { listLabelFreshTracks } from "./fresh-entity";
import { LONG_FORM_MS } from "../catalogue-eligibility";
import {
  FRESH_FINDINGS_LIMIT,
  FRESH_WINDOW_DAYS,
  listFreshRecords,
  listFreshReleases,
  listFreshTracks,
} from "./fresh";

const NOW = new Date("2026-07-17T12:00:00.000Z");

let db: Client;

async function seedCatalogueTrack(options: {
  album?: string;
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
      options.album ?? null,
      options.albumId ?? null,
      `https://open.spotify.com/track/${options.trackId}`,
      options.albumImageUrl ?? null,
    ],
    sql: `insert into tracks
            (track_id, title, artists_json, release_date, album, album_id, spotify_url, album_image_url, duration_ms)
          values (?, ?, ?, ?, ?, ?, ?, ?, 210000)`,
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

async function seedAlbumEntity(id: string, name: string, slug: string): Promise<void> {
  await db.execute({
    args: [id, name, slug, "x", "x"],
    sql: `insert or ignore into albums (id, name, slug, created_at, updated_at) values (?, ?, ?, ?, ?)`,
  });
}

async function seedAlbumTrack(options: {
  albumId: string;
  albumName: string;
  albumSlug: string;
  artists: string[];
  releaseDate: string;
  trackId: string;
}): Promise<void> {
  await seedAlbumEntity(options.albumId, options.albumName, options.albumSlug);
  await seedCatalogueTrack({
    album: options.albumName,
    albumId: options.albumId,
    artists: options.artists,
    releaseDate: options.releaseDate,
    trackId: options.trackId,
  });
}

beforeEach(async () => {
  db = await createIntegrationDb();
  holder.db = db;
});

describe("listFreshReleases", () => {
  it("keeps long findings while omitting long catalogue releases and records", async () => {
    await seedAlbumTrack({
      albumId: "long-album",
      albumName: "Long Album",
      albumSlug: "long-album",
      artists: ["Artist"],
      releaseDate: "2026-07-15",
      trackId: "long-catalogue",
    });
    await seedFinding({
      artists: ["Artist"],
      logId: "001.1.1",
      releaseDate: "2026-07-15",
      trackId: "long-finding",
    });
    await db.execute({
      args: [LONG_FORM_MS],
      sql: `update tracks set duration_ms = ? where track_id in ('long-catalogue', 'long-finding')`,
    });

    const releases = await listFreshReleases(NOW);
    expect(releases.catalogue).toEqual([]);
    expect(releases.findings.map((finding) => finding.trackId)).toEqual(["long-finding"]);
    expect(await listFreshRecords(NOW)).toEqual([]);
  });

  it("splits the window into lit findings and unlit catalogue, each newest release first", async () => {
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

    const { catalogue, coverage, findings, windowDays } = await listFreshReleases(NOW);

    expect(windowDays).toBe(FRESH_WINDOW_DAYS);
    expect(coverage).toEqual({ kind: "complete" });
    expect(findings.map((finding) => finding.trackId)).toEqual(["f_week", "f_earlier"]);
    expect(catalogue.map((track) => track.trackId)).toEqual(["c_week", "c_earlier"]);

    expect(findings.every((finding) => Boolean(finding.logId))).toBe(true);
    expect(catalogue.every((track) => !("logId" in track))).toBe(true);
    expect(catalogue[0]).toMatchObject({
      albumImageUrl: expect.any(String),
      bpm: 174,
      durationMs: 210000,
      isrc: "GBTEST2600001",
      key: "F minor",
      previewable: true,
      releaseDate: "2026-07-12",
    });
    expect(catalogue[1]?.previewable).toBe(false);
    expect(catalogue[1]?.isrc).toBeUndefined();
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

    const { catalogue, findings } = await listFreshReleases(NOW);

    expect(findings.map((finding) => finding.trackId)).toEqual(["f_in"]);
    expect(catalogue.map((track) => track.trackId)).toEqual(["c_current_month"]);
  });

  it("keeps a partial date on the first day of the release window", async () => {
    await seedCatalogueTrack({
      artists: ["Month"],
      releaseDate: "2026-10",
      trackId: "month_boundary",
    });
    const now = new Date("2026-10-31T12:00:00Z");
    const { catalogue } = await listFreshReleases(now);
    expect(catalogue.map((track) => track.trackId)).toEqual(["month_boundary"]);
  });

  it("returns empty halves and a complete coverage for a window with no releases", async () => {
    await seedFinding({
      artists: ["Old"],
      logId: "100.1.1A",
      releaseDate: "2024-01-01",
      trackId: "f_ancient",
    });

    const data = await listFreshReleases(NOW);

    expect(data.findings).toEqual([]);
    expect(data.catalogue).toEqual([]);
    expect(data.coverage).toEqual({ kind: "complete" });
    expect(await listFreshRecords(NOW)).toEqual([]);
  });

  it("carries the record a catalogue row sits on: its album entity slug and its record name", async () => {
    await seedAlbumTrack({
      albumId: "alb_wgf",
      albumName: "Words Gone Forever",
      albumSlug: "words-gone-forever",
      artists: ["Nu:Tone"],
      releaseDate: "2026-07-14",
      trackId: "c_on_entity",
    });

    await seedCatalogueTrack({
      album: "Loose Pressing",
      artists: ["Halogenix"],
      releaseDate: "2026-07-13",
      trackId: "c_named_only",
    });

    const { catalogue } = await listFreshReleases(NOW);

    expect(catalogue.find((track) => track.trackId === "c_on_entity")).toMatchObject({
      album: "Words Gone Forever",
      albumSlug: "words-gone-forever",
    });
    const named = catalogue.find((track) => track.trackId === "c_named_only");
    expect(named?.album).toBe("Loose Pressing");
    expect(named?.albumSlug).toBeUndefined();
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

    const { catalogue } = await listFreshReleases(NOW);
    const row = catalogue.find((track) => track.trackId === "c_avatar");

    expect(row?.artistAvatarUrl).toBe("https://i.scdn.co/image/workforce");
  });
});

describe("listFreshReleases — the record's stored size", () => {
  it("carries the album entity's stored track count on both halves", async () => {
    await db.execute({
      args: ["alb_lp", "Long Player", "long-player", "x", "x"],
      sql: `insert into albums (id, name, slug, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    });
    await db.execute({
      sql: `update albums set renderable_track_count = 9 where id = 'alb_lp'`,
    });
    await seedCatalogueTrack({
      albumId: "alb_lp",
      artists: ["LP"],
      releaseDate: "2026-07-15",
      trackId: "c_lp",
    });
    await seedFinding({
      artists: ["LP"],
      logId: "301.7.1A",
      releaseDate: "2026-07-15",
      trackId: "f_lp",
    });
    await db.execute({ sql: `update tracks set album_id = 'alb_lp' where track_id = 'f_lp'` });
    await seedCatalogueTrack({ artists: ["Loose"], releaseDate: "2026-07-15", trackId: "c_loose" });

    const data = await listFreshReleases(NOW);

    expect(data.catalogue.find((track) => track.trackId === "c_lp")?.albumTrackCount).toBe(9);
    expect(data.findings.find((finding) => finding.trackId === "f_lp")?.albumTrackCount).toBe(9);
    expect(
      data.catalogue.find((track) => track.trackId === "c_loose")?.albumTrackCount,
    ).toBeUndefined();
  });
});

describe("listFreshReleases — the coverage a limit leaves", () => {
  it("trims a limit cut to whole release days and names the oldest day it kept", async () => {
    for (const trackId of ["c_15a", "c_15b", "c_15c"]) {
      await seedCatalogueTrack({ artists: ["Newest"], releaseDate: "2026-07-15", trackId });
    }
    for (const trackId of ["c_10a", "c_10b"]) {
      await seedCatalogueTrack({ artists: ["Older"], releaseDate: "2026-07-10", trackId });
    }

    await seedFinding({
      artists: ["Kept"],
      logId: "300.7.1A",
      releaseDate: "2026-07-12",
      trackId: "f_12",
    });
    await seedFinding({
      artists: ["Cut"],
      logId: "301.7.1A",
      releaseDate: "2026-07-10",
      trackId: "f_10",
    });

    const data = await listFreshReleases(NOW, { catalogueLimit: 3 });

    expect(data.catalogue.map((track) => track.trackId).sort()).toEqual([
      "c_15a",
      "c_15b",
      "c_15c",
    ]);
    expect(data.findings.map((finding) => finding.trackId)).toEqual(["f_12"]);
    expect(data.coverage).toEqual({ kind: "partial", since: "2026-07-12" });
  });

  it("drops a day the limit cut partway through, even when the day before the cut fits", async () => {
    for (const trackId of ["p_15a", "p_15b"]) {
      await seedCatalogueTrack({ artists: ["Newest"], releaseDate: "2026-07-15", trackId });
    }
    for (const trackId of ["p_10a", "p_10b", "p_10c"]) {
      await seedCatalogueTrack({ artists: ["Older"], releaseDate: "2026-07-10", trackId });
    }

    const data = await listFreshReleases(NOW, { catalogueLimit: 3 });

    expect(data.catalogue.map((track) => track.trackId).sort()).toEqual(["p_15a", "p_15b"]);
    expect(data.coverage).toEqual({ kind: "partial", since: "2026-07-15" });
  });

  it("holds only part of the newest day, and says so, when that day alone outgrows the limit", async () => {
    for (const trackId of ["d_a", "d_b", "d_c", "d_d", "d_e"]) {
      await seedCatalogueTrack({ artists: ["Flood"], releaseDate: "2026-07-15", trackId });
    }
    await seedCatalogueTrack({ artists: ["Older"], releaseDate: "2026-07-10", trackId: "o_a" });

    const data = await listFreshReleases(NOW, { catalogueLimit: 3 });

    expect(data.coverage).toEqual({ day: "2026-07-15", kind: "truncated" });
    expect(data.catalogue).toHaveLength(3);
    expect(data.catalogue.every((track) => track.releaseDate === "2026-07-15")).toBe(true);
  });

  it("never keeps an older row under a truncated day's claim, whichever half overflowed", async () => {
    for (let index = 0; index <= FRESH_FINDINGS_LIMIT; index += 1) {
      await seedFinding({
        artists: ["Flood"],
        logId: `300.7.${index}A`,
        releaseDate: "2026-07-16",
        trackId: `f_${index}`,
      });
    }
    await seedCatalogueTrack({
      artists: ["Same Day"],
      releaseDate: "2026-07-16",
      trackId: "c_same",
    });
    await seedCatalogueTrack({ artists: ["Older"], releaseDate: "2026-07-12", trackId: "c_older" });

    const data = await listFreshReleases(NOW);

    expect(data.coverage).toEqual({ day: "2026-07-16", kind: "truncated" });
    expect(data.findings).toHaveLength(FRESH_FINDINGS_LIMIT);
    expect(data.catalogue.map((track) => track.trackId)).toEqual(["c_same"]);
  });

  it("holds every day since a partial read's day whole, so an entity feed never shows a track the page left out", async () => {
    await seedLabel(db, { id: "lbl_1", name: "Fresh Label", slug: "fresh-label" });
    await seedCatalogueTrack({ artists: ["Other"], releaseDate: "2026-07-16", trackId: "x_1" });
    await seedCatalogueTrack({ artists: ["Other"], releaseDate: "2026-07-16", trackId: "x_2" });
    for (const [trackId, releaseDate] of [
      ["l_1", "2026-07-15"],
      ["l_2", "2026-07-15"],
      ["l_3", "2026-07-12"],
      ["l_4", "2026-07-05"],
    ] as const) {
      await seedCatalogueTrack({ artists: ["Label Artist"], releaseDate, trackId });
      await db.execute({
        args: ["lbl_1", trackId],
        sql: `update tracks set label_id = ? where track_id = ?`,
      });
    }

    const data = await listFreshReleases(NOW, { catalogueLimit: 4 });
    const feed = await listLabelFreshTracks("fresh-label", { now: NOW });

    expect(data.coverage).toEqual({ kind: "partial", since: "2026-07-15" });

    const since = data.coverage.kind === "partial" ? data.coverage.since : "";
    const onPage = new Set(data.catalogue.map((track) => track.title));
    const feedSince = (feed?.tracks ?? []).filter((track) => track.releaseDate >= since);

    expect(feedSince.length).toBeGreaterThan(0);
    expect(feedSince.every((track) => onPage.has(track.title))).toBe(true);
  });

  it("reports a complete window when the rows fit exactly inside the limit", async () => {
    for (const trackId of ["e_a", "e_b", "e_c"]) {
      await seedCatalogueTrack({ artists: ["Exact"], releaseDate: "2026-07-15", trackId });
    }

    const data = await listFreshReleases(NOW, { catalogueLimit: 3 });

    expect(data.catalogue).toHaveLength(3);
    expect(data.coverage).toEqual({ kind: "complete" });
  });
});

describe("listFreshRecords", () => {
  it("surfaces the album entities a fresh release sits on, newest first", async () => {
    await seedAlbumEntity("alb_wgf", "Words Gone Forever", "words-gone-forever");
    await seedAlbumEntity("alb_elem", "The Elements", "the-elements");
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

    const records = await listFreshRecords(NOW);

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

    const records = await listFreshRecords(NOW);
    const owned = records.find((record) => record.slug === "owned-record");
    const raw = records.find((record) => record.slug === "raw-record");

    expect(owned?.coverImageUrl).toBe(
      "https://found.fluncle.com/cdn-cgi/image/width=640,format=auto/" +
        `https://found.fluncle.com/albums/owned-record.jpg?v=${Date.parse("2026-07-01T00:00:00.000Z")}`,
    );
    expect(owned?.coverImageUrl).not.toContain("coverartarchive.org");

    expect(raw?.coverImageUrl).toBe("https://coverartarchive.org/release/raw/front");
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

    const records = await listFreshRecords(NOW);
    expect(records.find((record) => record.slug === "two-track-ep")?.trackCount).toBe(2);
  });
});

describe("listFreshTracks — the flat list the syndication surfaces read", () => {
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

  it("stays on the 30-day window: a 60-day record never leaks into a feed read", async () => {
    await seedFinding({
      artists: ["Dimension"],
      logId: "200.7.1A",
      releaseDate: "2026-07-15",
      trackId: "feed_f",
    });
    await seedAlbumTrack({
      albumId: "alb_recent",
      albumName: "Recent Record",
      albumSlug: "recent-record",
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
    expect(feed.albums.map((album) => album.slug)).toEqual(["recent-record"]);
    expect(feed.windowDays).toBe(FRESH_WINDOW_DAYS);
  });
});
