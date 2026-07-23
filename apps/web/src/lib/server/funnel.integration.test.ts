import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { type PublicUser } from "./public-auth";
import {
  createIntegrationDb,
  rowCount,
  seedAlbum,
  seedArtist,
  seedCatalogueTrack,
  seedLabel,
  seedTrack,
} from "./integration-db";

// THE CATALOGUE FUNNEL, PROVEN — against the REAL schema, on a real libSQL engine built from the
// generated migrations. Four claims are on trial:
//
//   1. THE SNAPSHOT IS IDEMPOTENT PER UTC DAY. Two calls the same day are ONE row; the second
//      OVERWRITES it with fresh counts. A re-fired daily tick never doubles a bar.
//   2. THE STAGE TOTALS ARE THE HONEST GATES. Each cumulative stage count matches a hand-inserted
//      fixture set, gate by gate (crawled → anchored → captured → analyzed → embedded → certified).
//   3. THE QUEUE DEPTHS ARE THE PRODUCT'S OWN — no drift. Each equals the exact number the sweep's
//      OWN count function (`countTrackWork` / `kindClause`) returns on the same DB; the anchor queue
//      is split by ISRC and the re-ask bench is the window's complement.
//   4. THE REC-ELIGIBILITY COUNT AGREES WITH `listRecommendations`. This is the load-bearing one:
//      both read the SAME extracted `REC_ELIGIBLE_WHERE`, so the funnel can never tell the operator
//      a different eligible-pool size than the recommendation engine actually scans.

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

const DIMS = 1024;

/** A unit vector along one axis — a controllable "artificial genre" (the rec test's discipline). */
function axis(index: number): number[] {
  const vector = Array.from<number>({ length: DIMS }).fill(0);
  vector[index] = 1;

  return vector;
}

/** The write the embed pipeline performs: validated JSON → ranked F32_BLOB. */
async function embed(trackId: string, vector: number[]): Promise<void> {
  await db.execute({
    args: [JSON.stringify(vector), trackId],
    sql: `update tracks set embedding_blob = vector32(?) where track_id = ?`,
  });
}

function publicUser(id: string, emailVerified = true): PublicUser {
  return {
    createdAt: new Date().toISOString(),
    email: `${id}@example.com`,
    emailVerified,
    id,
    name: id,
    username: id,
  };
}

/** Seed a `crawl_frontier` node in a given state — the frontier counts read these. */
async function seedFrontierNode(id: string, state: "done" | "pending"): Promise<void> {
  const now = new Date().toISOString();

  await db.execute({
    args: [id, "release", "musicbrainz", `ext-${id}`, 1, state, now, now],
    sql: `insert into crawl_frontier
      (id, kind, source, external_id, hop, state, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?)`,
  });
}

/** Patch arbitrary `tracks` columns on a seeded row — the gate-isolating helper. */
async function patchTrack(
  trackId: string,
  set: string,
  args: (number | string)[] = [],
): Promise<void> {
  await db.execute({
    args: [...args, trackId],
    sql: `update tracks set ${set} where track_id = ?`,
  });
}

/** Credit a seeded track to an artist — one `track_artists` edge (the artist-hub join reads it). */
async function linkArtist(trackId: string, artistId: string, position: number): Promise<void> {
  await db.execute({
    args: [artistId, position, trackId],
    sql: `insert into track_artists (artist_id, position, track_id) values (?, ?, ?)`,
  });
}

beforeEach(async () => {
  db = await createIntegrationDb();
});

// ── The idempotent daily upsert ──────────────────────────────────────────────

describe("recordCatalogueSnapshot (real SQL)", () => {
  it("upserts idempotently per UTC day: two same-day calls are ONE row, the second overwrites", async () => {
    const { recordCatalogueSnapshot } = await import("./funnel");

    await seedCatalogueTrack(db, { trackId: "cat-1" });
    await seedCatalogueTrack(db, { trackId: "cat-2" });

    const first = await recordCatalogueSnapshot({ day: "2026-07-18" });

    expect(first.day).toBe("2026-07-18");
    expect(first.crawled).toBe(2);
    expect(await rowCount(db, "catalogue_snapshots")).toBe(1);

    // A third catalogue row lands, then a SECOND snapshot the same day.
    await seedCatalogueTrack(db, { trackId: "cat-3" });
    const second = await recordCatalogueSnapshot({ day: "2026-07-18" });

    // Still one row — the day is the primary key — and it now carries the fresh count.
    expect(await rowCount(db, "catalogue_snapshots")).toBe(1);
    expect(second.crawled).toBe(3);

    const stored = await db.execute(
      "select crawled from catalogue_snapshots where day = '2026-07-18'",
    );

    expect(Number((stored.rows[0] as unknown as { crawled: number }).crawled)).toBe(3);
  });

  it("a DIFFERENT day is a new row (the series grows one row per day)", async () => {
    const { recordCatalogueSnapshot } = await import("./funnel");

    await seedCatalogueTrack(db, { trackId: "cat-1" });
    await recordCatalogueSnapshot({ day: "2026-07-17" });
    await recordCatalogueSnapshot({ day: "2026-07-18" });

    expect(await rowCount(db, "catalogue_snapshots")).toBe(2);
  });
});

// ── The stage totals, gate by gate ───────────────────────────────────────────

describe("computeCatalogueSnapshotCounts stages (real SQL)", () => {
  it("counts each stage against hand-inserted fixtures across every gate", async () => {
    const { computeCatalogueSnapshotCounts } = await import("./funnel");

    // Two certified findings (the right edge) — never counted as catalogue.
    await seedTrack(db, { logId: "001.1.1A", trackId: "find-1" });
    await seedTrack(db, { logId: "002.1.1A", trackId: "find-2" });

    // Catalogue rows, each isolating the gate under test. seedCatalogueTrack anchors by default
    // (it sets spotify_uri), duration 270_000 (short), no audio, no vector.
    await seedCatalogueTrack(db, { trackId: "cat-anchored" }); // anchored only
    await seedCatalogueTrack(db, { trackId: "cat-unanchored" });
    await patchTrack("cat-unanchored", "spotify_uri = null");
    await seedCatalogueTrack(db, { trackId: "cat-captured" });
    await patchTrack("cat-captured", "source_audio_key = 'k/a.webm'");
    await seedCatalogueTrack(db, { trackId: "cat-analyzed" });
    await patchTrack("cat-analyzed", "source_audio_key = 'k/b.webm', analyzed_from = 'full'");
    await seedCatalogueTrack(db, { trackId: "cat-embedded" });
    await patchTrack("cat-embedded", "source_audio_key = 'k/c.webm', analyzed_from = 'full'");
    await embed("cat-embedded", axis(0));

    const counts = await computeCatalogueSnapshotCounts();

    expect(counts.certified).toBe(2);
    expect(counts.crawled).toBe(5); // the five catalogue rows, findings excluded
    expect(counts.anchored).toBe(4); // all but cat-unanchored carry a spotify_uri
    expect(counts.captured).toBe(3); // cat-captured, cat-analyzed, cat-embedded
    expect(counts.analyzed).toBe(2); // analyzed_from = 'full': cat-analyzed, cat-embedded
    expect(counts.embedded).toBe(1); // only cat-embedded has a vector
    // recEligible: embedded + anchored + short + not dismissed/dup + nearest null → cat-embedded.
    expect(counts.recEligible).toBe(1);
  });

  it("recEligible excludes a dismissed / duplicate / long-form / near-dup embedded row", async () => {
    const { computeCatalogueSnapshotCounts } = await import("./funnel");

    // Five embedded, anchored catalogue rows; only the clean one is rec-eligible.
    for (const id of ["clean", "dismissed", "dup", "longform", "neardup"]) {
      await seedCatalogueTrack(db, { trackId: `e-${id}` });
      await embed(`e-${id}`, axis(0));
    }

    await patchTrack("e-dismissed", "dismissed_at = '2026-01-01T00:00:00.000Z'");
    await patchTrack("e-dup", "duplicate_of_track_id = 'x'");
    await patchTrack("e-longform", "duration_ms = 1200000"); // > LONG_FORM_MS (15m)
    await patchTrack("e-neardup", "nearest_finding_score = 0.999"); // ≥ DUPLICATE_SIMILARITY

    const counts = await computeCatalogueSnapshotCounts();

    expect(counts.embedded).toBe(5);
    expect(counts.recEligible).toBe(1); // only e-clean clears every gate
  });
});

// ── The queue depths — the product's own numbers ─────────────────────────────

describe("computeCatalogueSnapshotCounts queues (real SQL)", () => {
  it("each queue depth equals the sweep's OWN count function (no drift)", async () => {
    const { computeCatalogueSnapshotCounts } = await import("./funnel");
    const { countTrackWork } = await import("./track-work");
    const { setCatalogueCapturePaused } = await import("./capture-budget");

    // Open the capture budget so the catalogue capture queue is not trivially brake-zeroed.
    await setCatalogueCapturePaused(false);

    // A ranked capture candidate (no audio yet) — a real catalogue capture-queue entry.
    await seedCatalogueTrack(db, { trackId: "cap-ready" });
    await patchTrack("cap-ready", "capture_priority = 1");
    // A captured-but-unanalyzed/unembedded row — feeds the analyze + embed queues.
    await seedCatalogueTrack(db, { trackId: "measured" });
    await patchTrack("measured", "source_audio_key = 'k/m.webm'");
    // Two un-anchored rows — the anchor worklist.
    await seedCatalogueTrack(db, { trackId: "anc-noisrc" });
    await patchTrack("anc-noisrc", "spotify_uri = null");
    await seedCatalogueTrack(db, { trackId: "anc-isrc" });
    await patchTrack("anc-isrc", "spotify_uri = null, isrc = 'GB1234567890'");

    const counts = await computeCatalogueSnapshotCounts();

    // The four queue predicates are the sweeps' own — the funnel must report EXACTLY them.
    expect(counts.captureQueue).toBe(await countTrackWork({ kind: "capture", scope: "catalogue" }));
    expect(counts.analyzeQueue).toBe(await countTrackWork({ kind: "analyze", scope: "catalogue" }));
    expect(counts.embedQueue).toBe(await countTrackWork({ kind: "embed", scope: "catalogue" }));
    expect(counts.anchorQueueIsrc + counts.anchorQueueNoIsrc).toBe(
      await countTrackWork({ kind: "anchor", scope: "catalogue" }),
    );

    // And the anchor split is by ISRC, from the fixtures.
    expect(counts.anchorQueueIsrc).toBe(1);
    expect(counts.anchorQueueNoIsrc).toBe(1);
    expect(counts.captureQueue).toBe(1);
  });

  it("splits the anchor queue by embedding (ready vs awaiting audio), summing to the whole queue", async () => {
    const { getFunnel } = await import("./funnel");
    const { countTrackWork } = await import("./track-work");

    // Two un-anchored, otherwise-anchorable rows on opposite sides of the embedded line, plus one
    // already-anchored row that is in NEITHER (it is off the anchor worklist entirely).
    await seedCatalogueTrack(db, { trackId: "anc-ready" });
    await patchTrack("anc-ready", "spotify_uri = null");
    await embed("anc-ready", axis(0)); // embedded → the sweep's actionable head

    await seedCatalogueTrack(db, { trackId: "anc-awaiting" });
    await patchTrack("anc-awaiting", "spotify_uri = null"); // no vector → still awaiting audio

    await seedCatalogueTrack(db, { trackId: "already-anchored" }); // keeps its spotify_uri

    const { live } = await getFunnel();

    // The fixtures land one on each side of the embedded line.
    expect(live.queues.anchorQueueReady).toBe(1);
    expect(live.queues.anchorQueueAwaitingAudio).toBe(1);

    // THE PIN: the embedding split is a PARTITION of the exact same anchor worklist as the ISRC
    // split — both ride `kindClause("anchor")` — so it sums to the whole queue, which is itself the
    // sweep's own count. The two can never disagree.
    const whole = live.queues.anchorQueueIsrc + live.queues.anchorQueueNoIsrc;
    expect(live.queues.anchorQueueReady + live.queues.anchorQueueAwaitingAudio).toBe(whole);
    expect(whole).toBe(await countTrackWork({ kind: "anchor", scope: "catalogue" }));
  });

  it("benches a row attempted inside the re-ask window (anchorBackoff), and keeps a lapsed one in the queue", async () => {
    const { computeCatalogueSnapshotCounts } = await import("./funnel");
    const now = Date.now();
    const recent = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(); // 2 days ago — inside 14d
    const stale = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days ago — past 14d

    // Both un-anchored + otherwise anchorable; the attempt timestamp is the only difference.
    await seedCatalogueTrack(db, { trackId: "benched" });
    await patchTrack("benched", "spotify_uri = null, spotify_anchor_attempted_at = ?", [recent]);
    await seedCatalogueTrack(db, { trackId: "re-askable" });
    await patchTrack("re-askable", "spotify_uri = null, spotify_anchor_attempted_at = ?", [stale]);

    const counts = await computeCatalogueSnapshotCounts();

    expect(counts.anchorBackoff).toBe(1); // only the recently-attempted row sits on the bench
    // The lapsed row is back in the drainable anchor queue (no ISRC seeded).
    expect(counts.anchorQueueNoIsrc).toBe(1);
  });

  it("reads the crawl frontier's done + pending counts", async () => {
    const { computeCatalogueSnapshotCounts } = await import("./funnel");

    await seedFrontierNode("d1", "done");
    await seedFrontierNode("d2", "done");
    await seedFrontierNode("p1", "pending");

    const counts = await computeCatalogueSnapshotCounts();

    expect(counts.frontierDone).toBe(2);
    expect(counts.frontierPending).toBe(1);
  });
});

// ── The load-bearing agreement with the recommendation engine ────────────────

describe("the rec-eligibility count agrees with listRecommendations' scan (real SQL)", () => {
  it("recEligible equals the catalogue rows listRecommendations actually returns", async () => {
    const { computeCatalogueSnapshotCounts } = await import("./funnel");
    const { listRecommendations, saveRecSeed } = await import("./recommendations");
    const user = publicUser("user-A");

    // A certified finding, embedded, as the user's seed (so probes exist). It is a FINDING, so it
    // is outside the catalogue-eligible pool AND excluded from the scan by seedExclusion — its
    // presence cannot skew the equality either way.
    await seedTrack(db, { logId: "001.1.1A", trackId: "seed-finding" });
    await embed("seed-finding", axis(0));
    await saveRecSeed(user, { logId: "001.1.1A" });

    // Eligible catalogue rows — embedded, anchored, short, clean — with DISTINCT artists so the
    // diversity decay never drops one from a page far larger than the pool.
    for (let index = 0; index < 4; index += 1) {
      await seedCatalogueTrack(db, { artists: [`Artist ${index}`], trackId: `elig-${index}` });
      await embed(`elig-${index}`, axis(index + 1));
    }

    // Ineligible rows — one per gate — each excluded by the SHARED predicate, so both counters
    // must ignore them identically.
    await seedCatalogueTrack(db, { trackId: "no-vector" }); // no embedding
    await seedCatalogueTrack(db, { trackId: "unanchored" });
    await patchTrack("unanchored", "spotify_uri = null");
    await embed("unanchored", axis(20));
    await seedCatalogueTrack(db, { trackId: "dismissed" });
    await patchTrack("dismissed", "dismissed_at = '2026-01-01T00:00:00.000Z'");
    await embed("dismissed", axis(21));

    const counts = await computeCatalogueSnapshotCounts();
    const recs = await listRecommendations(user);

    expect(recs).not.toBeInstanceOf(Response);

    if (recs instanceof Response) {
      return;
    }

    // The funnel's eligible-pool size IS the number of catalogue rows the engine scans + returns.
    expect(counts.recEligible).toBe(4);
    expect(recs.catalogue).toHaveLength(counts.recEligible);
  });
});

// ── The read op: live + series ───────────────────────────────────────────────

describe("getFunnel (real SQL)", () => {
  it("returns the live pipeline + meters and the bounded series oldest-first", async () => {
    const { getFunnel, recordCatalogueSnapshot } = await import("./funnel");

    await seedCatalogueTrack(db, { trackId: "cat-1" });

    // Three snapshots on three days — the series is these, oldest-first.
    await recordCatalogueSnapshot({ day: "2026-07-16" });
    await recordCatalogueSnapshot({ day: "2026-07-17" });
    await recordCatalogueSnapshot({ day: "2026-07-18" });

    const view = await getFunnel();

    // The live block carries the three sections computed now.
    expect(view.live.stages.crawled).toBe(1);
    expect(view.live.queues).toHaveProperty("captureQueue");
    expect(view.live.meters.captureBudget).toHaveProperty("remainingTracks");
    expect(typeof view.live.meters.frontierPending).toBe("number");

    // The series is the ledger, oldest-first.
    expect(view.series.map((row) => row.day)).toEqual(["2026-07-16", "2026-07-17", "2026-07-18"]);
  });

  it("caps the series to the window and walks it ASC (last N days only)", async () => {
    const { getFunnel, recordCatalogueSnapshot } = await import("./funnel");

    const today = new Date();
    const day = (offsetDays: number) =>
      new Date(today.getTime() - offsetDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // One snapshot today, one 100 days ago (outside a 90-day window).
    await recordCatalogueSnapshot({ day: day(0) });
    await recordCatalogueSnapshot({ day: day(100) });

    const view = await getFunnel(90);

    // Only the in-window (recent) snapshot is returned.
    expect(view.series.map((row) => row.day)).toEqual([day(0)]);
  });

  it("computes the live block on EVERY call — a count change shows without a new snapshot", async () => {
    const { getFunnel, recordCatalogueSnapshot } = await import("./funnel");

    // One catalogue row, and ONE snapshot recording the count at that moment (crawled = 1).
    await seedCatalogueTrack(db, { trackId: "cat-1" });
    await recordCatalogueSnapshot({ day: "2026-07-18" });

    const first = await getFunnel();
    expect(first.live.stages.crawled).toBe(1);

    // A second catalogue row lands, but NO new snapshot is written. A snapshot-backed read would
    // still report 1; a live read sees 2.
    await seedCatalogueTrack(db, { trackId: "cat-2" });

    const second = await getFunnel();
    expect(second.live.stages.crawled).toBe(2);

    // The SERIES still comes from the `catalogue_snapshots` ledger — it holds only the one recorded
    // day, and its stored count is the snapshot's (1), untouched by the live block moving to 2.
    expect(second.series.map((row) => row.day)).toEqual(["2026-07-18"]);
    expect(second.series[0]?.crawled).toBe(1);
  });
});

// ── The public-surfaces card — live on the public web, through the surface's own predicate ────
// The load-bearing claim: each figure is read through the SAME predicate its public surface obeys,
// so the card can never disagree with what a visitor or a crawler actually sees. `tracks` is the
// `/tracks` hub's own count; the three entity figures are the sitemap's INDEXABLE sets.

describe("getFunnel publicSurfaces (real SQL)", () => {
  it("publicSurfaces.tracks equals the /tracks hub's own count (findings + catalogue)", async () => {
    const { getFunnel } = await import("./funnel");
    const { tracksHubCountQuery } = await import("./tracks-hub");

    await seedTrack(db, { logId: "001.1.1A", trackId: "find-1" });
    await seedTrack(db, { logId: "002.1.1A", trackId: "find-2" });
    await seedCatalogueTrack(db, { trackId: "cat-1" });
    await seedCatalogueTrack(db, { trackId: "cat-2" });
    await seedCatalogueTrack(db, { trackId: "cat-3" });

    const { live } = await getFunnel();

    // Every publicly-rendered row: two findings + three catalogue rows.
    expect(live.publicSurfaces.tracks).toBe(5);

    // And it IS the hub's own count query (`{}` = no filter, the exact SQL the /tracks masthead
    // pages by) — the two can never disagree.
    const hubCount = await db.execute(tracksHubCountQuery({}));
    expect(live.publicSurfaces.tracks).toBe(
      Number((hubCount.rows[0] as unknown as { total: number }).total),
    );
  });

  it("counts the INDEXABLE artists/albums/labels (renderable ≥ 3) and agrees with the sitemap rows", async () => {
    const { getFunnel } = await import("./funnel");
    const { ARTIST_INDEX_MIN_FINDINGS, listArtistSitemapRows } = await import("./artists");
    const { ALBUM_INDEX_MIN_TRACKS, listAlbumSitemapRows } = await import("./albums");
    const { LABEL_INDEX_MIN_TRACKS, listLabelSitemapRows } = await import("./labels");

    // One entity of each kind that CLEARS the thin-content floor (3 renderable catalogue tracks),
    // and one that falls short (2) — so the indexable count is exactly 1 per kind.
    await seedArtist(db, { id: "art-in", slug: "art-in" });
    await seedArtist(db, { id: "art-out", slug: "art-out" });
    await seedAlbum(db, { id: "alb-in", slug: "alb-in" });
    await seedAlbum(db, { id: "alb-out", slug: "alb-out" });
    await seedLabel(db, { id: "lab-in", slug: "lab-in" });
    await seedLabel(db, { id: "lab-out", slug: "lab-out" });

    // Three tracks on the IN entities…
    for (let index = 0; index < 3; index += 1) {
      const id = `t-in-${index}`;
      await seedCatalogueTrack(db, { trackId: id });
      await linkArtist(id, "art-in", index);
      await patchTrack(id, "album_id = 'alb-in', label_id = 'lab-in'");
    }
    // …and only two on the OUT entities (below the floor of 3).
    for (let index = 0; index < 2; index += 1) {
      const id = `t-out-${index}`;
      await seedCatalogueTrack(db, { trackId: id });
      await linkArtist(id, "art-out", index);
      await patchTrack(id, "album_id = 'alb-out', label_id = 'lab-out'");
    }

    const { live } = await getFunnel();

    expect(live.publicSurfaces.artists).toBe(1);
    expect(live.publicSurfaces.albums).toBe(1);
    expect(live.publicSurfaces.labels).toBe(1);

    // THE PIN: each count IS the exact set of rows its sitemap enumerates (`renderable >= floor`) —
    // same scan, same floor — so the card can never drift from what search engines can index.
    expect(live.publicSurfaces.artists).toBe(
      (await listArtistSitemapRows(ARTIST_INDEX_MIN_FINDINGS)).length,
    );
    expect(live.publicSurfaces.albums).toBe(
      (await listAlbumSitemapRows(ALBUM_INDEX_MIN_TRACKS)).length,
    );
    expect(live.publicSurfaces.labels).toBe(
      (await listLabelSitemapRows(LABEL_INDEX_MIN_TRACKS)).length,
    );
  });
});
