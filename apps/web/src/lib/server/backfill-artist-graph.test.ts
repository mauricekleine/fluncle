import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { backfillArtistGraph } from "../../../scripts/backfill-artist-graph";
import { createIntegrationDb, seedCatalogueTrack, seedTrack } from "./integration-db";

let db: Client;

const CAT_TRACK_ID = "3QKpHwwmOUJfu53agh7UjW";
const NOW = "2026-07-11T00:00:00.000Z";

beforeEach(async () => {
  db = await createIntegrationDb();
});

describe("the artist-graph one-off backfill", () => {
  it("connects only the anchored, not-yet-stable-linked catalogue tracks", async () => {
    await seedCatalogueTrack(db, { artists: ["Nu:Tone"], title: "Roller", trackId: CAT_TRACK_ID });

    await seedTrack(db, { logId: "001.1.1A", title: "Certified", trackId: "fnd1" });

    await seedCatalogueTrack(db, { artists: ["Logistics"], title: "Deep", trackId: "cat2" });
    await db.execute({
      args: ["art-logi", "sp-logi", "Logistics", "logistics", NOW, NOW],
      sql: `insert into artists (id, spotify_artist_id, name, slug, created_at, updated_at)
            values (?, ?, ?, ?, ?, ?)`,
    });
    await db.execute({
      args: ["cat2", "art-logi"],
      sql: `insert into track_artists (track_id, artist_id, position) values (?, ?, 0)`,
    });

    const fetchArtists = vi.fn(() => Promise.resolve({ ids: ["sp-nutone"], names: ["Nu:Tone"] }));
    const link = vi.fn((trackId: string, names: string[], ids: string[]) =>
      db
        .execute({
          args: [`art-${ids[0]}`, ids[0] ?? null, names[0] ?? "", names[0] ?? "", NOW, NOW],
          sql: `insert into artists (id, spotify_artist_id, name, slug, created_at, updated_at)
                values (?, ?, ?, ?, ?, ?)
                on conflict (spotify_artist_id) do nothing`,
        })
        .then(() =>
          db.execute({
            args: [trackId, `art-${ids[0]}`],
            sql: `insert into track_artists (track_id, artist_id, position) values (?, ?, 0)
                  on conflict (track_id, artist_id) do nothing`,
          }),
        )
        .then(() => undefined),
    );

    const result = await backfillArtistGraph(db, fetchArtists, link, { batch: 50, delayMs: 0 });

    expect(fetchArtists).toHaveBeenCalledTimes(1);
    expect(link).toHaveBeenCalledTimes(1);
    expect(link.mock.calls[0]?.[0]).toBe(CAT_TRACK_ID);
    expect(result.linked).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.throttled).toBe(false);

    expect(result.nextCursor).toBeNull();

    const second = await backfillArtistGraph(db, fetchArtists, link, { batch: 50, delayMs: 0 });
    expect(second.linked).toBe(0);
    expect(fetchArtists).toHaveBeenCalledTimes(1);
  });

  it("stops cleanly and reports a resume cursor when Spotify throttles", async () => {
    await seedCatalogueTrack(db, { artists: ["Nu:Tone"], title: "Roller", trackId: CAT_TRACK_ID });

    const fetchArtists = vi.fn(() => Promise.reject(new Error("Spotify request failed: 429")));
    const link = vi.fn(() => Promise.resolve());

    const result = await backfillArtistGraph(db, fetchArtists, link, { batch: 50, delayMs: 0 });

    expect(result.throttled).toBe(true);
    expect(result.linked).toBe(0);
    expect(link).not.toHaveBeenCalled();
  });
});
