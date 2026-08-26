// The `/tracks` hub read, proven against the REAL migrated schema on an in-memory libSQL engine
// (the fresh.test.ts / catalogue-groups.test.ts harness). What is impossible to see without a DB:
//
//   1. THE REGISTER SPLIT. A certified finding comes back lit (its Log ID coordinate); an
//      uncertified catalogue row comes back unlit (no coordinate). Structural, via the flag.
//   2. THE ORDER. Newest RELEASE first (never found date), track_id the stable tiebreak, undated
//      rows LAST (SQLite's native `desc` null placement).
//   3. NUMBERED PAGINATION. Shallow offsets and deep anchored seeks preserve one numbered URL
//      space; a page past the end throws so the route 404s (never clamps), and page 1 of an empty set
//      is a legitimate empty page.
//   4. THE FILTERS. The shared `compileFilters` vocabulary (bpm/key/year/label) + the galaxy
//      extension, which narrows the list to certified findings — composing with the page slice.
//   5. THE LINKED ROW. Artist credits resolve to `/artist/<slug>` via `track_artists`; the imprint
//      resolves to `/label/<slug>` via `tracks.label_id`.
//   6. THE YEAR FAST LANE. Every present release year, newest first, mapped to the page it starts on.

import { type Client, type InStatement } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => holder.db };
});

import { CatalogueHubPageOutOfRangeError } from "./labels";
import { createIntegrationDb } from "./integration-db";
import {
  hubCorpusFingerprint,
  hubPageAnchorsFromRows,
  persistHubPageAnchors,
} from "./hub-page-anchors";
import { parseTracksHubPayload } from "../tracks-search";
import { readKeyHistogram, resetKeyHistogramCache } from "./key-histogram";
import { PUBLIC_PROJECTION_CUTOVER_ENABLED_KEY } from "./public-projection-cutover";
import {
  type TracksHubEntry,
  TRACKS_HUB_ANCHOR_ADDRESS,
  TRACKS_HUB_PAGE_SIZE,
  countAllTracks,
  listTracksHubPage,
  listTracksHubYearLane,
  resetTracksHubAggregateCache,
  resolveTracksHubEntities,
  tracksHubClauses,
  tracksHubAnchorExtractionQuery,
  tracksHubCountQuery,
  tracksHubIdPageQuery,
  tracksHubYearLaneQuery,
  yearPages,
} from "./tracks-hub";

let db: Client;

async function seedTrack(options: {
  bpm?: number;
  key?: string;
  label?: string;
  labelId?: string;
  releaseDate: null | string;
  trackId: string;
}): Promise<void> {
  await db.execute({
    args: [
      options.trackId,
      `Title ${options.trackId}`,
      JSON.stringify(["Artist"]),
      options.releaseDate,
      `https://open.spotify.com/track/${options.trackId}`,
      options.bpm ?? null,
      options.key ?? null,
      options.label ?? null,
      options.labelId ?? null,
    ],
    sql: `insert into tracks
            (track_id, title, artists_json, release_date, spotify_url, duration_ms, bpm, key, label, label_id)
          values (?, ?, ?, ?, ?, 210000, ?, ?, ?, ?)`,
  });
}

async function certify(options: {
  galaxyId?: string;
  logId: string;
  trackId: string;
}): Promise<void> {
  await db.execute({
    args: [options.trackId, options.logId, options.galaxyId ?? null],
    sql: `insert into findings (track_id, log_id, added_at, galaxy_id)
          values (?, ?, '2020-01-01T00:00:00.000Z', ?)`,
  });
  // A certified track HAS a findings row, so the maintained catalogue flag is 0 — mirror the write
  // sites (publishTrack / certifyExistingTrack) so the hub's certification filter, which reads
  // `is_catalogue`, sees a finding as NON-catalogue exactly as production does. seedTrack alone leaves
  // the flag at the DDL default (1); this is the certified-track flip.
  await db.execute({
    args: [options.trackId],
    sql: `update tracks set is_catalogue = 0 where track_id = ?`,
  });
}

async function seedArtist(id: string, name: string, slug: string): Promise<void> {
  await db.execute({
    args: [id, name, slug, "2020-01-01", "2020-01-01"],
    sql: `insert into artists (id, name, slug, created_at, updated_at) values (?, ?, ?, ?, ?)`,
  });
}

async function linkArtist(trackId: string, artistId: string): Promise<void> {
  await db.execute({
    args: [trackId, artistId],
    sql: `insert into track_artists (track_id, artist_id, position) values (?, ?, 1)`,
  });
}

async function seedLabel(id: string, name: string, slug: string): Promise<void> {
  await db.execute({
    args: [id, name, slug, "2020-01-01", "2020-01-01"],
    sql: `insert into labels (id, name, slug, created_at, updated_at) values (?, ?, ?, ?, ?)`,
  });
}

async function seedGalaxy(options: {
  id: string;
  name: null | string;
  slug: null | string;
}): Promise<void> {
  await db.execute({
    args: [options.id, `handle-${options.id}`, options.name, options.slug],
    sql: `insert into galaxies (id, handle, name, slug, centroid_json, created_at, updated_at)
          values (?, ?, ?, ?, '[]', '2020-01-01', '2020-01-01')`,
  });
}

/** The track ids of a page, in order. */
function ids(entries: TracksHubEntry[]): string[] {
  return entries.map((entry) =>
    entry.kind === "finding" ? entry.finding.trackId : entry.track.trackId,
  );
}

beforeEach(async () => {
  db = await createIntegrationDb();
  holder.db = db;
  // The page-independent aggregates (the pager total, the year lane) ride a 60 s in-isolate memo.
  // Each case reseeds a FRESH database behind the same module, so the memo must start cold or a case
  // would read the previous case's totals.
  resetTracksHubAggregateCache();
});

describe("listTracksHubPage — the register split + the linked row", () => {
  it("returns findings lit (a coordinate) and catalogue rows unlit (no coordinate)", async () => {
    await seedTrack({ releaseDate: "2022-01-01", trackId: "f1" });
    await certify({ logId: "200.7.1A", trackId: "f1" });
    await seedTrack({ releaseDate: "2021-01-01", trackId: "c1" });

    const { items } = await listTracksHubPage({}, 1);

    const finding = items.find((entry) => entry.kind === "finding");
    const catalogue = items.find((entry) => entry.kind === "catalogue");

    expect(finding?.kind === "finding" && finding.finding.logId).toBe("200.7.1A");
    // The Unlit Rule: a catalogue row carries no coordinate.
    expect(catalogue?.kind === "catalogue" && "logId" in catalogue.track).toBe(false);
    expect(catalogue?.kind === "catalogue" && catalogue.track.trackId).toBe("c1");
  });

  it("resolves an artist credit to its slug when the entity exists, plain otherwise", async () => {
    await seedArtist("art_1", "Artist", "artist-one");
    await seedTrack({ releaseDate: "2022-01-01", trackId: "linked" });
    await linkArtist("linked", "art_1");
    // No `track_artists` row → no entity → a plain-text credit.
    await seedTrack({ releaseDate: "2021-01-01", trackId: "orphan" });

    const { items } = await listTracksHubPage({}, 1);
    const linked = items.find((entry) => ids([entry])[0] === "linked");
    const orphan = items.find((entry) => ids([entry])[0] === "orphan");

    expect(linked?.artistLinks).toEqual([{ name: "Artist", slug: "artist-one" }]);
    expect(orphan?.artistLinks).toEqual([{ name: "Artist" }]);
  });

  it("carries the imprint slug on both registers when the label has a page", async () => {
    await seedLabel("lbl_1", "Hospital Records", "hospital-records");
    await seedTrack({
      label: "Hospital Records",
      labelId: "lbl_1",
      releaseDate: "2022-01-01",
      trackId: "f1",
    });
    await certify({ logId: "200.7.1A", trackId: "f1" });
    await seedTrack({
      label: "Hospital Records",
      labelId: "lbl_1",
      releaseDate: "2021-01-01",
      trackId: "c1",
    });

    const { items } = await listTracksHubPage({}, 1);
    const finding = items.find((entry) => entry.kind === "finding");
    const catalogue = items.find((entry) => entry.kind === "catalogue");

    expect(finding?.kind === "finding" && finding.finding.labelSlug).toBe("hospital-records");
    expect(catalogue?.kind === "catalogue" && catalogue.labelSlug).toBe("hospital-records");
    expect(catalogue?.kind === "catalogue" && catalogue.label).toBe("Hospital Records");
  });
});

describe("listTracksHubPage — the order", () => {
  it("is newest release first, track_id the tiebreak, undated rows last", async () => {
    await seedTrack({ releaseDate: "2020-05-01", trackId: "old" });
    await seedTrack({ releaseDate: "2023-05-01", trackId: "new" });
    await seedTrack({ releaseDate: "2023-05-01", trackId: "tie" });
    await seedTrack({ releaseDate: null, trackId: "undated" });

    const { items } = await listTracksHubPage({}, 1);

    // 2023 rows first (track_id desc within the tie → "tie" before "new"), then 2020, then null last.
    expect(ids(items)).toEqual(["tie", "new", "old", "undated"]);
  });
});

describe("listTracksHubPage — numbered pagination", () => {
  it("slices into 48-row pages with an honest total + page count", async () => {
    // 50 dated rows → page 1 is full (48), page 2 carries the remaining 2.
    for (let index = 0; index < 50; index += 1) {
      const day = String(index + 1).padStart(2, "0");
      await seedTrack({ releaseDate: `2021-01-${day}`, trackId: `t${day}` });
    }

    const page1 = await listTracksHubPage({}, 1);
    const page2 = await listTracksHubPage({}, 2);

    expect(page1.page).toBe(1);
    expect(page1.total).toBe(50);
    expect(page1.pageCount).toBe(2);
    expect(page1.items).toHaveLength(TRACKS_HUB_PAGE_SIZE);
    expect(page2.items).toHaveLength(2);

    // Every row appears once across the two pages.
    const seen = new Set([...ids(page1.items), ...ids(page2.items)]);
    expect(seen.size).toBe(50);
  });

  it("throws for a page past the end (the route 404s, never clamps)", async () => {
    await seedTrack({ releaseDate: "2022-01-01", trackId: "only" });

    await expect(listTracksHubPage({}, 2)).rejects.toBeInstanceOf(CatalogueHubPageOutOfRangeError);
  });

  it("serves a deep filtered page from memoized anchors and keeps the past-end 404", async () => {
    for (let index = 0; index < 482; index += 1) {
      await seedTrack({
        bpm: 174,
        releaseDate: "2024-01-01",
        trackId: `deep-${String(index).padStart(3, "0")}`,
      });
    }

    const page10 = await listTracksHubPage({ bpmMin: 170 }, 10);
    const page11 = await listTracksHubPage({ bpmMin: 170 }, 11);
    const adjacent = [...ids(page10.items), ...ids(page11.items)];

    expect(page10.items).toHaveLength(48);
    expect(page11.items).toHaveLength(2);
    expect(new Set(adjacent).size).toBe(adjacent.length);
    await expect(listTracksHubPage({ bpmMin: 170 }, 12)).rejects.toBeInstanceOf(
      CatalogueHubPageOutOfRangeError,
    );
  });

  it("serves the deep unfiltered crawler path from its persisted boundary set", async () => {
    for (let index = 0; index < 482; index += 1) {
      await seedTrack({
        releaseDate: "2024-01-01",
        trackId: `persisted-${String(index).padStart(3, "0")}`,
      });
    }

    const extraction = await db.execute(tracksHubAnchorExtractionQuery({}));
    const anchors = hubPageAnchorsFromRows(
      extraction.rows as unknown as Record<string, unknown>[],
      "rd",
      TRACKS_HUB_PAGE_SIZE,
    );
    const first = await db.execute(tracksHubIdPageQuery({}, 1, 0));
    const firstId = (first.rows as unknown as { track_id: string }[])[0]?.track_id;

    await persistHubPageAnchors(
      TRACKS_HUB_ANCHOR_ADDRESS.hub,
      TRACKS_HUB_ANCHOR_ADDRESS.clauseHash,
      anchors,
      hubCorpusFingerprint(482, firstId),
    );

    const page11 = await listTracksHubPage({}, 11);

    expect(page11.items).toHaveLength(2);
    expect(page11.total).toBe(482);
  });

  it("page 1 of an empty result is a legitimate empty page, never a throw", async () => {
    const page = await listTracksHubPage({ bpmMin: 500 }, 1);

    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
    expect(page.pageCount).toBe(1);
  });
});

describe("listTracksHubPage — the filters compose with the page", () => {
  it("filters by BPM range", async () => {
    await seedTrack({ bpm: 174, releaseDate: "2022-01-01", trackId: "dnb" });
    await seedTrack({ bpm: 128, releaseDate: "2022-01-01", trackId: "house" });

    const { items, total } = await listTracksHubPage({ bpmMax: 180, bpmMin: 170 }, 1);

    expect(ids(items)).toEqual(["dnb"]);
    expect(total).toBe(1);
  });

  it("filters by key, folding enharmonic spellings", async () => {
    await seedTrack({ key: "A# minor", releaseDate: "2022-01-01", trackId: "sharp" });
    await seedTrack({ key: "C major", releaseDate: "2022-01-01", trackId: "other" });

    const { items } = await listTracksHubPage({ key: "Bb minor" }, 1);

    expect(ids(items)).toEqual(["sharp"]);
  });

  it("filters by release year range", async () => {
    await seedTrack({ releaseDate: "2015-06-01", trackId: "y2015" });
    await seedTrack({ releaseDate: "2024-06-01", trackId: "y2024" });

    const { items } = await listTracksHubPage({ yearMax: 2026, yearMin: 2020 }, 1);

    expect(ids(items)).toEqual(["y2024"]);
  });

  // A free-typed imprint with no entity behind it is a legitimate filter (the control offers it),
  // so the raw-string compare is the fallback and has to keep working.
  it("filters by label (the raw string, case-insensitively) when no entity holds the name", async () => {
    await seedTrack({ label: "Hospital Records", releaseDate: "2022-01-01", trackId: "hosp" });
    await seedTrack({ label: "Shogun Audio", releaseDate: "2022-01-01", trackId: "shogun" });

    const { items } = await listTracksHubPage({ label: "hospital records" }, 1);

    expect(ids(items)).toEqual(["hosp"]);
  });

  // …and when the entity IS there, the typed name is resolved to `labels.id` first and the filter
  // becomes an indexed seek on `tracks.label_id` — same rows, no `lower(tracks.label)` scan
  // (backlog Wave 3-2). The counter is what the resolver's guard reads, so it is moved here the way
  // the link path moves it.
  it("filters by the label's indexed pointer once the imprint has an entity", async () => {
    await seedLabel("lbl_hosp", "Hospital Records", "hospital-records");
    await db.execute(`update labels set renderable_track_count = 1 where id = 'lbl_hosp'`);
    await seedTrack({
      label: "Hospital Records",
      labelId: "lbl_hosp",
      releaseDate: "2022-01-01",
      trackId: "hosp",
    });
    await seedTrack({ label: "Shogun Audio", releaseDate: "2022-01-01", trackId: "shogun" });

    const resolved = await resolveTracksHubEntities({ label: "Hospital Records" });
    const { items, total } = await listTracksHubPage({ label: "Hospital Records" }, 1);

    expect(resolved).toEqual({ labelId: "lbl_hosp" });
    expect(tracksHubClauses({ label: "Hospital Records" }, resolved)[0]?.sql).toBe(
      "tracks.label_id = ?",
    );
    expect(ids(items)).toEqual(["hosp"]);
    // The pager total rides the same resolved clause set — the memo key IS that clause set, so a
    // count compiled unresolved beside a resolved page read would be two different questions.
    expect(total).toBe(1);
  });

  it("filters by certification (the API tri-state), reading the maintained is_catalogue flag", async () => {
    await seedTrack({ releaseDate: "2022-01-01", trackId: "finding" });
    await certify({ logId: "200.7.1A", trackId: "finding" });
    await seedTrack({ releaseDate: "2021-01-01", trackId: "catalogue_row" });

    // certified: true → is_catalogue = 0 → the finding only.
    const certified = await listTracksHubPage({ certified: true }, 1);
    expect(ids(certified.items)).toEqual(["finding"]);
    expect(certified.total).toBe(1);

    // certified: false → is_catalogue = 1 → the uncertified catalogue row only.
    const uncertified = await listTracksHubPage({ certified: false }, 1);
    expect(ids(uncertified.items)).toEqual(["catalogue_row"]);
    expect(uncertified.total).toBe(1);

    // Absent → both registers.
    const both = await listTracksHubPage({}, 1);
    expect(ids(both.items)).toEqual(["finding", "catalogue_row"]);
    expect(both.total).toBe(2);
  });

  it("filters by galaxy, narrowing the list to certified findings only", async () => {
    await seedGalaxy({ id: "gal_named", name: "Green Sector", slug: "green-sector" });
    await seedTrack({ releaseDate: "2022-01-01", trackId: "in_galaxy" });
    await certify({ galaxyId: "gal_named", logId: "200.7.1A", trackId: "in_galaxy" });
    await seedTrack({ releaseDate: "2022-06-01", trackId: "catalogue_row" });

    const { items } = await listTracksHubPage({ galaxy: "green-sector" }, 1);

    expect(ids(items)).toEqual(["in_galaxy"]);
    expect(items.every((entry) => entry.kind === "finding")).toBe(true);
  });

  it("an unnamed galaxy resolves to nothing (the launch-gate guard in the clause)", async () => {
    await seedGalaxy({ id: "gal_unnamed", name: null, slug: null });
    await seedTrack({ releaseDate: "2022-01-01", trackId: "assigned" });
    await certify({ galaxyId: "gal_unnamed", logId: "200.7.1A", trackId: "assigned" });

    const { items } = await listTracksHubPage({ galaxy: "whatever" }, 1);

    expect(items).toEqual([]);
  });
});

// The serverFn boundary, proven at the COMPILE boundary: the route's validator
// (`parseTracksHubPayload`) is the only gate between a direct RPC payload and `tracksHubClauses`,
// so what survives it is exactly what compiles. `compileFilters` would happily compile
// `artist`/`album`/`text` (the `SearchFilters`-only axes) into LIKE/FTS clauses if they reached it —
// the parse guarantees they never do from this surface.
describe("the /tracks serverFn boundary never compiles beyond the hub vocabulary", () => {
  it("a crafted payload's artist/album/text produce NO clauses; the hub axes still compile", () => {
    const payload = {
      filters: { album: "Ancestors EP", artist: "netsky", bpmMin: 170, text: "hospital" },
      page: 1,
    } as unknown as Parameters<typeof parseTracksHubPayload>[0];

    const clauses = tracksHubClauses(parseTracksHubPayload(payload).filters);

    // Only the legitimate bpm axis compiles — no artists_json LIKE, no album compare, no FTS probe.
    expect(clauses.map((clause) => clause.sql)).toEqual(["tracks.bpm >= ?"]);
  });

  it("a crafted certified flag is stripped, so no is_catalogue clause compiles here", () => {
    const payload = { filters: { certified: true }, page: 1 } as unknown as Parameters<
      typeof parseTracksHubPayload
    >[0];

    expect(tracksHubClauses(parseTracksHubPayload(payload).filters)).toEqual([]);
  });
});

describe("the year fast lane", () => {
  it("maps each present year to the page it starts on, newest first, undated excluded", async () => {
    await seedTrack({ releaseDate: "2024-05-01", trackId: "a" });
    await seedTrack({ releaseDate: "2024-01-01", trackId: "b" });
    await seedTrack({ releaseDate: "2022-01-01", trackId: "c" });
    await seedTrack({ releaseDate: null, trackId: "undated" });

    const lane = await listTracksHubYearLane({});

    // Both years fit on page 1 (4 rows < 48); the undated row is not a year.
    expect(lane).toEqual([
      { page: 1, year: "2024" },
      { page: 1, year: "2022" },
    ]);
  });

  it("composes with an active non-year filter", async () => {
    await seedTrack({ bpm: 174, releaseDate: "2023-01-01", trackId: "dnb" });
    await seedTrack({ bpm: 128, releaseDate: "2024-01-01", trackId: "house" });

    const lane = await listTracksHubYearLane({ bpmMin: 170 });

    expect(lane).toEqual([{ page: 1, year: "2023" }]);
  });

  it("yearPages folds counts to pages by the page size (pure)", () => {
    expect(
      yearPages(
        [
          { n: 50, year: "2024" },
          { n: 10, year: "2023" },
          { n: 5, year: "2022" },
        ],
        48,
      ),
    ).toEqual([
      { page: 1, year: "2024" }, // rank 0
      { page: 2, year: "2023" }, // rank 50 → floor(50/48)+1
      { page: 2, year: "2022" }, // rank 60 → floor(60/48)+1
    ]);
  });

  it("yearPages drops a bucket that is not a four-digit year but still counts its rows", () => {
    // An empty-string `release_date` passes the read's `is not null` gate and folds to an empty
    // `substr(…, 1, 4)`, which renders a lane chip with no text (a nameless link). It is
    // dropped from the lane; its rows still advance the rank so the years after it keep their pages.
    expect(
      yearPages(
        [
          { n: 50, year: "2024" },
          { n: 10, year: "" },
          { n: 5, year: "199" },
          { n: 5, year: "2022" },
        ],
        48,
      ),
    ).toEqual([
      { page: 1, year: "2024" }, // rank 0
      { page: 2, year: "2022" }, // rank 65 → the skipped buckets' 15 rows still counted
    ]);
  });
});

describe("countAllTracks", () => {
  it("counts every held track, findings + catalogue", async () => {
    await seedTrack({ releaseDate: "2022-01-01", trackId: "f1" });
    await certify({ logId: "200.7.1A", trackId: "f1" });
    await seedTrack({ releaseDate: "2021-01-01", trackId: "c1" });
    await seedTrack({ releaseDate: null, trackId: "c2" });

    expect(await countAllTracks()).toBe(3);
  });

  it("uses independently ready projected totals, year/key buckets, and default anchors", async () => {
    await seedTrack({ key: "A minor", releaseDate: "2024-01-01", trackId: "a" });
    await seedTrack({ key: "A minor", releaseDate: "20x?long", trackId: "b" });
    await seedTrack({ key: "C major", releaseDate: "", trackId: "c" });
    const { rebuildDefaultTrackHubAnchors, rebuildPublicProjection } =
      await import("./public-projections");
    await rebuildPublicProjection(db, "public_aggregates", {
      generation: "cutover-aggregate",
      limit: 2,
    });
    await rebuildDefaultTrackHubAnchors(db, { generation: "cutover-aggregate" });
    await db.execute({
      args: [PUBLIC_PROJECTION_CUTOVER_ENABLED_KEY, "true"],
      sql: `insert into settings (key, value) values (?, ?)`,
    });

    const statements: string[] = [];
    const projectedOnly = {
      ...db,
      execute: async (statement: InStatement) => {
        const sql = typeof statement === "string" ? statement : statement.sql;
        statements.push(sql);
        if (
          sql.includes("select count(*) as total\n          from tracks") ||
          sql.includes("group by year") ||
          sql.includes("group by key")
        ) {
          throw new Error("legacy growing aggregate reached");
        }
        return db.execute(statement);
      },
    } as Client;
    holder.db = projectedOnly;
    resetTracksHubAggregateCache();
    resetKeyHistogramCache();

    expect(await countAllTracks()).toBe(3);
    expect(await listTracksHubYearLane({})).toEqual([{ page: 1, year: "2024" }]);
    expect(await readKeyHistogram()).toEqual([
      { count: 2, key: "A minor" },
      { count: 1, key: "C major" },
    ]);
    expect(ids((await listTracksHubPage({}, 1)).items)).toEqual(["b", "a", "c"]);
    expect(statements.some((sql) => sql.includes("insert into hub_page_anchors"))).toBe(false);

    holder.db = db;
    resetTracksHubAggregateCache();
    // Filtered requests remain exact legacy reads; all three fixture BPMs are null.
    expect((await listTracksHubPage({ bpmMin: 1 }, 1)).total).toBe(0);
  });
});

// The scanning reads carry `left join findings` ONLY when a predicate reads a findings column.
// `findings.track_id` is that table's PRIMARY KEY, so the join is 1:0..1 and dropping it cannot
// change a result — but a deep page's offset walk stops paying a discarded PK probe per skipped row,
// and the year lane's grouped scan is left referencing `tracks.release_date` alone. This pins the
// SHAPE (what SQL is emitted); the hosted timings are the bench's job, never this suite's.
describe("the findings join is paid only when a predicate reads it", () => {
  it("drops the join from the id page, the count, and the year lane under tracks-only filters", () => {
    // The certification filter reads the maintained `is_catalogue` flag on `tracks`, not a `findings`
    // column, so it too keeps the join dropped (its whole point — the Keystone-1 quick-win).
    for (const filters of [
      {},
      { bpmMin: 170 },
      { key: "F minor" },
      { label: "Hospital Records" },
      { certified: true },
      { certified: false },
    ]) {
      expect(tracksHubIdPageQuery(filters, 48, 0).sql).not.toContain("findings");
      expect(tracksHubCountQuery(filters).sql).not.toContain("findings");
      expect(tracksHubYearLaneQuery(filters).sql).not.toContain("findings");
    }
  });

  it("keeps the join for a galaxy filter, whose predicate reads findings.galaxy_id", () => {
    expect(tracksHubIdPageQuery({ galaxy: "green-sector" }, 48, 0).sql).toContain(
      "left join findings",
    );
    expect(tracksHubCountQuery({ galaxy: "green-sector" }).sql).toContain("left join findings");
    expect(tracksHubYearLaneQuery({ galaxy: "green-sector" }).sql).toContain("left join findings");
  });

  it("counts the same page total with the join dropped as the join would have produced", async () => {
    // A finding and a catalogue row: were the join not 1:0..1, the certified row would double.
    await seedTrack({ releaseDate: "2022-01-01", trackId: "f1" });
    await certify({ logId: "200.7.1A", trackId: "f1" });
    await seedTrack({ releaseDate: "2021-01-01", trackId: "c1" });

    const { items, total } = await listTracksHubPage({}, 1);

    expect(total).toBe(2);
    expect(ids(items)).toEqual(["f1", "c1"]);
  });
});

describe("the page-independent aggregates are memoised", () => {
  it("serves one total and one year lane across a walk down the pager", async () => {
    await seedTrack({ releaseDate: "2024-01-01", trackId: "a" });
    await seedTrack({ releaseDate: "2023-01-01", trackId: "b" });

    const first = await listTracksHubPage({}, 1);

    // A row added AFTER the memo warmed: the id slice (never memoised) sees it, the total does not
    // until the window rolls. That is the whole trade — a page's ROWS are always current.
    await seedTrack({ releaseDate: "2022-01-01", trackId: "c" });

    const second = await listTracksHubPage({}, 1);

    expect(first.total).toBe(2);
    expect(second.total).toBe(2);
    expect(ids(second.items)).toEqual(["a", "b", "c"]);

    // The memo is per filter SET, so a different filter set is its own live read.
    expect((await listTracksHubPage({ yearMin: 2022 }, 1)).total).toBe(3);
  });

  it("keeps the out-of-range 404 reading the id slice, never the memoised total", async () => {
    await seedTrack({ releaseDate: "2024-01-01", trackId: "a" });

    await expect(listTracksHubPage({}, 2)).rejects.toBeInstanceOf(CatalogueHubPageOutOfRangeError);
  });

  it("evicts a failed load instead of serving the rejection for the rest of the window", async () => {
    await seedTrack({ releaseDate: "2024-01-01", trackId: "a" });
    await db.execute(`alter table tracks rename to tracks_away`);

    await expect(countAllTracks()).rejects.toBeTruthy();

    await db.execute(`alter table tracks_away rename to tracks`);

    // Same memo window: a cached rejection would keep failing here. It recovers, so it did not cache.
    expect(await countAllTracks()).toBe(1);
  });
});
