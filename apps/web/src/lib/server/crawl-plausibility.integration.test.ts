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

let releaseBody: { credits: Credit[]; date: string; recordings: string[] } = {
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
            "artist-credit": releaseBody.credits.map((credit) => ({
              artist: { id: credit.id, name: credit.name },
              name: credit.name,
            })),
            id: recording,
            isrcs: [],
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

  it("never judges a release whose tracks the archive already stores", async () => {
    await seedLabel("2009");
    await seedCatalogueTrack(db, { label: "MTA Records", trackId: "mb_rec-mrs-robinson" });
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
