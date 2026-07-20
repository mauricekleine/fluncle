// `loadHomeData` — the home feed's server-side composition — against a REAL libSQL database (the
// migrations, the finding inner-join, the mixtape merge). The home page is the highest-traffic
// surface, and its loader is a four-read fan-out whose merge rules (findings + mixtapes interleaved
// by date, a findings-only `totalCount`, the newest-finding-with-footage resolved across the WHOLE
// archive) are pure SQL — a mocked-DB test would pass while any of them was broken. So this drives
// the real `listTracks` merge on the real schema, exactly like the server-side integration suites.

import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIntegrationDb, seedCatalogueTrack, seedTrack } from "@/lib/server/integration-db";
import { HOME_PAGE_SIZE, loadHomeData } from "./-home-data";

// The one live database, swapped in fresh for each test. `getDb` closes over it, so the REAL query
// functions (`listTracks`, `getLiveState`, `isGalaxyMapFullyNamed`) run REAL SQL against the REAL
// migrated schema. The route imports `getDb` through `@/lib/server/tracks` → `./db`, the same module
// this alias resolves to.
let db: Client;

vi.mock("@/lib/server/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

// ── Fixtures ─────────────────────────────────────────────────────────────────────────

/** Seed a certified finding, then stamp its `added_at` so the feed order is deterministic. */
async function seedFinding(
  trackId: string,
  logId: string,
  addedAt: string,
  extra: { title?: string } = {},
): Promise<void> {
  await seedTrack(db, { logId, title: extra.title ?? `Finding ${trackId}`, trackId });
  await db.execute({
    args: [addedAt, trackId],
    sql: `update findings set added_at = ? where track_id = ?`,
  });
}

/** Mark a finding as carrying footage (a `video_url`) — the stories-entry signal. */
async function giveFooting(trackId: string): Promise<void> {
  await db.execute({
    args: [`https://videos.example/${trackId}.mp4`, trackId],
    sql: `update findings set video_url = ? where track_id = ?`,
  });
}

/** Seed a published mixtape row — the merge folds it into the feed by `added_at`. */
async function seedMixtape(
  id: string,
  logId: string,
  addedAt: string,
  title: string,
): Promise<void> {
  const now = new Date().toISOString();

  await db.execute({
    args: [id, logId, title, addedAt, now, now],
    sql: `insert into mixtapes (id, log_id, title, status, added_at, created_at, updated_at)
          values (?, ?, ?, 'published', ?, ?, ?)`,
  });
}

/** A `YYYY-01-DD` timestamp — day `n` of January 2026, so a higher `n` sorts NEWER. */
function day(n: number): string {
  return `2026-01-${String(n).padStart(2, "0")}T00:00:00.000Z`;
}

beforeEach(async () => {
  db = await createIntegrationDb();
});

afterEach(() => {
  db.close();
});

describe("loadHomeData — the empty archive", () => {
  it("returns an honest empty shape, no story, offline, and the Galaxies gate closed", async () => {
    const data = await loadHomeData();

    expect(data.tracks).toEqual([]);
    expect(data.totalCount).toBe(0);
    expect(data.nextCursor).toBeUndefined();
    // No finding with footage anywhere ⇒ no stories entry point.
    expect(data.newestStoryLogId).toBeUndefined();
    // The two ambient reads default cleanly on an empty archive (they carry their own tests; here we
    // only prove the loader wires them through).
    expect(data.live.on).toBe(false);
    expect(data.galaxiesLive).toBe(false);
  });
});

describe("loadHomeData — the findings/catalogue split drives totalCount", () => {
  it("returns only findings and counts only findings (a catalogue row is invisible to both)", async () => {
    await seedFinding("t-a", "001.1.1A", day(3));
    await seedFinding("t-b", "002.1.1A", day(2));
    await seedFinding("t-c", "003.1.1A", day(1));
    // A catalogue track — a `tracks` row with NO `findings` row. It must not appear in the feed nor
    // move the count (the count is a `count(*)` over the finding inner-join).
    await seedCatalogueTrack(db, { title: "Uncertified Cut", trackId: "cat-1" });

    const data = await loadHomeData();

    expect(data.tracks).toHaveLength(3);
    expect(data.tracks.every((item) => item.type !== "mixtape")).toBe(true);
    expect(
      data.tracks.map((item) => (item.type === "mixtape" ? item.logId : item.trackId)),
    ).toEqual(["t-a", "t-b", "t-c"]);
    // The count is findings-only — the catalogue row never enters it.
    expect(data.totalCount).toBe(3);
  });
});

describe("loadHomeData — the mixtape merge", () => {
  it("interleaves a published mixtape into the feed by its added_at", async () => {
    await seedFinding("t-new", "010.1.1A", day(5));
    await seedFinding("t-old", "011.1.1A", day(1));
    // A mixtape recorded BETWEEN the two findings — it sorts second, ahead of the older finding.
    await seedMixtape("mix-1", "019.F.1A", day(3), "Deep Space Session");

    const data = await loadHomeData();

    expect(data.tracks).toHaveLength(3);
    expect(data.tracks.map((item) => item.type)).toEqual(["finding", "mixtape", "finding"]);
    const middle = data.tracks[1];
    expect(middle?.type).toBe("mixtape");
    expect(middle?.type === "mixtape" ? middle.logId : undefined).toBe("019.F.1A");
    // The mixtape is a feed item but NOT a finding, so it never enters totalCount.
    expect(data.totalCount).toBe(2);
  });

  it("excludes a draft mixtape from the feed (published-only)", async () => {
    await seedFinding("t-x", "020.1.1A", day(2));
    await db.execute({
      args: ["mix-draft", "021.F.1A", "Unfinished", "2026-01-03T00:00:00.000Z"],
      sql: `insert into mixtapes (id, log_id, title, status, added_at, created_at, updated_at)
            values (?, ?, ?, 'draft', ?, '2026-01-03', '2026-01-03')`,
    });

    const data = await loadHomeData();

    expect(data.tracks).toHaveLength(1);
    expect(data.tracks[0]?.type).toBe("finding");
  });
});

describe("loadHomeData — page one and the stories entry point", () => {
  it("caps page one at HOME_PAGE_SIZE, sets a nextCursor, and returns the newest rows", async () => {
    // Twelve findings, oldest→newest — more than one page, so page one is capped and a cursor opens.
    for (let n = 1; n <= 12; n += 1) {
      await seedFinding(
        `t-${String(n).padStart(2, "0")}`,
        `1${String(n).padStart(2, "0")}.1.1A`,
        day(n),
      );
    }

    const data = await loadHomeData();

    expect(data.tracks).toHaveLength(HOME_PAGE_SIZE);
    // A twelfth finding sits past the page, so the infinite-query contract needs a cursor to fetch on.
    expect(typeof data.nextCursor).toBe("string");
    // The ten NEWEST (day 12 → day 3), newest first.
    expect(
      data.tracks.map((item) => (item.type === "mixtape" ? item.logId : item.trackId)),
    ).toEqual(["t-12", "t-11", "t-10", "t-09", "t-08", "t-07", "t-06", "t-05", "t-04", "t-03"]);
  });

  it("resolves newestStoryLogId from a finding with footage even when it is OFF page one", async () => {
    for (let n = 1; n <= 12; n += 1) {
      await seedFinding(
        `s-${String(n).padStart(2, "0")}`,
        `2${String(n).padStart(2, "0")}.1.1A`,
        day(n),
      );
    }
    // Give footage ONLY to the OLDEST finding (day 1) — it is off page one (page one is days 12→3).
    // The stories entry must still find it, because the footage read scans the WHOLE archive.
    await giveFooting("s-01");

    const data = await loadHomeData();

    expect(data.newestStoryLogId).toBe("201.1.1A");
    // And it is genuinely off page one — proving the loader did not just read the first page.
    const onPageOne = data.tracks.some(
      (item) => item.type !== "mixtape" && item.trackId === "s-01",
    );
    expect(onPageOne).toBe(false);
  });

  it("picks the NEWEST finding with footage when several carry it", async () => {
    await seedFinding("v-1", "030.1.1A", day(1));
    await seedFinding("v-2", "031.1.1A", day(2));
    await seedFinding("v-3", "032.1.1A", day(3));
    await giveFooting("v-1");
    await giveFooting("v-3");

    const data = await loadHomeData();

    expect(data.newestStoryLogId).toBe("032.1.1A");
  });
});

describe("loadHomeData — the Galaxies gate wiring", () => {
  it("reports galaxiesLive true once the whole galaxy map is named", async () => {
    await db.execute({
      args: [],
      sql: `insert into galaxies (id, handle, centroid_json, name, slug, created_at, updated_at)
            values ('g1', 'g-01', '[]', 'The Deep', 'the-deep', '2026-01-01', '2026-01-01')`,
    });

    const data = await loadHomeData();

    expect(data.galaxiesLive).toBe(true);
  });
});
