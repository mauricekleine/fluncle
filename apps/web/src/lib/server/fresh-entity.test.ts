import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => holder.db };
});

import { createIntegrationDb } from "./integration-db";
import { listFreshTracks } from "./fresh";
import { listArtistFreshTracks, listLabelFreshTracks } from "./fresh-entity";

const NOW = new Date("2026-07-17T12:00:00.000Z");

let db: Client;

async function seedArtist(id: string, name: string, slug: string): Promise<void> {
  await db.execute({
    args: [id, name, slug],
    sql: `insert into artists (id, name, slug, created_at, updated_at) values (?, ?, ?, 'x', 'x')`,
  });
}

async function seedLabel(id: string, name: string, slug: string): Promise<void> {
  await db.execute({
    args: [id, name, slug],
    sql: `insert into labels (id, name, slug, created_at, updated_at) values (?, ?, ?, 'x', 'x')`,
  });
}

async function seedTrack(options: {
  artistIds?: string[];
  artists: string[];
  certified?: boolean;
  labelId?: string;
  releaseDate: string;
  trackId: string;
}): Promise<void> {
  await db.execute({
    args: [
      options.trackId,
      `Title ${options.trackId}`,
      JSON.stringify(options.artists),
      options.releaseDate,
      options.labelId ?? null,
      `https://open.spotify.com/track/${options.trackId}`,
      options.certified ? "https://i.scdn.co/image/cover" : null,
    ],
    sql: `insert into tracks
            (track_id, title, artists_json, release_date, label_id, spotify_url, album_image_url, duration_ms)
          values (?, ?, ?, ?, ?, ?, ?, 210000)`,
  });
  if (options.certified) {
    await db.execute({
      args: [options.trackId, `200.7.${options.trackId}`],
      sql: `insert into findings (track_id, log_id, added_at)
            values (?, ?, '2020-01-01T00:00:00.000Z')`,
    });
  }
  for (const [index, artistId] of (options.artistIds ?? []).entries()) {
    await db.execute({
      args: [options.trackId, artistId, index + 1],
      sql: `insert into track_artists (track_id, artist_id, position) values (?, ?, ?)`,
    });
  }
}

beforeEach(async () => {
  db = await createIntegrationDb();
  holder.db = db;
});

describe("listArtistFreshTracks", () => {
  it("agrees with the whole fresh list on a month-precision release at month end", async () => {
    const now = new Date("2026-07-31T12:00:00.000Z");
    await seedArtist("art_a", "Camo & Krooked", "camo-and-krooked");
    await seedLabel("lab_a", "Hospital Records", "hospital-records");
    await seedTrack({
      artistIds: ["art_a"],
      artists: ["Camo & Krooked"],
      labelId: "lab_a",
      releaseDate: "2026-07",
      trackId: "month_precision",
    });

    expect((await listFreshTracks({ now })).tracks.map((track) => track.title)).toContain(
      "Title month_precision",
    );
    expect(
      (await listArtistFreshTracks("camo-and-krooked", { now }))?.tracks.map(
        (track) => track.title,
      ),
    ).toContain("Title month_precision");
    expect(
      (await listLabelFreshTracks("hospital-records", { now }))?.tracks.map((track) => track.title),
    ).toContain("Title month_precision");
  });

  it("returns only the artist's own fresh tracks, split lit/unlit, newest first", async () => {
    await seedArtist("art_a", "Camo & Krooked", "camo-and-krooked");
    await seedArtist("art_b", "Someone Else", "someone-else");

    await seedTrack({
      artistIds: ["art_a"],
      artists: ["Camo & Krooked"],
      certified: true,
      releaseDate: "2026-07-15",
      trackId: "a_finding",
    });
    await seedTrack({
      artistIds: ["art_a"],
      artists: ["Camo & Krooked"],
      releaseDate: "2026-07-10",
      trackId: "a_catalogue",
    });

    await seedTrack({
      artistIds: ["art_b"],
      artists: ["Someone Else"],
      certified: true,
      releaseDate: "2026-07-16",
      trackId: "b_finding",
    });

    const feed = await listArtistFreshTracks("camo-and-krooked", { now: NOW });

    expect(feed?.name).toBe("Camo & Krooked");
    expect(feed?.tracks.map((track) => track.title)).toEqual([
      "Title a_finding",
      "Title a_catalogue",
    ]);

    const finding = feed?.tracks[0];
    expect(finding?.certified).toBe(true);
    expect(finding?.logId).toBe("200.7.a_finding");
    expect(finding?.coverImageUrl).toBe("https://i.scdn.co/image/cover");
    const unlit = feed?.tracks[1];
    expect(unlit?.certified).toBe(false);
    expect(unlit?.logId).toBeUndefined();
    expect(unlit?.coverImageUrl).toBeUndefined();
  });

  it("honours the 30-day release window (excludes an old release and a future pre-order)", async () => {
    await seedArtist("art_a", "Camo & Krooked", "camo-and-krooked");
    await seedTrack({
      artistIds: ["art_a"],
      artists: ["Camo & Krooked"],
      releaseDate: "2026-05-01",
      trackId: "too_old",
    });
    await seedTrack({
      artistIds: ["art_a"],
      artists: ["Camo & Krooked"],
      releaseDate: "2026-08-01",
      trackId: "preorder",
    });
    await seedTrack({
      artistIds: ["art_a"],
      artists: ["Camo & Krooked"],
      releaseDate: "2026-07-12",
      trackId: "in_window",
    });

    const feed = await listArtistFreshTracks("camo-and-krooked", { now: NOW });
    expect(feed?.tracks.map((track) => track.title)).toEqual(["Title in_window"]);
  });

  it("resolves an unknown slug to undefined (the route 404s)", async () => {
    expect(await listArtistFreshTracks("no-such-artist", { now: NOW })).toBeUndefined();
  });

  it("returns an empty list for a known artist with nothing in the window", async () => {
    await seedArtist("art_a", "Camo & Krooked", "camo-and-krooked");
    await seedTrack({
      artistIds: ["art_a"],
      artists: ["Camo & Krooked"],
      releaseDate: "2020-01-01",
      trackId: "ancient",
    });

    const feed = await listArtistFreshTracks("camo-and-krooked", { now: NOW });
    expect(feed?.name).toBe("Camo & Krooked");
    expect(feed?.tracks).toEqual([]);
  });
});

describe("listLabelFreshTracks", () => {
  it("returns only the label's own fresh tracks via label_id, split lit/unlit", async () => {
    await seedLabel("lab_a", "Hospital Records", "hospital-records");
    await seedLabel("lab_b", "Other Label", "other-label");

    await seedTrack({
      artists: ["Nu:Tone"],
      certified: true,
      labelId: "lab_a",
      releaseDate: "2026-07-15",
      trackId: "l_finding",
    });
    await seedTrack({
      artists: ["Logistics"],
      labelId: "lab_a",
      releaseDate: "2026-07-11",
      trackId: "l_catalogue",
    });

    await seedTrack({
      artists: ["Someone"],
      certified: true,
      labelId: "lab_b",
      releaseDate: "2026-07-16",
      trackId: "other_finding",
    });

    const feed = await listLabelFreshTracks("hospital-records", { now: NOW });

    expect(feed?.name).toBe("Hospital Records");
    expect(feed?.tracks.map((track) => track.title)).toEqual([
      "Title l_finding",
      "Title l_catalogue",
    ]);
    expect(feed?.tracks[0]?.certified).toBe(true);
    expect(feed?.tracks[1]?.certified).toBe(false);
    expect(feed?.tracks[1]?.logId).toBeUndefined();
  });

  it("resolves an unknown slug to undefined", async () => {
    expect(await listLabelFreshTracks("no-such-label", { now: NOW })).toBeUndefined();
  });
});
