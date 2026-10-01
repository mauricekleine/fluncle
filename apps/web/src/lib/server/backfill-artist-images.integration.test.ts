import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => holder.db };
});

import { backfillArtistImages } from "./backfill-artist-images";
import { createIntegrationDb } from "./integration-db";
import { fillMissingArtistImages } from "./artists";

let db: Client;
const SPOTIFY_ARTIST_ID = "0TnOYISbd1XYRBk9myaseg";

beforeEach(async () => {
  db = await createIntegrationDb();
  holder.db = db;

  const nowIso = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();

  await db.execute({
    args: ["spotify", "access-token", "refresh-token", expiresAt, "scope", nowIso],
    sql: `insert into spotify_auth
            (service, access_token, refresh_token, expires_at, scope, updated_at)
          values (?, ?, ?, ?, ?, ?)`,
  });
  await db.execute({
    args: ["artist-1", "No Portrait", "no-portrait", SPOTIFY_ARTIST_ID, nowIso, nowIso],
    sql: `insert into artists
            (id, name, slug, spotify_artist_id, image_state, image_failures, created_at, updated_at)
          values (?, ?, ?, ?, 'pending', 3, ?, ?)`,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  db.close();
});

describe("artist-image backfill SQL", () => {
  it("terminally stamps an oEmbed miss without a verified Deezer track", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("https://open.spotify.com/oembed?")) {
        return new Response(
          JSON.stringify({
            iframe_url: `https://open.spotify.com/embed/artist/${SPOTIFY_ARTIST_ID}`,
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = await backfillArtistImages(50, false);

    expect(first).toMatchObject({
      checkedCount: 1,
      failedCount: 0,
      filledCount: 0,
      queueDepth: 0,
      rateLimited: false,
      skipped: ["artist-1"],
    });

    const stored = await db.execute({
      args: ["artist-1"],
      sql: `select image_url, image_state, image_attempted_at, image_failures
            from artists where id = ?`,
    });
    expect(stored.rows[0]).toMatchObject({
      image_attempted_at: expect.any(String),
      image_failures: 0,
      image_state: "none",
      image_url: null,
    });

    await expect(fillMissingArtistImages([SPOTIFY_ARTIST_ID])).resolves.toBe(0);

    const second = await backfillArtistImages(50, false);

    expect(second).toMatchObject({
      checkedCount: 0,
      queueDepth: 0,
      skippedCount: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.every(([url]) => !url.includes("api.spotify.com"))).toBe(true);
  });

  it("stores an available avatar while leaving it pending for owned-master ingestion", async () => {
    const alternateId = "1uNFoZAHBGtllmzznpCI3s";
    await db.execute({
      args: [alternateId, "artist-1"],
      sql: `update artists set spotify_artist_id = ? where id = ?`,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              iframe_url: `https://open.spotify.com/embed/artist/${alternateId}`,
              thumbnail_url: "https://i.scdn.co/image/spotify-1",
            }),
            { status: 200 },
          ),
      ),
    );

    const result = await backfillArtistImages(50, false);

    expect(result).toMatchObject({
      checkedCount: 1,
      filled: ["artist-1"],
      queueDepth: 0,
      skippedCount: 0,
    });

    const stored = await db.execute({
      args: ["artist-1"],
      sql: `select image_url, image_state, image_failures
            from artists where id = ?`,
    });
    expect(stored.rows[0]).toMatchObject({
      image_failures: 0,
      image_state: "pending",
      image_url: "https://i.scdn.co/image/spotify-1",
    });
  });

  it("keeps an artist pending through five vendor throttle ticks", async () => {
    const id = "2YZyLoL8N0Wb9xBt1NhZWg";
    await db.execute({
      args: [id, "artist-1"],
      sql: `update artists set spotify_artist_id = ?, image_failures = 0 where id = ?`,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 429 })),
    );

    for (let tick = 0; tick < 5; tick += 1) {
      const result = await backfillArtistImages(20, false);
      expect(result).toMatchObject({ failedCount: 0, queueDepth: 1, rateLimited: true });
    }

    const stored = await db.execute({
      args: ["artist-1"],
      sql: `select image_failures, image_state from artists where id = ?`,
    });
    expect(stored.rows[0]).toMatchObject({ image_failures: 0, image_state: "pending" });
  });

  it("fills a newly linked artist through oEmbed without a Spotify Web API call", async () => {
    const id = "4dpARuHxo51G3z768sgnrY";
    await db.execute({
      args: [id, "artist-1"],
      sql: `update artists set spotify_artist_id = ? where id = ?`,
    });
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain("https://open.spotify.com/oembed?");
      return new Response(
        JSON.stringify({
          iframe_url: `https://open.spotify.com/embed/artist/${id}`,
          thumbnail_url:
            "https://image-cdn-ak.spotifycdn.com/image/ab67616100005174e75db75543a89589514259b2",
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await fillMissingArtistImages([id])).toBe(1);
    const stored = await db.execute({
      args: ["artist-1"],
      sql: `select image_url from artists where id = ?`,
    });
    expect(stored.rows[0]?.image_url).toBe(
      "https://i.scdn.co/image/ab6761610000e5ebe75db75543a89589514259b2",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("settles a failing queue head at the cap and still fills the next artist", async () => {
    const firstId = "3TVXtAsR1Inumwj472S9r4";
    const secondId = "7dGJo4pcD2V6oG8kP0tJRR";
    const nowIso = new Date().toISOString();
    await db.execute({
      args: [firstId, "artist-1"],
      sql: `update artists set spotify_artist_id = ?, image_failures = 4 where id = ?`,
    });
    await db.execute({
      args: ["artist-2", "Second Artist", "second-artist", secondId, nowIso, nowIso],
      sql: `insert into artists
              (id, name, slug, spotify_artist_id, created_at, updated_at)
            values (?, ?, ?, ?, ?, ?)`,
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes(firstId)) {
        throw new Error("oEmbed connection failed");
      }
      return new Response(
        JSON.stringify({
          iframe_url: `https://open.spotify.com/embed/artist/${secondId}`,
          thumbnail_url: "https://i.scdn.co/image/second-artist",
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = await backfillArtistImages(20, false);
    expect(first.checkedCount).toBe(2);
    expect(first.failed).toEqual([{ artistId: "artist-1", error: "oEmbed connection failed" }]);
    expect(first.filled).toEqual(["artist-2"]);
    expect(first.queueDepth).toBe(0);

    const stored = await db.execute({
      args: ["artist-1"],
      sql: `select image_state, image_failures from artists where id = ?`,
    });
    expect(stored.rows[0]).toMatchObject({ image_failures: 5, image_state: "none" });
    const second = await backfillArtistImages(20, false);
    expect(second.checkedCount).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
