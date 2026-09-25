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
import { LONG_FORM_MS } from "../catalogue-eligibility";
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

  for (const [index, slug] of liquid.anchors.entries()) {
    await seedAnchor(slug, 0.5 + (index - (liquid.anchors.length - 1) / 2) * 0.02);
  }
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
    expect(page.anchors).toEqual([...liquid.anchors]);
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
      { id: "f-exact", score: 1 },
      { id: "a-near", score: 0.99 },
      { id: "a-mid", score: 0.9 },
    ]);

    const page = await listTracksHubSoundPage({ bpmMin: 170 }, liquid, 1, NOW);

    expect(page.ranked).toBe(true);
    expect(searchSonar).toHaveBeenCalledWith(
      expect.objectContaining({
        excludeIds: ["a-future"],
        filter: { bpm_min: 170, has_finding: true },
        index: "tracks",
        topK: TRACKS_SOUND_DEPTH,
      }),
    );
    expect(searchSonar).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: { bpm_min: 170, duration_ms_max: LONG_FORM_MS, has_finding: false },
      }),
    );
    expect(ids(page.hub.items)).toEqual(["f-exact", "a-near", "a-mid"]);
  });

  it("falls back to the newest-first list, flagged, when the ranking cannot run", async () => {
    const page = await listTracksHubSoundPage({}, liquid, 1, NOW);
    const newest = await listTracksHubPage({}, 1, NOW);

    expect(page.ranked).toBe(false);
    expect(page.anchors).toEqual([...liquid.anchors]);
    expect(ids(page.hub.items)).toEqual(ids(newest.items));
  });

  it("never ranks by an unmeasured probe: one anchor without a centroid means no order yet", async () => {
    await db.execute({
      args: [`anchor-${liquid.anchors[0] ?? ""}`],
      sql: "delete from artist_centroids where artist_id = ?",
    });

    const page = await listTracksHubSoundPage({ key: "A minor" }, liquid, 1, NOW);

    expect(page.ranked).toBe(false);
    expect(page.anchors).toEqual([]);
  });

  it("declines to the newest-first list when no anchor has a centroid", async () => {
    await db.execute("delete from artist_centroids");

    const page = await listTracksHubSoundPage({ key: "A minor" }, liquid, 1, NOW);

    expect(page.ranked).toBe(false);
    expect(page.anchors).toEqual([]);
  });

  it("waits for the caller's budget verdict before any ranking work", async () => {
    isSonarSonicEnabled.mockResolvedValue(true);

    await expect(
      listTracksHubSoundPage({}, liquid, 1, NOW, {
        beforeVector: async () => {
          throw new Error("over the per-IP budget");
        },
      }),
    ).rejects.toThrow("over the per-IP budget");
    expect(searchSonar).not.toHaveBeenCalled();
  });

  it("404s a ranked page past the end rather than clamping it", async () => {
    await expect(listTracksHubSoundPage({ key: "A minor" }, liquid, 2, NOW)).rejects.toBeInstanceOf(
      CatalogueHubPageOutOfRangeError,
    );
  });
});
