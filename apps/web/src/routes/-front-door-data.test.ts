import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FRESH_WINDOW_DAYS } from "@/lib/server/fresh";
import {
  createIntegrationDb,
  seedAlbum,
  seedArtist,
  seedCatalogueTrack,
  seedLabel,
  seedTrack,
} from "@/lib/server/integration-db";
import { resetTracksHubAggregateCache } from "@/lib/server/tracks-hub";
import { FRONT_DOOR_FINDINGS, FRONT_DOOR_RELEASES, loadFrontDoorData } from "./-front-door-data";

let db: Client;

vi.mock("@/lib/server/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

async function seedFinding(trackId: string, logId: string, addedAt: string): Promise<void> {
  await seedTrack(db, { logId, title: `Finding ${trackId}`, trackId });
  await db.execute({
    args: [addedAt, trackId],
    sql: `update findings set added_at = ? where track_id = ?`,
  });
}

async function writeNote(trackId: string, note: string): Promise<void> {
  await db.execute({
    args: [note, trackId],
    sql: `update findings set note = ? where track_id = ?`,
  });
}

async function releaseOn(trackId: string, releaseDate: string): Promise<void> {
  await db.execute({
    args: [releaseDate, trackId],
    sql: `update tracks set release_date = ? where track_id = ?`,
  });
}

async function markCaptured(trackId: string): Promise<void> {
  await db.execute({
    args: [`sources/${trackId}/deadbeef.m4a`, "full", "dsp", "dsp", day(1), trackId],
    sql: `update tracks
          set source_audio_key = ?, analyzed_from = ?, bpm_source = ?, key_source = ?,
              analyzed_at = ?, bpm = 174, key = '2A'
          where track_id = ?`,
  });
}

async function stampHubCounts(
  table: "albums" | "artists" | "labels",
  id: string,
  renderable: number,
  certified: number,
): Promise<void> {
  await db.execute({
    args: [renderable, certified, id],
    sql: `update ${table} set renderable_track_count = ?, certified_finding_count = ? where id = ?`,
  });
}

function day(n: number): string {
  return `2026-01-${String(n).padStart(2, "0")}T00:00:00.000Z`;
}

const RELEASE_NOW = new Date("2026-02-10T12:00:00.000Z");

function releasedDaysAgo(daysAgo: number): string {
  return new Date(RELEASE_NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

beforeEach(async () => {
  db = await createIntegrationDb();

  resetTracksHubAggregateCache();
});

afterEach(() => {
  db.close();
});

describe("loadFrontDoorData — the empty archive", () => {
  it("returns an honest empty shape rather than throwing (a door with nothing behind it still opens)", async () => {
    const data = await loadFrontDoorData();

    expect(data.lead).toBeUndefined();
    expect(data.findings).toEqual([]);
    expect(data.findingsTotal).toBe(0);
    expect(data.releases).toEqual([]);
    expect(data.counts).toEqual({ albums: 0, artists: 0, labels: 0, tracks: 0 });

    expect(data.releaseWindowDays).toBe(FRESH_WINDOW_DAYS);

    expect(data.live.on).toBe(false);
  });
});

describe("loadFrontDoorData — the edited lead", () => {
  it("holds future noted findings out of the lead and findings band", async () => {
    await seedFinding("released", "001.1.1A", day(2));
    await writeNote("released", "Still on the deck.");
    await releaseOn("released", "2026-02-10");
    await seedFinding("future", "002.1.1A", day(3));
    await writeNote("future", "Waiting for release.");
    await releaseOn("future", "2026-02-11");

    const data = await loadFrontDoorData(RELEASE_NOW);
    expect(data.lead?.trackId).toBe("released");
    expect(data.findings.map((finding) => finding.trackId)).not.toContain("future");
  });

  it("leads with the finding Fluncle WROTE about, not the newest one", async () => {
    await seedFinding("t-newest", "001.1.1A", day(4));
    await seedFinding("t-noted", "002.1.1A", day(3));
    await seedFinding("t-older", "003.1.1A", day(2));

    await writeNote("t-noted", "The one I keep rewinding.");

    const data = await loadFrontDoorData();

    expect(data.lead?.trackId).toBe("t-noted");
    expect(data.lead?.note).toBe("The one I keep rewinding.");

    expect(data.findings[0]?.trackId).toBe("t-newest");
  });

  it("falls back to the newest finding when nothing carries a note yet", async () => {
    await seedFinding("t-a", "010.1.1A", day(1));
    await seedFinding("t-b", "011.1.1A", day(3));
    await seedFinding("t-c", "012.1.1A", day(2));

    const data = await loadFrontDoorData();

    expect(data.lead?.trackId).toBe("t-b");
  });
});

describe("loadFrontDoorData — the band under the lead", () => {
  it("never repeats the lead, and still fills the band when the lead IS the newest finding", async () => {
    for (let n = 1; n <= FRONT_DOOR_FINDINGS + 2; n += 1) {
      await seedFinding(
        `d-${String(n).padStart(2, "0")}`,
        `1${String(n).padStart(2, "0")}.1.1A`,
        day(n),
      );
    }
    const newest = `d-${String(FRONT_DOOR_FINDINGS + 2).padStart(2, "0")}`;
    await writeNote(newest, "Straight to the top of the log.");

    const data = await loadFrontDoorData();

    expect(data.lead?.trackId).toBe(newest);
    expect(data.findings.map((finding) => finding.trackId)).not.toContain(newest);
    expect(data.findings).toHaveLength(FRONT_DOOR_FINDINGS);
  });

  it("caps the band at FRONT_DOOR_FINDINGS, newest-found first", async () => {
    for (let n = 1; n <= FRONT_DOOR_FINDINGS + 2; n += 1) {
      await seedFinding(
        `c-${String(n).padStart(2, "0")}`,
        `2${String(n).padStart(2, "0")}.1.1A`,
        day(n),
      );
    }

    await writeNote("c-01", "Dug this one out of the bottom of the crate.");

    const data = await loadFrontDoorData();

    expect(data.lead?.trackId).toBe("c-01");
    expect(data.findings).toHaveLength(FRONT_DOOR_FINDINGS);
    expect(data.findings.map((finding) => finding.trackId)).toEqual([
      "c-08",
      "c-07",
      "c-06",
      "c-05",
      "c-04",
      "c-03",
    ]);
  });

  it("counts findings only — a catalogue row never moves findingsTotal", async () => {
    await seedFinding("f-a", "030.1.1A", day(3));
    await seedFinding("f-b", "031.1.1A", day(2));
    await seedFinding("f-c", "032.1.1A", day(1));

    await seedCatalogueTrack(db, { title: "Uncertified Cut", trackId: "cat-1" });
    await seedCatalogueTrack(db, { title: "Another Uncertified Cut", trackId: "cat-2" });

    const data = await loadFrontDoorData();

    expect(data.findingsTotal).toBe(3);
    expect(data.findings.map((finding) => finding.trackId)).not.toContain("cat-1");
  });
});

describe("loadFrontDoorData — the public strip", () => {
  it("strips PRIVATE_TRACK_FIELDS from the lead and from every band row", async () => {
    await seedFinding("p-lead", "040.1.1A", day(2));
    await seedFinding("p-band", "041.1.1A", day(1));
    await writeNote("p-lead", "Captured, logged, still ringing.");
    await markCaptured("p-lead");
    await markCaptured("p-band");

    const data = await loadFrontDoorData();

    const rows = [data.lead, ...data.findings];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const fields = row as Record<string, unknown>;
      expect(fields.sourceAudioKey).toBeUndefined();
      expect(fields.bpmSource).toBeUndefined();
      expect(fields.keySource).toBeUndefined();
      expect(fields.analyzedAt).toBeUndefined();
      expect(fields.analyzedFrom).toBeUndefined();
    }

    expect(data.lead?.bpm).toBe(174);
    expect(data.lead?.key).toBe("2A");
  });
});

describe("loadFrontDoorData — the release band carries both registers", () => {
  it("lists a certified finding and an uncertified row as releases, and only the finding carries a coordinate", async () => {
    await seedFinding("r-finding", "050.1.1A", day(1));
    await releaseOn("r-finding", releasedDaysAgo(2));

    await seedCatalogueTrack(db, { title: "Quiet Pressing", trackId: "r-catalogue" });
    await releaseOn("r-catalogue", releasedDaysAgo(4));
    await seedCatalogueTrack(db, { title: "Later Pressing", trackId: "r-future" });
    await releaseOn("r-future", releasedDaysAgo(-1));
    await seedCatalogueTrack(db, { title: "Month Pressing", trackId: "r-month" });
    await releaseOn("r-month", "2026-02");

    const data = await loadFrontDoorData(RELEASE_NOW);
    const trackIds = data.releases.flatMap((release) =>
      release.tracks.map((track) => track.trackId),
    );

    expect(data.releases).toHaveLength(3);
    expect(trackIds).not.toContain("r-future");
    expect(trackIds).toContain("r-month");
    expect(data.counts.tracks).toBe(3);

    const finding = data.releases.find((release) => release.lit);
    const catalogue = data.releases.find((release) => release.key === "track:r-catalogue");
    expect(finding?.tracks[0]?.lit).toBe(true);
    expect(finding?.tracks[0]?.logId).toBe("050.1.1A");

    expect(catalogue?.lit).toBe(false);
    expect(catalogue?.tracks[0]?.lit).toBe(false);
    expect(catalogue?.tracks[0] ? "logId" in catalogue.tracks[0] : true).toBe(false);
  });

  it("folds every track on one album entity into one release, lit when any track is a finding", async () => {
    await seedAlbum(db, { id: "album-ep", name: "Two Sides EP", slug: "two-sides-ep" });
    await seedFinding("ep-finding", "051.1.1A", day(1));
    await seedCatalogueTrack(db, { title: "B Side", trackId: "ep-catalogue" });
    for (const trackId of ["ep-finding", "ep-catalogue"]) {
      await releaseOn(trackId, releasedDaysAgo(3));
      await db.execute({
        args: [trackId],
        sql: `update tracks set album_id = 'album-ep', album = 'Two Sides EP' where track_id = ?`,
      });
    }

    await db.execute({
      sql: `update tracks set isrc = 'GBAAA2600001' where track_id = 'ep-catalogue'`,
    });
    await db.execute({
      sql: `update tracks set isrc = 'GBAAA2600002' where track_id = 'ep-finding'`,
    });

    const data = await loadFrontDoorData(RELEASE_NOW);

    expect(data.releases).toHaveLength(1);
    const release = data.releases[0];
    expect(release).toMatchObject({
      albumSlug: "two-sides-ep",
      key: "album:two-sides-ep",
      lit: true,
      title: "Two Sides EP",
    });

    expect(release?.tracks.map((track) => [track.trackId, track.lit])).toEqual([
      ["ep-catalogue", false],
      ["ep-finding", true],
    ]);
  });

  it("fills its releases even when a few long records crowd the head of the window", async () => {
    for (let album = 1; album <= 6; album += 1) {
      await seedAlbum(db, {
        id: `alb-${album}`,
        name: `Long Player ${album}`,
        slug: `long-player-${album}`,
      });
      for (let track = 1; track <= 10; track += 1) {
        const trackId = `lp-${album}-${String(track).padStart(2, "0")}`;
        await seedCatalogueTrack(db, { title: `LP ${album} Track ${track}`, trackId });
        await releaseOn(trackId, releasedDaysAgo(1));
        await db.execute({
          args: [`alb-${album}`, trackId],
          sql: `update tracks set album_id = ? where track_id = ?`,
        });
      }
    }
    for (const [trackId, days] of [
      ["single-a", 3],
      ["single-b", 4],
    ] as const) {
      await seedCatalogueTrack(db, { title: `Single ${trackId}`, trackId });
      await releaseOn(trackId, releasedDaysAgo(days));
    }

    const data = await loadFrontDoorData(RELEASE_NOW);

    expect(data.releases).toHaveLength(FRONT_DOOR_RELEASES);
    expect(data.releases.map((release) => release.key).slice(-2)).toEqual([
      "track:single-a",
      "track:single-b",
    ]);

    expect(data.releases[0]?.tracks).toHaveLength(10);
  });

  it("caps the band at FRONT_DOOR_RELEASES and hands the rest to /fresh", async () => {
    for (let n = 1; n <= FRONT_DOOR_RELEASES + 3; n += 1) {
      const trackId = `w-${String(n).padStart(2, "0")}`;
      await seedCatalogueTrack(db, { title: `Window Release ${n}`, trackId });
      await releaseOn(trackId, releasedDaysAgo(n));
    }

    const data = await loadFrontDoorData(RELEASE_NOW);

    expect(data.releases).toHaveLength(FRONT_DOOR_RELEASES);

    expect(data.releases[0]?.releaseDate).toBe(releasedDaysAgo(1));
  });
});

describe("loadFrontDoorData — the browse counts are real numbers off real columns", () => {
  it("counts every entity that clears the thin-content floor, and no entity below it", async () => {
    for (let n = 1; n <= 3; n += 1) {
      await seedFinding(`b-${n}`, `06${n}.1.1A`, day(n));
    }
    await seedArtist(db, { id: "artist-lit", name: "Lit Artist", slug: "lit-artist" });
    await seedLabel(db, { id: "label-lit", name: "Lit Label", slug: "lit-label" });
    await seedAlbum(db, { id: "album-lit", name: "Lit Album", slug: "lit-album" });
    for (let n = 1; n <= 3; n += 1) {
      await db.execute({
        args: [`b-${n}`],
        sql: `update tracks set album_id = 'album-lit', label_id = 'label-lit' where track_id = ?`,
      });
      await db.execute({
        args: [`b-${n}`, n - 1],
        sql: `insert into track_artists (track_id, artist_id, position) values (?, 'artist-lit', ?)`,
      });
    }
    await stampHubCounts("artists", "artist-lit", 3, 3);
    await stampHubCounts("labels", "label-lit", 3, 3);
    await stampHubCounts("albums", "album-lit", 3, 3);

    await seedArtist(db, { id: "artist-thin", name: "Thin Artist", slug: "thin-artist" });
    await seedLabel(db, { id: "label-thin", name: "Thin Label", slug: "thin-label" });
    await seedAlbum(db, { id: "album-thin", name: "Thin Album", slug: "thin-album" });
    await stampHubCounts("artists", "artist-thin", 2, 2);
    await stampHubCounts("labels", "label-thin", 2, 2);
    await stampHubCounts("albums", "album-thin", 2, 2);

    const data = await loadFrontDoorData();

    expect(data.counts.artists).toBe(1);
    expect(data.counts.labels).toBe(1);
    expect(data.counts.albums).toBe(1);
    expect(data.counts.tracks).toBe(3);
  });

  it("counts tracks as a SUPERSET — findings and the wider archive under one honest noun", async () => {
    await seedFinding("s-finding", "070.1.1A", day(1));
    await seedCatalogueTrack(db, { title: "Quiet One", trackId: "s-catalogue-1" });
    await seedCatalogueTrack(db, { title: "Quiet Two", trackId: "s-catalogue-2" });

    const data = await loadFrontDoorData();

    expect(data.counts.tracks).toBe(3);
    expect(data.findingsTotal).toBe(1);
  });
});
