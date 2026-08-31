import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { collectSitemapBag, collectSitemapIndexStats } from "./sitemap-data";
import {
  createIntegrationDb,
  seedAlbum,
  seedCatalogueTrack,
  seedEmbedding,
  seedTrack,
} from "./integration-db";
import { EMBEDDING_DIMS } from "./embedding";
import { listSonicNeighbours, readTrackDestination } from "./track-page";
import { sameAsUrls } from "../track-page";
import { resolveTrackPageData } from "../../routes/-track-page-data";

// THE ARCHIVE TRACK DESTINATION, over a real schema.
//
// Five shapes, because five shapes is what the surface actually has to survive, and four of them
// only exist because the archive is mostly UNCERTIFIED and mostly UNENRICHED:
//
//   1. a CERTIFIED track            — its destination is `/log`, permanently, and always was;
//   2. an EVIDENCE-RICH uncertified — a page, indexed, and in the sitemap;
//   3. a THIN uncertified           — a page, reachable and navigable, deliberately NOT indexed
//                                      and deliberately NOT in the sitemap;
//   4. a track with NO listening source at all — a page that offers no outbound control rather
//                                      than a dead one;
//   5. a track whose media is absent — no cover to preload, no preview anchor to play.
//
// The fifth shape's BROWSER half (a cover URL that 404s at request time, a preview relay that
// answers empty) is `tests/e2e/track.spec.ts`; what is provable here is the data half — the page
// asks for nothing it does not hold.
//
// ── THE ONE-EXPRESSION GUARANTEE ──────────────────────────────────────────────────────────────
// The page's `indexable` and the sitemap's membership are the SAME SQL expression
// (`TRACK_PAGE_INDEXABLE_WHERE`), one evaluated as a column and the other as a `where`. Two
// definitions that can drift is the defect this file exists to make impossible: every shape below
// is asserted on BOTH sides, so a change that moves one without the other fails here.
//
// It runs on the in-memory libSQL database built from the generated migrations, so the schema
// under test is byte-identical to production.

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

const CERTIFIED = "certified-track-1";
const RICH = "mb_rich-uncertified-1";
const THIN = "mb_thin-uncertified-1";
const SOURCELESS = "mb_sourceless-1";
const DUPLICATE = "mb_duplicate-twin-1";

/** Stamp the four evidence columns onto a row — the shape the enrichment sweeps eventually reach. */
async function makeEvidenceRich(trackId: string): Promise<void> {
  await db.execute({
    args: [trackId],
    sql: `update tracks
             set album_id = 'album-signal',
                 album = 'Signal Bloom',
                 release_date = '2026-04-02',
                 album_image_url = 'https://i.scdn.co/image/rich-cover',
                 apple_music_url = 'https://music.apple.com/us/album/x/1?i=2',
                 isrc = 'GBTEST2600001',
                 bpm = 174,
                 key = 'F minor'
           where track_id = ?`,
  });
}

beforeEach(async () => {
  db = await createIntegrationDb();

  await seedAlbum(db, { id: "album-signal", name: "Signal Bloom", slug: "signal-bloom" });

  await seedTrack(db, {
    addedAt: "2026-05-01T10:00:00.000Z",
    artists: ["Nova Kestrel"],
    logId: "701.1.0A",
    title: "Synthetic Aurora",
    trackId: CERTIFIED,
  });
  await makeEvidenceRich(CERTIFIED);

  await seedCatalogueTrack(db, {
    artists: ["Ashen Relay"],
    label: "Driftwave Audio",
    title: "Undertow Ledger",
    trackId: RICH,
  });
  await makeEvidenceRich(RICH);

  // THIN: a bare crawl row. It has a name and a Spotify anchor (seedCatalogueTrack mints one), and
  // nothing else — no record, no date, no cover. Exactly what most of the catalogue looks like.
  await seedCatalogueTrack(db, {
    artists: ["Quiet Cartel"],
    title: "Ferrite Bloom",
    trackId: THIN,
  });

  // SOURCELESS: a MusicBrainz-born row with no streaming presence at all. Nulling both Spotify
  // columns is what the crawler actually writes for one (they are nullable for this reason).
  await seedCatalogueTrack(db, {
    artists: ["Sable Lung"],
    title: "Paper Lantern Riot",
    trackId: SOURCELESS,
  });
  await db.execute({
    args: [SOURCELESS],
    sql: `update tracks set spotify_uri = null, spotify_url = null where track_id = ?`,
  });
});

describe("the certified track (shape 1)", () => {
  it("resolves to its coordinate, and never to a page of its own", async () => {
    const data = await resolveTrackPageData(CERTIFIED);

    expect(data).toStrictEqual({ logId: "701.1.0A", status: "redirect" });
  });

  it("is excluded from the tracks sitemap child, however much evidence it carries", async () => {
    // It is evidence-rich by every other term — the exclusion is `is_catalogue = 1`, and it is
    // there because a 301 must never be submitted for indexing. Its page is in `findings`.
    const bag = await collectSitemapBag("tracks");

    expect(bag.tracks.map((row) => row.trackId)).not.toContain(CERTIFIED);
  });
});

describe("the evidence-rich uncertified track (shape 2)", () => {
  it("serves a page carrying every fact the archive holds for it", async () => {
    const data = await resolveTrackPageData(RICH);

    expect(data.status).toBe("found");

    if (data.status !== "found") {
      return;
    }

    expect(data.track).toMatchObject({
      album: { name: "Signal Bloom", slug: "signal-bloom" },
      bpm: 174,
      isrc: "GBTEST2600001",
      key: "F minor",
      label: { name: "Driftwave Audio" },
      previewable: true,
      releaseDate: "2026-04-02",
      title: "Undertow Ledger",
      trackId: RICH,
    });
    expect(data.track.artists.map((artist) => artist.name)).toStrictEqual(["Ashen Relay"]);
    expect(data.track.albumImageUrl).toBeDefined();
  });

  it("offers both outbound destinations the archive stores, and no invented one", async () => {
    const data = await resolveTrackPageData(RICH);

    expect(data.status === "found" && data.track.listen).toStrictEqual([
      { href: `https://open.spotify.com/track/${RICH}`, kind: "spotify" },
      { href: "https://music.apple.com/us/album/x/1?i=2", kind: "apple" },
    ]);
  });

  it("is indexable, and the sitemap carries it — the same expression on both sides", async () => {
    const row = await readTrackDestination(RICH);
    const bag = await collectSitemapBag("tracks");

    expect(row.kind === "found" && row.track.indexable).toBe(true);
    expect(bag.tracks.map((entry) => entry.trackId)).toContain(RICH);
  });

  it("is counted by the sitemap INDEX exactly as often as the child lists it", async () => {
    // The index reads a `count(*)`; the child reads the rows. They are two reads of one
    // expression, and an archive where they disagree submits URLs that are not there.
    const [stats, bag] = await Promise.all([
      collectSitemapIndexStats(),
      collectSitemapBag("tracks"),
    ]);

    expect(stats.tracks.count).toBe(bag.tracks.length);
    // Honestly undated: `tracks` carries no content-change timestamp, so a track entry omits
    // `<lastmod>` rather than inventing one from a release date.
    expect(stats.tracks.lastmod).toBeUndefined();
  });
});

describe("the thin uncertified track (shape 3)", () => {
  it("still serves a page — reachable, navigable, and not a 404", async () => {
    const data = await resolveTrackPageData(THIN);

    expect(data.status).toBe("found");
    expect(data.status === "found" && data.track.title).toBe("Ferrite Bloom");
  });

  it("is NOT indexable and is NOT in the sitemap", async () => {
    const row = await readTrackDestination(THIN);
    const bag = await collectSitemapBag("tracks");

    expect(row.kind === "found" && row.track.indexable).toBe(false);
    expect(bag.tracks.map((entry) => entry.trackId)).not.toContain(THIN);
  });

  it("omits every fact it does not hold rather than rendering a blank", async () => {
    const data = await resolveTrackPageData(THIN);

    expect(data.status === "found" && data.track).toMatchObject({
      album: undefined,
      albumImageUrl: undefined,
      bpm: undefined,
      isrc: undefined,
      key: undefined,
      label: undefined,
      releaseDate: undefined,
    });
  });
});

describe("the track with no listening source (shape 4)", () => {
  it("serves a page that offers no outbound control at all", async () => {
    const data = await resolveTrackPageData(SOURCELESS);

    expect(data.status === "found" && data.track.listen).toStrictEqual([]);
  });

  it("offers no preview control either, since there is no short source to resolve one from", async () => {
    // No stored preview URL and no ISRC ⇒ the relay's every rung would come back empty, so the
    // page renders no control rather than one that fails on click.
    const data = await resolveTrackPageData(SOURCELESS);

    expect(data.status === "found" && data.track.previewable).toBe(false);
  });

  it("is not indexable, so a page with nowhere to send you is never submitted", async () => {
    const row = await readTrackDestination(SOURCELESS);

    expect(row.kind === "found" && row.track.indexable).toBe(false);
  });
});

describe("the track with no media (shape 5, the data half)", () => {
  it("carries no cover URL, so the page has nothing to preload and falls back to the mark", async () => {
    const data = await resolveTrackPageData(SOURCELESS);

    expect(data.status === "found" && data.track.albumImageUrl).toBeUndefined();
  });

  it("becomes previewable the moment an ISRC lands, without a stored preview URL", async () => {
    // The relay resolves a clip from the ISRC on demand (Deezer, then Apple), so the control is
    // offered on the anchor rather than on a stored URL that expires.
    await db.execute({
      args: [SOURCELESS],
      sql: `update tracks set isrc = 'GBTEST2600009' where track_id = ?`,
    });
    const data = await resolveTrackPageData(SOURCELESS);

    expect(data.status === "found" && data.track.previewable).toBe(true);
  });
});

describe("the operator stamps", () => {
  it("sends a stamped duplicate of a FINDING straight to the coordinate, in one hop", async () => {
    // The column's own rule: a duplicate stamp is written only when a catalogue row's ISRC matches
    // a FINDING's. Bouncing through `/track/<principal>` would 301 twice for one answer.
    await seedCatalogueTrack(db, {
      artists: ["Nova Kestrel"],
      title: "Synthetic Aurora",
      trackId: DUPLICATE,
    });
    await db.execute({
      args: [CERTIFIED, DUPLICATE],
      sql: `update tracks set duplicate_of_track_id = ? where track_id = ?`,
    });

    expect(await resolveTrackPageData(DUPLICATE)).toStrictEqual({
      logId: "701.1.0A",
      status: "redirect",
    });
  });

  it("sends a stamped duplicate to its principal, permanently", async () => {
    await seedCatalogueTrack(db, {
      artists: ["Ashen Relay"],
      title: "Undertow Ledger",
      trackId: DUPLICATE,
    });
    await db.execute({
      args: [RICH, DUPLICATE],
      sql: `update tracks set duplicate_of_track_id = ? where track_id = ?`,
    });

    expect(await resolveTrackPageData(DUPLICATE)).toStrictEqual({
      status: "redirect",
      trackId: RICH,
    });
  });

  it("keeps a stamped duplicate out of the sitemap", async () => {
    await seedCatalogueTrack(db, {
      artists: ["Ashen Relay"],
      title: "Undertow Ledger",
      trackId: DUPLICATE,
    });
    await makeEvidenceRich(DUPLICATE);
    await db.execute({
      args: [RICH, DUPLICATE],
      sql: `update tracks set duplicate_of_track_id = ? where track_id = ?`,
    });
    const bag = await collectSitemapBag("tracks");

    expect(bag.tracks.map((entry) => entry.trackId)).not.toContain(DUPLICATE);
  });

  it("404s a dismissed row rather than serving it", async () => {
    await db.execute({
      args: [THIN],
      sql: `update tracks set dismissed_at = '2026-05-02T00:00:00.000Z' where track_id = ?`,
    });

    expect(await resolveTrackPageData(THIN)).toStrictEqual({ status: "missing" });
  });

  it("404s an unknown id", async () => {
    expect(await resolveTrackPageData("no-such-track")).toStrictEqual({ status: "missing" });
  });
});

describe("the sitemap window", () => {
  it("pages in SQL, so a child past the end is empty rather than a repeat of page 1", async () => {
    const first = await collectSitemapBag("tracks", 1);
    const past = await collectSitemapBag("tracks", 2);

    expect(first.tracks.length).toBeGreaterThan(0);
    expect(past.tracks).toStrictEqual([]);
  });
});

/** A unit vector pointing along one axis — the further apart two axes, the further apart the sound. */
function axisVector(axis: number): number[] {
  return Array.from({ length: EMBEDDING_DIMS }, (_unused, index) => (index === axis ? 1 : 0));
}

describe("close in sound", () => {
  it("renders no band at all when the track carries no embedding", async () => {
    // The honest degrade, and it is the SAME answer an empty corpus and a dark sonar produce: the
    // page shows nothing rather than an empty band or an error.
    expect(await listSonicNeighbours(RICH)).toStrictEqual([]);
  });

  it("ranks BOTH registers against one another and excludes the target", async () => {
    // The whole point of scanning `tracks` through a LEFT join: a certified neighbour competes on
    // exactly the same terms as an uncertified one, and the register a row renders in is decided
    // by whether it carries a coordinate — never by the query.
    await seedEmbedding(db, RICH, axisVector(0));
    await seedEmbedding(db, CERTIFIED, axisVector(1));
    await seedEmbedding(db, THIN, axisVector(500));

    const neighbours = await listSonicNeighbours(RICH);

    expect(neighbours.map((neighbour) => neighbour.trackId)).toStrictEqual([CERTIFIED, THIN]);
    expect(neighbours[0]?.logId).toBe("701.1.0A");
    expect(neighbours[1]?.logId).toBeUndefined();
  });

  it("drops a dismissed or stamped-duplicate neighbour, so every row goes somewhere real", async () => {
    await seedEmbedding(db, RICH, axisVector(0));
    await seedEmbedding(db, CERTIFIED, axisVector(1));
    await seedEmbedding(db, THIN, axisVector(2));
    await db.execute({
      args: [THIN],
      sql: `update tracks set dismissed_at = '2026-05-02T00:00:00.000Z' where track_id = ?`,
    });

    expect((await listSonicNeighbours(RICH)).map((neighbour) => neighbour.trackId)).toStrictEqual([
      CERTIFIED,
    ]);
  });

  it("rides on the resolved page, so a reader can continue from one track to the next", async () => {
    await seedEmbedding(db, RICH, axisVector(0));
    await seedEmbedding(db, SOURCELESS, axisVector(3));

    const data = await resolveTrackPageData(RICH);

    expect(data.status === "found" && data.neighbours.map((n) => n.trackId)).toStrictEqual([
      SOURCELESS,
    ]);
  });
});

describe("the sentinels that are values, not nulls", () => {
  it("reports NO length for a row whose duration is the crawler's 0", async () => {
    // The crawler writes `recording.length ?? track.length ?? 0` and calls 0 "the honest
    // 'unknown'" (crawl.ts), so the DTO must hand back an absence rather than a zero the page and
    // the structured data would both render as a fact.
    await db.execute({
      args: [THIN],
      sql: `update tracks set duration_ms = 0 where track_id = ?`,
    });
    const data = await resolveTrackPageData(THIN);

    expect(data.status === "found" && data.track.durationMs).toBeUndefined();
  });

  it("reports NO isrc and NO recording mbid for the legacy empty string", async () => {
    // `schema.ts`'s `has_isrc` mirror trims before testing precisely because legacy rows carry
    // `''`. An untrimmed read prints a labelled field with no value and emits an identifier that
    // names nothing.
    await db.execute({
      args: [THIN],
      sql: `update tracks set isrc = '', mb_recording_id = '   ' where track_id = ?`,
    });
    const data = await resolveTrackPageData(THIN);

    expect(data.status === "found" && data.track.isrc).toBeUndefined();
    expect(data.status === "found" && data.track.mbRecordingId).toBeUndefined();
  });

  it("still reports a real length, isrc and mbid when the archive holds them", async () => {
    await db.execute({
      args: [RICH],
      sql: `update tracks set mb_recording_id = '11111111-2222-3333-4444-555555555555'
             where track_id = ?`,
    });
    const data = await resolveTrackPageData(RICH);

    expect(data.status === "found" && data.track.durationMs).toBe(270_000);
    expect(data.status === "found" && data.track.isrc).toBe("GBTEST2600001");
    expect(data.status === "found" && data.track.mbRecordingId).toBe(
      "11111111-2222-3333-4444-555555555555",
    );
  });
});

describe("the Beatport rail, over a real row", () => {
  it("renders the outbound control but keeps the URL out of the sameAs graph", async () => {
    await db.execute({
      args: [RICH],
      sql: `update tracks set beatport_url = 'https://www.beatport.com/track/undertow/9'
             where track_id = ?`,
    });
    const data = await resolveTrackPageData(RICH);

    expect(data.status).toBe("found");

    if (data.status !== "found") {
      return;
    }

    // Rendered: the control is there, pointing at the URL the archive stores.
    expect(data.track.listen).toContainEqual({
      href: "https://www.beatport.com/track/undertow/9",
      kind: "beatport",
    });

    // Asserted: it is not in the graph. Built exactly as the route's head() builds it.
    const sameAs = sameAsUrls(data.track.listen);

    expect(sameAs).not.toContain("https://www.beatport.com/track/undertow/9");
    expect(sameAs).toContain(`https://open.spotify.com/track/${RICH}`);
  });
});

/**
 * A vector a hair off axis 0 — STRICTLY nearer to `axisVector(0)` than any orthogonal axis is. It
 * is what lets a tempo test prove the window rather than accidentally pass on the `track_id`
 * tiebreak: two orthogonal candidates are equidistant, so the unfiltered scan would order them by
 * id and the assertion would hold whether or not the filter did anything.
 */
function nearVector(): number[] {
  return Array.from({ length: EMBEDDING_DIMS }, (_unused, index) =>
    index === 0 ? 1 : index === 3 ? 0.05 : 0,
  );
}

describe("the tempo pre-filter on close in sound", () => {
  it("excludes a NEARER neighbour that sits outside the target's tempo window", async () => {
    // The far row is deliberately the nearest by vector, so only the window can keep it out. RICH
    // and CERTIFIED are both 174 (makeEvidenceRich); the far row is put at half tempo.
    await db.execute({
      args: [SOURCELESS],
      sql: `update tracks set bpm = 87 where track_id = ?`,
    });
    await seedEmbedding(db, RICH, axisVector(0));
    await seedEmbedding(db, SOURCELESS, nearVector());
    await seedEmbedding(db, CERTIFIED, axisVector(2));

    expect(
      (await listSonicNeighbours(RICH, 1)).map((neighbour) => neighbour.trackId),
      "the in-window row wins even though the out-of-window one is nearer",
    ).toStrictEqual([CERTIFIED]);
  });

  it("widens to the unfiltered scan rather than returning a short band", async () => {
    // Nothing else sits in the window, so the windowed scan comes back short of the limit and the
    // wider answer is used — the band is never WORSE than it was before the pre-filter existed,
    // and the nearest row leads it.
    await db.execute({
      args: [SOURCELESS],
      sql: `update tracks set bpm = 87 where track_id = ?`,
    });
    await db.execute({
      args: [CERTIFIED],
      sql: `update tracks set bpm = 90 where track_id = ?`,
    });
    await seedEmbedding(db, RICH, axisVector(0));
    await seedEmbedding(db, SOURCELESS, nearVector());
    await seedEmbedding(db, CERTIFIED, axisVector(2));

    expect((await listSonicNeighbours(RICH)).map((neighbour) => neighbour.trackId)).toStrictEqual([
      SOURCELESS,
      CERTIFIED,
    ]);
  });

  it("scans unfiltered when the target has no measured tempo, exactly as before", async () => {
    await db.execute({
      args: [RICH],
      sql: `update tracks set bpm = null where track_id = ?`,
    });
    await db.execute({
      args: [SOURCELESS],
      sql: `update tracks set bpm = 87 where track_id = ?`,
    });
    await seedEmbedding(db, RICH, axisVector(0));
    await seedEmbedding(db, SOURCELESS, nearVector());

    expect((await listSonicNeighbours(RICH)).map((neighbour) => neighbour.trackId)).toStrictEqual([
      SOURCELESS,
    ]);
  });
});
