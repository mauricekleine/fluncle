// `/tracks?sound=<style>` against a REAL migrated libSQL database: the style's anchors resolve to
// their centroids, the probe re-ranks the list closest first, and every other filter is the btree
// pre-filter in front of the one vector pass. Sonar is mocked at its module seam so each case states
// which route the ranking took; the Turso scan itself is real SQL over real `F32_BLOB` vectors.

import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));
const isSonarSonicEnabled = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
const searchSonar = vi.hoisted(() => vi.fn());

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => holder.db };
});

vi.mock("./sonar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sonar")>();

  return { ...actual, isSonarSonicEnabled, searchSonar };
});

import { SEARCH_STYLES } from "../search-styles";
import { createIntegrationDb } from "./integration-db";
import { CatalogueHubPageOutOfRangeError } from "./labels";
import { resetStyleProbeCache } from "./style-probe";
import {
  type TracksHubEntry,
  TRACKS_SOUND_DEPTH,
  listTracksHubPage,
  listTracksHubSoundPage,
  resetTracksHubAggregateCache,
} from "./tracks-hub";

const liquid = SEARCH_STYLES[0];
const NOW = new Date("2026-09-25T12:00:00.000Z");
let db: Client;

/** A unit vector at `angle` radians in the (0,1) plane: cosine similarity is exactly cos(a − b). */
function angleVector(angle: number): Uint8Array {
  const vector = new Float32Array(1024);

  vector[0] = Math.cos(angle);
  vector[1] = Math.sin(angle);

  return new Uint8Array(vector.buffer);
}

async function seedTrack(options: {
  angle?: number;
  key?: string;
  releaseDate: string;
  trackId: string;
}): Promise<void> {
  await db.execute({
    args: [
      options.trackId,
      `Title ${options.trackId}`,
      options.releaseDate,
      `https://open.spotify.com/track/${options.trackId}`,
      options.key ?? null,
      options.angle === undefined ? 0 : 1,
    ],
    sql: `insert into tracks
            (track_id, title, artists_json, release_date, spotify_url, duration_ms, key, has_embedding)
          values (?, ?, '["Artist"]', ?, ?, 210000, ?, ?)`,
  });

  if (options.angle !== undefined) {
    await db.execute({
      args: [options.trackId, angleVector(options.angle)],
      sql: `insert into track_embeddings (track_id, embedding_blob) values (?, ?)`,
    });
  }
}

async function seedAnchor(slug: string, angle: number): Promise<void> {
  await db.execute({
    args: [`anchor-${slug}`, slug, slug],
    sql: `insert into artists (id, name, slug, created_at, updated_at)
          values (?, ?, ?, '2020-01-01', '2020-01-01')`,
  });
  await db.execute({
    args: [`anchor-${slug}`, angleVector(angle)],
    sql: `insert into artist_centroids (artist_id, centroid_blob, computed_at, rank_corpus, vector_count)
          values (?, ?, '2020-01-01', 'corpus-1', 4)`,
  });
}

function ids(entries: TracksHubEntry[]): string[] {
  return entries.map((entry) =>
    entry.kind === "finding" ? entry.finding.trackId : entry.track.trackId,
  );
}

beforeEach(async () => {
  db = await createIntegrationDb();
  holder.db = db;
  resetTracksHubAggregateCache();
  resetStyleProbeCache();
  isSonarSonicEnabled.mockReset();
  isSonarSonicEnabled.mockResolvedValue(false);
  searchSonar.mockReset();

  // The probe sits at 0.5 (two anchors at 0.4 and 0.6). Four A-minor tracks fan away from it, one
  // F-minor track sits right on it, one A-minor track is dated after today, and one has no vector.
  await seedAnchor(liquid.anchors[0] ?? "", 0.4);
  await seedAnchor(liquid.anchors[1] ?? "", 0.6);
  await seedTrack({ angle: 0.5, key: "F minor", releaseDate: "2021-01-01", trackId: "f-exact" });
  await seedTrack({ angle: 0.55, key: "A minor", releaseDate: "2019-01-01", trackId: "a-near" });
  await seedTrack({ angle: 0.9, key: "A minor", releaseDate: "2024-01-01", trackId: "a-mid" });
  await seedTrack({ angle: 1.5, key: "A minor", releaseDate: "2025-01-01", trackId: "a-far" });
  await seedTrack({ angle: 0.5, key: "A minor", releaseDate: "2027-01-01", trackId: "a-future" });
  await seedTrack({ key: "A minor", releaseDate: "2026-01-01", trackId: "a-unembedded" });
});

describe("listTracksHubSoundPage — a style re-ranks, the filters pre-filter", () => {
  it("ranks the pre-filtered set closest first on the Turso scan, released by today", async () => {
    const page = await listTracksHubSoundPage({ key: "A minor" }, liquid, 1, NOW);

    expect(page.ranked).toBe(true);
    expect(page.anchors).toEqual([liquid.anchors[0], liquid.anchors[1]]);
    // The F-minor track is filtered out, the future release is held back, the unembedded track
    // has no sound to rank by: what is left is pure distance to the probe.
    expect(ids(page.hub.items)).toEqual(["a-near", "a-mid", "a-far"]);
    expect(page.hub.total).toBe(3);
    expect(page.hub.pageCount).toBe(1);
    expect(searchSonar).not.toHaveBeenCalled();
  });

  it("marks which rows have a sound to find similar tracks from", async () => {
    await seedTrack({ key: "A minor", releaseDate: "2018-01-01", trackId: "a-silent" });
    const plain = await listTracksHubPage({ key: "A minor" }, 1, NOW);
    const flags = Object.fromEntries(
      plain.items.map((entry) => [
        entry.kind === "catalogue" ? entry.track.trackId : entry.finding.trackId,
        entry.kind === "catalogue" ? entry.similar : true,
      ]),
    );

    expect(flags["a-near"]).toBe(true);
    expect(flags["a-silent"]).toBe(false);
  });

  it("takes Sonar's complete-corpus scan when no column filter is active", async () => {
    isSonarSonicEnabled.mockResolvedValue(true);
    searchSonar.mockResolvedValue([
      { id: "a-future", score: 1 },
      { id: "f-exact", score: 1 },
      { id: "a-near", score: 0.99 },
      { id: "a-mid", score: 0.9 },
    ]);

    const page = await listTracksHubSoundPage({ bpmMin: 170 }, liquid, 1, NOW);

    expect(page.ranked).toBe(true);
    expect(searchSonar).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: { bpm_min: 170 },
        index: "tracks",
        topK: TRACKS_SOUND_DEPTH,
      }),
    );
    // Sonar's order holds; the future release passes the same release-day gate the list applies.
    expect(ids(page.hub.items)).toEqual(["f-exact", "a-near", "a-mid"]);
  });

  it("falls back to the newest-first list, flagged, when the ranking cannot run", async () => {
    const page = await listTracksHubSoundPage({}, liquid, 1, NOW);
    const newest = await listTracksHubPage({}, 1, NOW);

    expect(page.ranked).toBe(false);
    expect(page.anchors).toEqual([liquid.anchors[0], liquid.anchors[1]]);
    expect(ids(page.hub.items)).toEqual(ids(newest.items));
  });

  it("declines to the newest-first list when no anchor has a centroid", async () => {
    await db.execute("delete from artist_centroids");

    const page = await listTracksHubSoundPage({ key: "A minor" }, liquid, 1, NOW);

    expect(page.ranked).toBe(false);
    expect(page.anchors).toEqual([]);
  });

  it("404s a ranked page past the end rather than clamping it", async () => {
    await expect(listTracksHubSoundPage({ key: "A minor" }, liquid, 2, NOW)).rejects.toBeInstanceOf(
      CatalogueHubPageOutOfRangeError,
    );
  });
});
