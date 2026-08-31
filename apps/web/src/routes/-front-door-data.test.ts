// `loadFrontDoorData` — the FRONT DOOR's server-side composition — against a REAL libSQL database
// (the migrations, the finding inner-join, the release window, the maintained hub counters). `/` is
// the page a stranger lands on, and its loader is an eight-read fan-out whose rules are pure SQL and
// pure merge: the lead is the newest finding with a NOTE (not the newest finding), the findings band
// must never repeat that lead, the release band carries BOTH registers, and every count is a real
// number off a real column. A mocked-DB test would pass while any of them was broken, so this drives
// the real reads on the real schema — the `-findings-data.test.ts` shape.

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

// The one live database, swapped in fresh for each test. `getDb` closes over it, so the REAL query
// functions (`listTracks`, `listFreshReleases`, `countAllTracks`, the three hub counts, `getLiveState`)
// run REAL SQL against the REAL migrated schema.
let db: Client;

vi.mock("@/lib/server/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

// ── Fixtures ─────────────────────────────────────────────────────────────────────────

/** Seed a certified finding, then stamp its `added_at` so the band's order is deterministic. */
async function seedFinding(trackId: string, logId: string, addedAt: string): Promise<void> {
  await seedTrack(db, { logId, title: `Finding ${trackId}`, trackId });
  await db.execute({
    args: [addedAt, trackId],
    sql: `update findings set added_at = ? where track_id = ?`,
  });
}

/**
 * Write the editorial note onto a finding — the column `hasNote: true` reads. A note is what makes
 * the lead EDITED rather than merely latest, so this fixture is the whole difference between the
 * loader's two lead paths.
 */
async function writeNote(trackId: string, note: string): Promise<void> {
  await db.execute({
    args: [note, trackId],
    sql: `update findings set note = ? where track_id = ?`,
  });
}

/** Stamp a track's RELEASE date — the release band's ordering key, unrelated to the found date. */
async function releaseOn(trackId: string, releaseDate: string): Promise<void> {
  await db.execute({
    args: [releaseDate, trackId],
    sql: `update tracks set release_date = ? where track_id = ?`,
  });
}

/**
 * Stamp the internal admin/agent-only columns onto a seeded finding's `tracks` row — the
 * `PRIVATE_TRACK_FIELDS` set (`source_audio_key` the R2 key of the CAPTURED full song, plus the
 * `analyzed_*` and `*_source` provenance). A captured finding carries these on the ADMIN read; the
 * front door must strip them from the lead AND the band, and this fixture is what makes a leak
 * reproducible.
 */
async function markCaptured(trackId: string): Promise<void> {
  await db.execute({
    args: [`sources/${trackId}/deadbeef.m4a`, "full", "dsp", "dsp", day(1), trackId],
    sql: `update tracks
          set source_audio_key = ?, analyzed_from = ?, bpm_source = ?, key_source = ?,
              analyzed_at = ?, bpm = 174, key = '2A'
          where track_id = ?`,
  });
}

/**
 * Set the MAINTAINED hub counters production's write paths move as deltas (`hub-counts.ts`). The
 * three browse counts are one `count(*)` over `renderable_track_count >= floor`, so a fixture that
 * only inserts entity rows leaves every counter at the DDL default of 0 and describes a world the
 * archive cannot be in.
 */
async function stampHubCounts(
  table: "albums" | "artists" | "labels",
  id: string,
  renderable: number,
  certified: number,
): Promise<void> {
  await db.execute({
    // `table` is one of three literals chosen here, never reader input; libSQL has no bind slot
    // for an identifier.
    args: [renderable, certified, id],
    sql: `update ${table} set renderable_track_count = ?, certified_finding_count = ? where id = ?`,
  });
}

/** A `2026-01-DD` timestamp — day `n` of January 2026, so a higher `n` sorts NEWER. */
function day(n: number): string {
  return `2026-01-${String(n).padStart(2, "0")}T00:00:00.000Z`;
}

/** The instant the release-window tests read from, so "the last 30 days" is a fixed span of days. */
const RELEASE_NOW = new Date("2026-02-10T12:00:00.000Z");

/** A `YYYY-MM-DD` release date `daysAgo` days before {@link RELEASE_NOW} — inside the window. */
function releasedDaysAgo(daysAgo: number): string {
  return new Date(RELEASE_NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

beforeEach(async () => {
  db = await createIntegrationDb();
  // The tracks hub memoises its aggregates at ISOLATE level, and that memo outlives a fixture: the
  // whole-archive `countAllTracks()` the browse band reads is keyed by filter set, not by database,
  // so without this every case after the first reads the previous case's total.
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
    // The window is echoed for the band's copy ("the last 30 days"), so it is the real constant even
    // when nothing landed in it.
    expect(data.releaseWindowDays).toBe(FRESH_WINDOW_DAYS);
    // The ambient read defaults cleanly on an empty archive (it carries its own tests; here we only
    // prove the loader wires it through).
    expect(data.live.on).toBe(false);
  });
});

describe("loadFrontDoorData — the edited lead", () => {
  it("leads with the finding Fluncle WROTE about, not the newest one", async () => {
    await seedFinding("t-newest", "001.1.1A", day(4));
    await seedFinding("t-noted", "002.1.1A", day(3));
    await seedFinding("t-older", "003.1.1A", day(2));
    // The note sits on a finding that is NOT the newest — the only fixture that can tell an edited
    // lead apart from a latest-row lead.
    await writeNote("t-noted", "The one I keep rewinding.");

    const data = await loadFrontDoorData();

    expect(data.lead?.trackId).toBe("t-noted");
    expect(data.lead?.note).toBe("The one I keep rewinding.");
    // And the newest finding is still in the band beneath it, in its own place.
    expect(data.findings[0]?.trackId).toBe("t-newest");
  });

  it("falls back to the newest finding when nothing carries a note yet", async () => {
    // A young archive, or one the note sweep has not reached. The placement stays honest — just not
    // yet edited — rather than shipping a hole where the door should be.
    await seedFinding("t-a", "010.1.1A", day(1));
    await seedFinding("t-b", "011.1.1A", day(3));
    await seedFinding("t-c", "012.1.1A", day(2));

    const data = await loadFrontDoorData();

    expect(data.lead?.trackId).toBe("t-b");
  });
});

describe("loadFrontDoorData — the band under the lead", () => {
  it("never repeats the lead, and still fills the band when the lead IS the newest finding", async () => {
    // FRONT_DOOR_FINDINGS + 2 findings, oldest→newest, with the note on the NEWEST: the one case
    // where the lead and the band's first row would collide. The loader reads one extra row so the
    // band is still full after the duplicate is dropped.
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
    // The note sits on the OLDEST finding, so the lead is off the band entirely and the band is
    // purely the newest rows in found order.
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
    // A catalogue track — a `tracks` row with NO `findings` row. The findings band is a window onto
    // the LOG, so an uncertified row must be invisible to its total (the count drives the "All N"
    // link, which points at `/findings`).
    await seedCatalogueTrack(db, { title: "Uncertified Cut", trackId: "cat-1" });
    await seedCatalogueTrack(db, { title: "Another Uncertified Cut", trackId: "cat-2" });

    const data = await loadFrontDoorData();

    expect(data.findingsTotal).toBe(3);
    expect(data.findings.map((finding) => finding.trackId)).not.toContain("cat-1");
  });
});

describe("loadFrontDoorData — the public strip", () => {
  it("strips PRIVATE_TRACK_FIELDS from the lead and from every band row", async () => {
    // A CAPTURED finding carries the R2 key of the copyrighted full song plus the analysis
    // provenance on the admin read. `/` is edge-cached SSR HTML served to everyone, so both the
    // lead and the band have to go out through `toPublicTrackListItem`.
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
    // The public VALUES survive the strip — the door still prints bpm/key, never their `*_source`.
    expect(data.lead?.bpm).toBe(174);
    expect(data.lead?.key).toBe("2A");
  });
});

describe("loadFrontDoorData — the release band carries both registers", () => {
  it("streams a certified finding and an uncertified row together, and only the finding carries a coordinate", async () => {
    await seedFinding("r-finding", "050.1.1A", day(1));
    await releaseOn("r-finding", releasedDaysAgo(2));
    // The unlit half: a `tracks` row with no `findings` row. It belongs in the band — it just came
    // out — and it is never named, never given a coordinate (DESIGN.md's Unlit Rule).
    await seedCatalogueTrack(db, { title: "Quiet Pressing", trackId: "r-catalogue" });
    await releaseOn("r-catalogue", releasedDaysAgo(4));

    const data = await loadFrontDoorData(RELEASE_NOW);

    expect(data.releases).toHaveLength(2);
    const finding = data.releases.find((entry) => entry.kind === "finding");
    const catalogue = data.releases.find((entry) => entry.kind === "catalogue");
    expect(finding?.kind === "finding" ? finding.finding.logId : undefined).toBe("050.1.1A");
    // The STRUCTURAL half of the Unlit Rule: the uncertified entry has no coordinate field at all,
    // so no surface downstream can print one or link it into the log.
    expect(catalogue?.kind === "catalogue" ? "logId" in catalogue.track : true).toBe(false);
    expect(catalogue?.kind === "catalogue" ? catalogue.track.trackId : undefined).toBe(
      "r-catalogue",
    );
  });

  it("caps the band at FRONT_DOOR_RELEASES and hands the rest to /fresh", async () => {
    for (let n = 1; n <= FRONT_DOOR_RELEASES + 3; n += 1) {
      const trackId = `w-${String(n).padStart(2, "0")}`;
      await seedCatalogueTrack(db, { title: `Window Release ${n}`, trackId });
      await releaseOn(trackId, releasedDaysAgo(n));
    }

    const data = await loadFrontDoorData(RELEASE_NOW);

    expect(data.releases).toHaveLength(FRONT_DOOR_RELEASES);
    // Newest release first — the band's whole claim is "what just came out".
    expect(data.releases[0]?.releaseDate).toBe(releasedDaysAgo(1));
  });
});

describe("loadFrontDoorData — the browse counts are real numbers off real columns", () => {
  it("counts every entity that clears the thin-content floor, and no entity below it", async () => {
    // Three tracks, all wired to one artist / label / album, so the counters below describe edges
    // that genuinely exist.
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
    // A second entity of each kind, one renderable track short of the floor. It has a page and a
    // 200, but it is not part of the shelf the door offers a number for.
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

    // The browse band never counts the uncertified tier separately or names it; "tracks" is true of
    // every row beneath it.
    expect(data.counts.tracks).toBe(3);
    expect(data.findingsTotal).toBe(1);
  });
});
