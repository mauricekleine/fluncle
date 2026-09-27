import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createIntegrationDb, seedCatalogueTrack } from "./integration-db";
import { setMusicbrainzRateLimitForTests } from "./musicbrainz";

let db: Client;
let fixtureDirectory: string | undefined;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

const NOW = "2026-09-27T00:00:00.000Z";
const LABEL_ID = "lbl_mta";
const LABEL_SLUG = "mta-records";
const LABEL_MBID = "label-mta";
const RELEASE = "release-mrs-robinson";
const NODE_ID = `musicbrainz:release:${RELEASE}`;

type Credit = { id: string; name: string };

type ReleaseBody = {
  credits: Credit[];
  date: string;
  isrcs?: Record<string, string[]>;
  recordingCredits?: Record<string, Credit[]>;
  recordings: string[];
};

let releaseBody: ReleaseBody = {
  credits: [{ id: "artist-easy-listening", name: "Easy Listening Orchestra" }],
  date: "1969",
  recordings: ["rec-mrs-robinson", "rec-sounds-of-silence"],
};

function releaseJson(): object {
  return {
    "cover-art-archive": { front: true },
    date: releaseBody.date,
    id: RELEASE,
    "label-info": [{ label: { id: LABEL_MBID, name: "MTA Records" } }],
    media: [
      {
        tracks: releaseBody.recordings.map((recording) => ({
          recording: {
            "artist-credit": (releaseBody.recordingCredits?.[recording] ?? releaseBody.credits).map(
              (credit) => ({
                artist: { id: credit.id, name: credit.name },
                name: credit.name,
              }),
            ),
            id: recording,
            isrcs: releaseBody.isrcs?.[recording] ?? [],
            length: 180_000,
            title: `Title ${recording}`,
          },
        })),
      },
    ],
    relations: [],
    "release-group": { id: `rg-${RELEASE}` },
    title: "Just Some Of Those Songs",
  };
}

async function seedLabel(foundingDate: null | string): Promise<void> {
  await db.execute({
    args: [LABEL_ID, "MTA Records", LABEL_SLUG, LABEL_MBID, foundingDate, NOW, NOW],
    sql: `insert into labels
            (id, name, slug, seed_state, mb_label_id, founding_date, created_at, updated_at)
          values (?, ?, ?, 'enabled', ?, ?, ?, ?)`,
  });
}

async function seedReleaseNode(state: "done" | "pending" = "pending"): Promise<void> {
  await db.execute({
    args: [NODE_ID, RELEASE, LABEL_SLUG, state, NOW, NOW],
    sql: `insert into crawl_frontier
            (id, kind, source, external_id, hop, parent_id, label_slug, state, created_at, updated_at)
          values (?, 'release', 'musicbrainz', ?, 0, null, ?, ?, ?, ?)
          on conflict (id) do update set state = excluded.state, cursor = 0`,
  });
}

async function seedLabelTracks(years: number[], labelId = LABEL_ID): Promise<void> {
  for (const [index, year] of years.entries()) {
    const trackId = `mb_era-${labelId}-${index}`;
    await seedCatalogueTrack(db, { label: "MTA Records", trackId });
    await db.execute({
      args: [labelId, `${year}-01-01`, trackId],
      sql: `update tracks set label_id = ?, release_date = ? where track_id = ?`,
    });
  }
}

async function seedArtistOnEnabledLabel(artistMbid: string): Promise<void> {
  await db.execute({
    args: ["lbl_other", "Other Records", "other-records", NOW, NOW],
    sql: `insert into labels (id, name, slug, seed_state, created_at, updated_at)
          values (?, ?, ?, 'enabled', ?, ?)`,
  });
  await db.execute({
    args: ["art_known", "Known Artist", "known-artist", artistMbid, NOW, NOW],
    sql: `insert into artists (id, name, slug, mbid, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?)`,
  });
  await seedCatalogueTrack(db, { label: "Other Records", trackId: "mb_known-elsewhere" });
  await db.execute({
    args: ["mb_known-elsewhere"],
    sql: `update tracks set label_id = 'lbl_other', release_date = '2015-01-01' where track_id = ?`,
  });
  await db.execute({
    args: ["mb_known-elsewhere", "art_known"],
    sql: `insert into track_artists (track_id, artist_id, position) values (?, ?, 0)`,
  });
}

async function crawlOnce(maxHop = 2) {
  const { crawlCatalogue } = await import("./crawl");

  return crawlCatalogue({ limit: 1, maxHop });
}

async function storedReleaseTracks(): Promise<number> {
  const placeholders = releaseBody.recordings.map(() => "?").join(", ");
  const result = await db.execute({
    args: releaseBody.recordings.map((recording) => `mb_${recording}`),
    sql: `select count(*) as n from tracks where track_id in (${placeholders})`,
  });

  return Number(result.rows[0]?.n ?? 0);
}

async function holdRow(): Promise<Record<string, unknown> | undefined> {
  const result = await db.execute({
    args: [RELEASE],
    sql: `select * from crawl_release_holds where release_mbid = ?`,
  });

  return result.rows[0] as Record<string, unknown> | undefined;
}

async function nodeRow(): Promise<{ note: unknown; state: unknown }> {
  const result = await db.execute({
    args: [NODE_ID],
    sql: `select state, note from crawl_frontier where id = ?`,
  });

  return { note: result.rows[0]?.note, state: result.rows[0]?.state };
}

beforeEach(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "fluncle-crawl-plausibility-"));
  db = await createIntegrationDb({ url: `file:${join(fixtureDirectory, "fixture.db")}` });
  setMusicbrainzRateLimitForTests(0);
  releaseBody = {
    credits: [{ id: "artist-easy-listening", name: "Easy Listening Orchestra" }],
    date: "1969",
    recordings: ["rec-mrs-robinson", "rec-sounds-of-silence"],
  };
  const { resetLabelEraCacheForTests } = await import("./crawl-plausibility");
  resetLabelEraCacheForTests();

  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const body = url.includes(`/release/${RELEASE}`) ? releaseJson() : {};

      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  db.close();

  if (fixtureDirectory) {
    await rm(fixtureDirectory, { force: true, recursive: true });
    fixtureDirectory = undefined;
  }
});

async function seedHeldRows(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await db.execute({
      args: [
        `release-${String(index).padStart(3, "0")}`,
        LABEL_ID,
        `2026-09-27T00:00:${String(index % 60).padStart(2, "0")}.${String(index).padStart(3, "0")}Z`,
      ],
      sql: `insert into crawl_release_holds
              (release_mbid, label_id, artists, track_count, reason, threshold_year,
               created_at, updated_at)
            values (?, ?, '[]', 1, 'before_founding', 2009, ?3, ?3)`,
    });
  }
}

async function seedTapTrack(trackId: string, isrc: string, labelId: string): Promise<void> {
  await seedCatalogueTrack(db, { label: "Tap Label", trackId });
  await db.execute({
    args: [isrc, labelId, trackId],
    sql: "update tracks set isrc = ?, label_id = ? where track_id = ?",
  });
}

function eraInput(release: string, releaseDate: string) {
  return {
    artistMbids: [],
    artistNames: [],
    foundingDate: null,
    labelId: LABEL_ID,
    recordings: [{ isrcs: [], recordingId: `rec-${release}` }],
    releaseDate,
    releaseGroupMbid: null,
    releaseMbid: release,
    releaseTitle: null,
    trackCount: 1,
  };
}

describe("the crawl plausibility hold", () => {
  it("holds a release dated two or more years before its enabled label's founding", async () => {
    await seedLabel("2009");
    await seedReleaseNode();

    const pass = await crawlOnce();

    expect(pass.tracksWritten).toBe(0);
    expect(pass.tracksHeldImplausible).toBe(2);
    expect(pass.tracksSkipped).toBe(2);
    expect(await storedReleaseTracks()).toBe(0);

    const hold = await holdRow();
    expect(hold?.state).toBe("held");
    expect(hold?.reason).toBe("before_founding");
    expect(Number(hold?.threshold_year)).toBe(2009);
    expect(hold?.label_id).toBe(LABEL_ID);
    expect(Number(hold?.track_count)).toBe(2);
    expect(JSON.parse(String(hold?.artists))).toEqual(["Easy Listening Orchestra"]);

    const albums = await db.execute("select count(*) as n from albums");
    expect(Number(albums.rows[0]?.n)).toBe(0);

    const artistNodes = await db.execute(
      "select count(*) as n from crawl_frontier where kind = 'artist'",
    );
    expect(Number(artistNodes.rows[0]?.n)).toBe(0);

    const node = await nodeRow();
    expect(node.state).toBe("done");
    expect(String(node.note)).toContain("held=2 held_reason=before_founding:2009");
  });

  it("stores a release one year before the founding, inside the tolerance", async () => {
    releaseBody.date = "2008-05-26";
    await seedLabel("2009");
    await seedReleaseNode();

    const pass = await crawlOnce();

    expect(pass.tracksWritten).toBe(2);
    expect(pass.tracksHeldImplausible).toBe(0);
    expect(await holdRow()).toBeUndefined();
  });

  it("stores an implausibly dated release when a credited artist is already stored on an enabled label", async () => {
    releaseBody.credits = [{ id: "artist-known", name: "Known Artist" }];
    await seedLabel("2009");
    await seedArtistOnEnabledLabel("artist-known");
    await seedReleaseNode();

    const pass = await crawlOnce();

    expect(pass.tracksWritten).toBe(2);
    expect(await holdRow()).toBeUndefined();
  });

  it("holds a release five or more years older than the label's stored era when no founding is known", async () => {
    releaseBody.date = "2005-03-01";
    await seedLabel(null);
    await seedLabelTracks(Array.from({ length: 20 }, (_, index) => 2015 + (index % 6)));
    await seedReleaseNode();

    const pass = await crawlOnce();

    expect(pass.tracksHeldImplausible).toBe(2);
    const hold = await holdRow();
    expect(hold?.reason).toBe("before_label_era");
    expect(Number(hold?.threshold_year)).toBe(2015);
  });

  it("stores a release inside the label's stored era", async () => {
    releaseBody.date = "2011-03-01";
    await seedLabel(null);
    await seedLabelTracks(Array.from({ length: 20 }, (_, index) => 2015 + (index % 6)));
    await seedReleaseNode();

    const pass = await crawlOnce();

    expect(pass.tracksWritten).toBe(2);
    expect(await holdRow()).toBeUndefined();
  });

  it("reads no era from a label with fewer than twenty dated tracks", async () => {
    releaseBody.date = "1990";
    await seedLabel(null);
    await seedLabelTracks(Array.from({ length: 19 }, () => 2020));
    await seedReleaseNode();

    const pass = await crawlOnce();

    expect(pass.tracksWritten).toBe(2);
    expect(await holdRow()).toBeUndefined();
  });

  it("never judges a release whose tracks the archive already stores on its label", async () => {
    await seedLabel("2009");
    await seedCatalogueTrack(db, { label: "MTA Records", trackId: "mb_rec-mrs-robinson" });
    await db.execute({
      args: [LABEL_ID],
      sql: "update tracks set label_id = ? where track_id = 'mb_rec-mrs-robinson'",
    });
    await seedReleaseNode();

    const pass = await crawlOnce();

    expect(pass.tracksHeldImplausible).toBe(0);
    expect(await holdRow()).toBeUndefined();
  });

  it("stores everything when the operator turns the hold off", async () => {
    await seedLabel("2009");
    await db.execute(
      "insert into settings (key, value) values ('crawl_plausibility_hold_enabled', 'false')",
    );
    await seedReleaseNode();

    const pass = await crawlOnce();

    expect(pass.tracksWritten).toBe(2);
    expect(await holdRow()).toBeUndefined();
  });

  it("keeps a held release held when the walk reaches it again", async () => {
    await seedLabel("2009");
    await seedReleaseNode();
    await crawlOnce();

    await seedArtistOnEnabledLabel("artist-easy-listening");
    await seedReleaseNode("pending");
    const again = await crawlOnce();

    expect(again.tracksHeldImplausible).toBe(2);
    expect(await storedReleaseTracks()).toBe(0);
    expect((await holdRow())?.state).toBe("held");
  });

  it("keeps a kept-out release out when the walk reaches it again, even with the hold switched off", async () => {
    await seedLabel("2009");
    await seedReleaseNode();
    await crawlOnce();

    const { resolveCrawlHold } = await import("./crawl-plausibility");
    await resolveCrawlHold(RELEASE, "keep_out");
    await db.execute(
      "insert into settings (key, value) values ('crawl_plausibility_hold_enabled', 'false')",
    );
    await seedReleaseNode("pending");
    const again = await crawlOnce();

    expect(again.tracksWritten).toBe(0);
    expect(await storedReleaseTracks()).toBe(0);
    expect((await holdRow())?.state).toBe("kept_out");
  });

  it("stores a released hold on the next crawl tick", async () => {
    await seedLabel("2009");
    await seedReleaseNode();
    await crawlOnce();

    const { resolveCrawlHold } = await import("./crawl-plausibility");
    expect(await resolveCrawlHold(RELEASE, "store")).toEqual({ state: "released" });

    const next = await crawlOnce();

    expect(next.tracksWritten).toBe(2);
    expect(await storedReleaseTracks()).toBe(2);

    const hold = await holdRow();
    expect(hold?.state).toBe("released");
    expect(hold?.rearmed_at).not.toBeNull();
    expect(hold?.ruled_at).not.toBeNull();

    const repairs = await db.execute({
      args: [NODE_ID],
      sql: "select count(*) as n from crawl_due_work where node_id = ?",
    });
    expect(Number(repairs.rows[0]?.n)).toBe(1);
  });

  it("stores a released hold whose frontier node had already exhausted its retries", async () => {
    await seedLabel("2009");
    await seedReleaseNode();
    await crawlOnce();
    await db.execute({
      args: [NODE_ID],
      sql: "update crawl_frontier set state = 'failed', failures = 5 where id = ?",
    });

    const { resolveCrawlHold } = await import("./crawl-plausibility");
    await resolveCrawlHold(RELEASE, "store");
    const next = await crawlOnce();

    expect(next.tracksWritten).toBe(2);
    expect(await storedReleaseTracks()).toBe(2);
  });

  it("treats a release as already stored when a stored recording is now refused by an artist block", async () => {
    releaseBody.recordingCredits = {
      "rec-mrs-robinson": [{ id: "artist-blocked", name: "Blocked Act" }],
    };
    await seedLabel("2009");
    await seedCatalogueTrack(db, { label: "MTA Records", trackId: "mb_rec-mrs-robinson" });
    await db.execute({
      args: [LABEL_ID],
      sql: "update tracks set label_id = ? where track_id = 'mb_rec-mrs-robinson'",
    });
    await db.execute({
      args: [NOW, NOW],
      sql: `insert into artist_rules
              (id, artist_mbid, artist_name, verdict, label_id, source, created_at, updated_at)
            values ('arl_block', 'artist-blocked', 'Blocked Act', 'block', null, 'operator', ?, ?)`,
    });
    await seedReleaseNode();

    const pass = await crawlOnce();

    expect(pass.tracksHeldImplausible).toBe(0);
    expect(await holdRow()).toBeUndefined();
  });

  it("treats a release as already stored when the freshness tap stored one of its recordings first", async () => {
    releaseBody.isrcs = { "rec-sounds-of-silence": ["USXX16900001"] };
    await seedLabel("2009");
    await seedTapTrack("sp_tapfirst", "USXX16900001", LABEL_ID);
    await seedReleaseNode();

    const pass = await crawlOnce();

    expect(pass.tracksHeldImplausible).toBe(0);
    expect(await holdRow()).toBeUndefined();
  });

  it("matches a tap-first recording on any of the recording's ISRCs", async () => {
    releaseBody.isrcs = { "rec-sounds-of-silence": ["USXX16900001", "GBXX16900002"] };
    await seedLabel("2009");
    await seedTapTrack("sp_tapfirst", "GBXX16900002", LABEL_ID);
    await seedReleaseNode();

    const pass = await crawlOnce();

    expect(pass.tracksHeldImplausible).toBe(0);
    expect(await holdRow()).toBeUndefined();
  });

  it("counts a stored recording whose label link is missing but whose label text names this label", async () => {
    releaseBody.isrcs = { "rec-sounds-of-silence": ["USXX16900001"] };
    await seedLabel("2009");
    await seedCatalogueTrack(db, { label: "MTA  records", trackId: "5publishedspotifyid" });
    await db.execute(
      "update tracks set isrc = 'USXX16900001', label_id = null where track_id = '5publishedspotifyid'",
    );
    await seedReleaseNode();

    const pass = await crawlOnce();

    expect(pass.tracksHeldImplausible).toBe(0);
    expect(await holdRow()).toBeUndefined();
  });

  it("still holds when an unlinked stored recording names a different label", async () => {
    releaseBody.isrcs = { "rec-sounds-of-silence": ["USXX16900001"] };
    await seedLabel("2009");
    await seedCatalogueTrack(db, { label: "Some Other Imprint", trackId: "5otherspotifyid" });
    await db.execute(
      "update tracks set isrc = 'USXX16900001', label_id = null where track_id = '5otherspotifyid'",
    );
    await seedReleaseNode();

    const pass = await crawlOnce();

    expect(pass.tracksHeldImplausible).toBe(2);
  });

  it("records the threshold of the uncached check that authorised the hold", async () => {
    await seedLabel(null);
    await seedLabelTracks(Array.from({ length: 20 }, () => 2020));
    const { decideReleaseHold } = await import("./crawl-plausibility");

    expect(await decideReleaseHold(db, eraInput("release-probe", "2019-01-01"))).toEqual({
      kind: "store",
    });

    await db.execute({
      args: [LABEL_ID],
      sql: "update tracks set release_date = '2018-01-01' where label_id = ?",
    });

    const decision = await decideReleaseHold(db, eraInput("release-held-fresh", "2010-01-01"));
    expect(decision).toMatchObject({ kind: "hold", thresholdYear: 2018 });

    const stored = await db.execute(
      "select threshold_year, reason from crawl_release_holds where release_mbid = 'release-held-fresh'",
    );
    expect(Number(stored.rows[0]?.threshold_year)).toBe(2018);
    expect(stored.rows[0]?.reason).toBe("before_label_era");
  });

  it("still holds a release whose only stored match is a shared ISRC on another label", async () => {
    releaseBody.isrcs = { "rec-sounds-of-silence": ["USXX16900001"] };
    await seedLabel("2009");
    await db.execute({
      args: [NOW, NOW],
      sql: `insert into labels (id, name, slug, seed_state, created_at, updated_at)
            values ('lbl_elsewhere', 'Elsewhere', 'elsewhere', 'enabled', ?, ?)`,
    });
    await seedTapTrack("sp_shared", "USXX16900001", "lbl_elsewhere");
    await seedReleaseNode();

    const pass = await crawlOnce();

    expect(pass.tracksHeldImplausible).toBe(2);
    expect(pass.tracksWritten).toBe(0);
    expect((await holdRow())?.state).toBe("held");
  });

  it("sees a label's era the moment it crosses twenty dated tracks", async () => {
    await seedLabel(null);
    await seedLabelTracks(Array.from({ length: 19 }, () => 2020));
    const { decideReleaseHold } = await import("./crawl-plausibility");

    expect(await decideReleaseHold(db, eraInput("release-early", "2005-01-01"))).toEqual({
      kind: "store",
    });

    await seedCatalogueTrack(db, { label: "MTA Records", trackId: "mb_era-twentieth" });
    await db.execute({
      args: [LABEL_ID],
      sql: "update tracks set label_id = ?, release_date = '2020-01-01' where track_id = 'mb_era-twentieth'",
    });

    expect((await decideReleaseHold(db, eraInput("release-late", "2005-01-01"))).kind).toBe("hold");
  });

  it("never holds on an era the label's stored catalogue has since moved away from", async () => {
    await seedLabel(null);
    await seedLabelTracks(Array.from({ length: 20 }, () => 2020));
    const { decideReleaseHold } = await import("./crawl-plausibility");

    expect(await decideReleaseHold(db, eraInput("release-probe", "2019-01-01"))).toEqual({
      kind: "store",
    });

    await db.execute({
      args: [LABEL_ID],
      sql: "update tracks set release_date = '1995-01-01' where label_id = ?",
    });

    expect(await decideReleaseHold(db, eraInput("release-after-merge", "2010-01-01"))).toEqual({
      kind: "store",
    });
  });

  it("finds a known artist credited past the hundredth position", async () => {
    await seedArtistOnEnabledLabel("artist-known");
    const { creditedArtistStoredOnEnabledLabel } = await import("./crawl-plausibility");
    const credits = [
      ...Array.from({ length: 150 }, (_, index) => `artist-unknown-${index}`),
      "artist-known",
    ];

    expect(await creditedArtistStoredOnEnabledLabel(db, credits)).toBe(true);
  });

  it("reads no label era when the hold is switched off", async () => {
    releaseBody.date = "2005-03-01";
    await seedLabel(null);
    await seedLabelTracks(Array.from({ length: 20 }, (_, index) => 2015 + (index % 6)));
    await db.execute(
      "insert into settings (key, value) values ('crawl_plausibility_hold_enabled', 'false')",
    );
    const { decideReleaseHold } = await import("./crawl-plausibility");
    const execute = vi.spyOn(db, "execute");

    const decision = await decideReleaseHold(db, {
      artistMbids: [],
      artistNames: [],
      foundingDate: null,
      labelId: LABEL_ID,
      recordings: [{ isrcs: [], recordingId: "rec-flag-off" }],
      releaseDate: "2005-03-01",
      releaseGroupMbid: null,
      releaseMbid: "release-flag-off",
      releaseTitle: null,
      trackCount: 1,
    });

    expect(decision).toEqual({ kind: "store" });
    const eraReads = execute.mock.calls.filter(([statement]) =>
      JSON.stringify(statement).includes("order by release_date"),
    );
    expect(eraReads).toHaveLength(0);
  });

  it("reads a label's era once for many releases on it", async () => {
    await seedLabel(null);
    await seedLabelTracks(Array.from({ length: 20 }, (_, index) => 2015 + (index % 6)));
    const { decideReleaseHold } = await import("./crawl-plausibility");
    const execute = vi.spyOn(db, "execute");

    for (const release of ["release-a", "release-b", "release-c"]) {
      await decideReleaseHold(db, {
        artistMbids: [],
        artistNames: [],
        foundingDate: null,
        labelId: LABEL_ID,
        recordings: [{ isrcs: [], recordingId: `rec-${release}` }],
        releaseDate: "2018-01-01",
        releaseGroupMbid: null,
        releaseMbid: release,
        releaseTitle: null,
        trackCount: 1,
      });
    }

    const eraReads = execute.mock.calls.filter(([statement]) =>
      JSON.stringify(statement).includes("order by release_date"),
    );
    expect(eraReads).toHaveLength(1);
  });

  it("pages through every held release with a cursor", async () => {
    await seedLabel("2009");
    await seedHeldRows(105);
    const { listCrawlHolds } = await import("./crawl-plausibility");

    const first = await listCrawlHolds();
    expect(first.total).toBe(105);
    expect(first.holds).toHaveLength(100);
    expect(first.nextCursor).toBeDefined();

    const second = await listCrawlHolds({ cursor: first.nextCursor });
    expect(second.holds).toHaveLength(5);
    expect(second.nextCursor).toBeUndefined();

    const seen = new Set([...first.holds, ...second.holds].map((hold) => hold.releaseMbid));
    expect(seen.size).toBe(105);

    const { CrawlHoldCursorError } = await import("./crawl-plausibility");
    await expect(listCrawlHolds({ cursor: "not-a-cursor" })).rejects.toBeInstanceOf(
      CrawlHoldCursorError,
    );
  });

  it("refuses to rule on an unknown hold or one already released", async () => {
    const { CrawlHoldAlreadyReleasedError, CrawlHoldNotFoundError, resolveCrawlHold } =
      await import("./crawl-plausibility");

    await expect(resolveCrawlHold("release-unknown", "store")).rejects.toBeInstanceOf(
      CrawlHoldNotFoundError,
    );

    await seedLabel("2009");
    await seedReleaseNode();
    await crawlOnce();
    await resolveCrawlHold(RELEASE, "store");

    await expect(resolveCrawlHold(RELEASE, "keep_out")).rejects.toBeInstanceOf(
      CrawlHoldAlreadyReleasedError,
    );
  });

  it("lists held releases with their label for the operator", async () => {
    await seedLabel("2009");
    await seedReleaseNode();
    await crawlOnce();

    const { listCrawlHolds } = await import("./crawl-plausibility");
    const listed = await listCrawlHolds();

    expect(listed.total).toBe(1);
    expect(listed.holds[0]).toMatchObject({
      artists: ["Easy Listening Orchestra"],
      labelName: "MTA Records",
      labelSlug: LABEL_SLUG,
      reason: "before_founding",
      releaseDate: "1969",
      releaseMbid: RELEASE,
      releaseTitle: "Just Some Of Those Songs",
      state: "held",
      thresholdYear: 2009,
      trackCount: 2,
    });
    expect((await listCrawlHolds({ state: "kept_out" })).total).toBe(0);
  });
});
