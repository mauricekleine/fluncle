import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));
const isSonarLogEnabled = vi.hoisted(() => vi.fn<() => Promise<boolean>>());

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => holder.db };
});

vi.mock("./sonar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sonar")>();

  return {
    ...actual,
    isSonarLogEnabled,
    searchSonar: async () => [{ id: "neighbor", score: 0.95 }],
  };
});

import { resolveAlbumPageData } from "../../routes/-album-page-data";
import { resolveArtistPageData } from "../../routes/-artist-page-data";
import { resolveLabelPageData } from "../../routes/-label-page-data";
import { resolveLogPageData } from "../../routes/-log-page-data";
import {
  createIntegrationDb,
  seedAlbum,
  seedArtist,
  seedCatalogueTrack,
  seedEmbedding,
  seedLabel,
  seedMixtape,
  seedTrack,
  syncHubCounts,
} from "./integration-db";
import { EMBEDDING_DIMS } from "./embedding";
import { getSimilarFindings, getTrackByIdOrLogId, PRIVATE_TRACK_FIELDS } from "./tracks";

let db: Client;

beforeEach(async () => {
  db = await createIntegrationDb();
  holder.db = db;
  isSonarLogEnabled.mockResolvedValue(true);
  await seedArtist(db, { id: "artist", name: "Privacy Artist", slug: "privacy-artist" });
  await seedAlbum(db, { id: "album", name: "Privacy Album", slug: "privacy-album" });
  await seedLabel(db, { id: "label", name: "Privacy Label", slug: "privacy-label" });

  for (const [trackId, logId] of [
    ["finding", "001.1.1A"],
    ["neighbor", "001.1.2B"],
    ["catalogue", null],
  ] as const) {
    const track = { artists: ["Privacy Artist"], title: trackId, trackId };
    if (logId) {
      await seedTrack(db, { ...track, addedAt: "2026-07-01T00:00:00.000Z", logId });
    } else {
      await seedCatalogueTrack(db, track);
    }

    await db.execute({
      args: [`private/${trackId}.webm`, trackId],
      sql: `update tracks set album_id = 'album', album = 'Privacy Album',
        label_id = 'label', label = 'Privacy Label', release_date = '2026-01-01',
        source_audio_key = ?, analyzed_from = 'full', analyzed_at = '2026-07-01T00:00:00.000Z',
        bpm_source = 'operator', key_source = 'rekordbox', source_audio_failures = 3
        where track_id = ?`,
    });
    await db.execute({
      args: [trackId],
      sql: `insert into track_artists (track_id, artist_id, role, position) values (?, 'artist', null, 0)`,
    });
    await seedEmbedding(
      db,
      trackId,
      Array.from({ length: EMBEDDING_DIMS }, (_, index) => (index === 0 ? 1 : 0)),
    );
  }

  await seedMixtape(db, { id: "mixtape", logId: "001.F.1A" });
  await db.execute({
    args: ["mixtape", "finding", 0, 1200],
    sql: `insert into mixtape_tracks (mixtape_id, track_id, position, start_ms) values (?, ?, ?, ?)`,
  });
  await syncHubCounts(db);
});

afterEach(() => {
  db.close();
  holder.db = undefined;
});

describe("public page payload privacy", () => {
  it("the bounded SQL neighbour read serializes without private track fields", async () => {
    isSonarLogEnabled.mockResolvedValue(false);
    const findings = await getSimilarFindings("finding", 6, { allowBoundedSql: true });

    expect(findings.map((track) => track.trackId)).toEqual(["neighbor"]);
    const serialized = JSON.stringify(findings);
    expect(PRIVATE_TRACK_FIELDS.filter((field) => serialized.includes(`"${field}":`))).toEqual([]);
  });

  it.each([
    ["album", () => resolveAlbumPageData("privacy-album")],
    ["artist", () => resolveArtistPageData("privacy-artist", "name", 1)],
    ["label", () => resolveLabelPageData("privacy-label", "name", 1)],
    ["log", () => resolveLogPageData("001.1.1A")],
    ["mixtape log", () => resolveLogPageData("001.F.1A")],
  ] as const)("%s serializes findings without private track fields", async (_page, resolve) => {
    const raw = await getTrackByIdOrLogId("finding");
    for (const field of PRIVATE_TRACK_FIELDS) {
      expect(raw?.[field], field).toBeDefined();
    }

    const payload = await resolve();
    expect(["found", "found-mixtape"]).toContain(payload.status);
    if (payload.status !== "found" && payload.status !== "found-mixtape") {
      throw new Error("Seeded page is missing");
    }

    if (payload.status === "found-mixtape") {
      expect(payload.mixtape.members.map((track) => track.trackId)).toContain("finding");
      expect(payload.mixtape.members[0]?.startMs).toBe(1200);
    } else if ("track" in payload) {
      expect(payload.track.trackId).toBe("finding");
      expect(payload.similar.map((track) => track.trackId)).toContain("neighbor");
      expect(payload.newer?.logId).toBe("001.1.2B");
    } else {
      expect(payload.findings.map((track) => track.trackId)).toContain("finding");
      expect(JSON.stringify(payload.catalogue)).toContain('"trackId":"catalogue"');
    }

    const serialized = JSON.stringify(payload);
    expect(PRIVATE_TRACK_FIELDS.filter((field) => serialized.includes(`"${field}":`))).toEqual([]);
  });
});
