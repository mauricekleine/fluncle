// The artist-image worklist and terminal no-image write, executed against the real
// generated schema and real libSQL. Spotify's HTTP edge is stubbed, but the production
// fetchArtistImages classification, selection/count SQL, and UPDATE all run unchanged.

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
    args: ["artist-1", "No Portrait", "no-portrait", "spotify-1", nowIso, nowIso],
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
  it("terminally stamps a matching 200 no-image artist and never selects it again", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://api.spotify.com/v1/artists/spotify-1");

      return new Response(JSON.stringify({ id: "spotify-1", images: [] }), { status: 200 });
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

    // The synchronous create-time helper shares the same pending-only predicate,
    // so a later track upsert cannot reopen the terminal verdict either.
    await expect(fillMissingArtistImages(["spotify-1"])).resolves.toBe(0);

    const second = await backfillArtistImages(50, false);

    expect(second).toMatchObject({
      checkedCount: 0,
      queueDepth: 0,
      skippedCount: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stores an available avatar while leaving it pending for owned-master ingestion", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: "spotify-1",
              images: [{ url: "https://i.scdn.co/image/spotify-1", width: 640 }],
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
      image_failures: 3,
      image_state: "pending",
      image_url: "https://i.scdn.co/image/spotify-1",
    });
  });
});
